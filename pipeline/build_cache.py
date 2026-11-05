"""Small, atomic cache records for map builds; large sources are identified by stat.

read_when: changing map cache keys, chunk resume, or source-level IPR parsing.
"""

import ast
import hashlib
import importlib.metadata
import inspect
import json
import os
import pickle
import platform
import resource
import shutil
import sys
import time
from collections import deque
from concurrent.futures import ProcessPoolExecutor
from itertools import islice
from pathlib import Path


def identity(path):
    """Detect replacements, including same-size edits with a preserved mtime.

    A copied source conservatively misses: these are local file identities, not
    portable content hashes. Hashing a country extract on every run is avoided.
    """
    path = Path(path)
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return [str(path.resolve()), st.st_size, st.st_mtime_ns, st.st_ctime_ns]


def osmium_identity():
    executable = shutil.which("osmium")
    return identity(executable) if executable else None


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def key(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


# Processing dependencies, including helpers called through other modules or imported
# inside functions. Keep whole shared producers where their work is interleaved
# (build_tiles and osm_area); use named roots for helpers in mixed-purpose modules.
PIPELINE = Path(__file__).resolve().parent
OSM = {"build_tiles.py": (), "osm_area.py": (), "roofs.py": (), "sports.py": (),
       "layers.py": ("FORMAT", "chunk_tiles", "tile_box", "dumps", "write", "chunk_path")}
SURVEY = {"dtm.py": (), "kerbs.py": (), "lanes.py": (), "worn_paths.py": ()}
IPR_OUTPUT = {"layers.py": ("FORMAT", "tiles", "write_layer", "begin_layer", "write_bin", "remove_bin")}
PROJECTION = ("krovak_to_local",)
CODE = {
    "buildings": OSM,
    "ground": {**OSM, **SURVEY, "dtm_walls.py": (), "ipr_trees.py": (), "ipr_open.py": (),
               "barriers.py": (), "pavements.py": (), "plots.py": (), "verges.py": ()},
    "streets": {**OSM, **SURVEY, "structures.py": ("structure_ways",)},
    "parking": {"build_tiles.py": (), "osm_area.py": ("OUT", "AREAS", "_polys", "_rings"),
                "layers.py": OSM["layers.py"]},
    "ipr_sheet": {"ipr_buildings.py": ("read_sheet", *PROJECTION)},
    "terrain_sheet": {"ipr_terrain.py": ("read_sheet",), "ipr_buildings.py": PROJECTION},
    "ipr": {**IPR_OUTPUT, "ipr_buildings.py": (), "osm_area.py": ("AREAS", "OUT"),
            "building_age.py": (), "roofs.py": (), "roof_details.py": (), "mesh_colours.py": ("lab",)},
    "terrain": {**IPR_OUTPUT, "ipr_terrain.py": (),
                "ipr_buildings.py": (*PROJECTION, "sheet_names", "search", "CACHE"),
                "osm_area.py": ("AREAS", "OUT", "_polys", "_rings"),
                "dtm_heights.py": (), "dtm.py": ("CACHE", "PACKAGES", "_wkb"),
                "structures.py": ("build", "pads"), "dmr5g.py": (), "ipr_lidar.py": (),
                "terrain_keep.json": (), "terrain_walls.json": ()},
}
OSM_RUNTIME = ("osmnx", "geopandas", "pandas", "networkx", "requests", "scipy")
GEOMETRY = ("numpy", "shapely", "pyproj")
PACKAGES = {
    "buildings": (*GEOMETRY, *OSM_RUNTIME),
    "ground": (*GEOMETRY, *OSM_RUNTIME, "pillow"),
    "streets": (*GEOMETRY, *OSM_RUNTIME),
    "parking": GEOMETRY,
    "ipr_sheet": (*GEOMETRY, "lxml"),
    "terrain_sheet": (*GEOMETRY, "lxml"),
    "ipr": (*GEOMETRY, "lxml", "requests"),
    "terrain": (*GEOMETRY, "lxml", "geopandas", "pyogrio", "fiona", "pandas", "scipy", "requests", "tifffile"),
}


def processing(layer):
    files = {**CODE[layer], "build_cache.py": ("identity", "key", "atomic", "load_pickle",
                                               "source_data", "source_records", "parallel_map")}
    if layer in ("buildings", "ground", "streets", "parking"):
        files["chunk_cache.py"] = ()
    code = {name: reach_key(PIPELINE / name, roots, imports=True) if roots else digest((PIPELINE / name).read_bytes())
            for name, roots in files.items()}
    return [key(code), runtime_key(PACKAGES[layer])]


def function_key(function):
    return digest(inspect.getsource(function).encode())


def reach_key(path, roots, *, imports=False):
    """A key of the functions `roots` in the file at `path` and of everything in that file
    they lead to (the functions they call and the constants they read, and so on down):
    a change to anything else in the file leaves it as it was. Read from the source, so
    the file's own imports aren't needed."""
    source = Path(path).read_text()
    defined = {}
    for node in ast.parse(source).body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            names = [node.name]
        elif isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)]
        elif imports and isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [alias.asname or alias.name.split(".")[0] for alias in node.names]
        else:
            continue
        for name in names:
            defined.setdefault(name, []).append(node)
    reached, todo = {}, list(roots)
    while todo:
        name = todo.pop()
        if name in reached:
            continue
        if name not in defined:
            raise KeyError(f"{path}: no {name}")
        reached[name] = [ast.get_source_segment(source, node) for node in defined[name]]
        todo += {n.id for node in defined[name] for n in ast.walk(node)
                 if isinstance(n, ast.Name) and n.id in defined}
    return key(dict(sorted(reached.items())))


def runtime_key(packages=("osmnx", "shapely", "numpy", "pyproj", "lxml", "scipy")):
    versions = {}
    for name in packages:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None  # optional readers such as Fiona or tifffile
    return [platform.python_version(), versions]


def read_json(path):
    try:
        got = json.loads(Path(path).read_text())
        return got if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


def write_json(path, value):
    atomic(path, json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def atomic(path, raw):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(raw)
    tmp.replace(path)


def load_pickle(path, expected):
    try:
        with open(path, "rb") as f:
            got = pickle.load(f)
        if isinstance(got, dict) and got.get("key") == expected:
            return got
    except (OSError, ValueError, EOFError, pickle.UnpicklingError):
        pass
    return None


def source_data(path, cache, version, loader, stats=None):
    """Cache XML parsing in source coordinates, reusable across local projections."""
    expected = [version, identity(path)]
    got = load_pickle(cache, expected)
    if stats is not None:
        stats["source_cache"] = "hit" if got else "miss"
    if got:
        return got["data"]
    data = loader(path)
    if identity(path) != expected[1]:
        raise RuntimeError(f"source changed while parsing: {path}")
    atomic(cache, pickle.dumps({"key": expected, "data": data}, protocol=5))
    return data


def source_records(path, cache, version, loader, stats=None):
    """Stream large building sheets without keeping raw rings and packed mesh together."""
    expected = [version, identity(path)]
    cache = Path(cache)
    if cache.exists():
        try:
            with open(cache, "rb") as f:
                valid = pickle.load(f) == expected
        except (OSError, EOFError, ValueError, pickle.UnpicklingError):
            valid = False
        if valid:
            if stats is not None:
                stats["source_cache"] = "hit"
            with open(cache, "rb") as f:
                pickle.load(f)
                while (record := pickle.load(f)) is not None:
                    yield record
            return
    if stats is not None:
        stats["source_cache"] = "miss"
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_name(f"{cache.name}.{os.getpid()}.tmp")
    with open(tmp, "wb") as f:
        pickle.dump(expected, f, protocol=5)
        for record in loader(path):
            pickle.dump(record, f, protocol=5)
            yield record
        pickle.dump(None, f, protocol=5)
    if identity(path) != expected[1]:
        raise RuntimeError(f"source changed while parsing: {path}")
    tmp.replace(cache)


def sources(paths):
    return {str(Path(p).resolve()): identity(p) for p in paths}


def sources_current(manifest):
    return all(identity(path) == expected for path, expected in manifest.items())


def parallel_map(function, jobs, workers):
    """Yield sheets in order, with at most twice the workers' results waiting."""
    if workers == 1 or len(jobs) <= 1:
        yield from map(function, jobs)
    else:
        with ProcessPoolExecutor(workers) as pool:
            pending = deque()
            jobs = iter(jobs)
            try:
                for job in islice(jobs, 2 * workers):
                    pending.append(pool.submit(function, job))
                while pending:
                    # Drop the consumed future before handing its result to the caller.
                    yield pending.popleft().result()
                    # Refill only when the caller asks for another sheet.
                    for job in islice(jobs, 1):
                        pending.append(pool.submit(function, job))
            finally:
                for future in pending:
                    future.cancel()


def peak_mb():
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value / (1024 ** 2 if sys.platform == "darwin" else 1024)


class Timings:
    """Non-overlapping laps; counters are reported separately from durations."""

    def __init__(self, out=None):
        self.out = out if out is not None else {}
        self.last = time.perf_counter()

    def lap(self, name):
        now = time.perf_counter()
        self.out[name] = now - self.last
        self.last = now


def report_times(label, times):
    print(f"{label}: " + ", ".join(f"{name} {seconds:.2f} s" for name, seconds in times.items()), flush=True)


def _span(seconds):
    minutes = round(seconds / 60)
    if seconds < 90:
        return "under 2 min"
    if minutes < 60:
        return f"about {minutes} min"
    return f"about {minutes // 60} h {minutes % 60:02d} min"


class Eta:
    """How long the rest of a run will take, for its progress lines: `eta(done)` after each
    item gives ", about 12 min left (done around 14:05)", or "" while it's too early to say.
    Items finish at uneven rates (a dense city chunk takes minutes, a field seconds, and a
    pool hands back several at once), so the rate is the average of the whole run so far
    and of the latest stretch (the last tenth of the items, at least 20): the first keeps
    one slow item from swinging it, the second follows a run that speeds up or slows down."""

    def __init__(self, total):
        self.total, self.started, self.seen = total, time.monotonic(), []

    def __call__(self, done):
        now = time.monotonic()
        self.seen.append((done, now))
        elapsed, left = now - self.started, self.total - done
        if done < 3 or elapsed < 10 or left <= 0:
            return ""
        rate = done / elapsed
        window = max(20, self.total // 10)
        recent = [p for p in self.seen if p[0] >= done - window]
        if len(recent) >= 10 and now > recent[0][1]:
            rate = (rate + (done - recent[0][0]) / (now - recent[0][1])) / 2
        self.seen = self.seen[-window - 1:]
        seconds = left / rate
        finish = time.strftime("%H:%M", time.localtime(time.time() + seconds))
        return f", {_span(seconds)} left (done around {finish})"
