"""Small, atomic cache records for map builds; large sources are identified by stat.

read_when: changing map cache keys, chunk resume, or source-level IPR parsing.
"""

import hashlib
import importlib.metadata
import inspect
import json
import os
import pickle
import platform
import resource
import sys
import time
from concurrent.futures import ProcessPoolExecutor
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


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def key(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def code_key():
    """Conservative invalidation for processing changes, without manual version bumps."""
    root = Path(__file__).parent
    # (ground_cover.py works on finished tiles and keeps its own key, layers.cover_processing.)
    return key({p.name: digest(p.read_bytes()) for p in sorted(root.glob("*.py"))
                if not p.name.startswith("test_") and p.name != "ground_cover.py"})


def function_key(function):
    return digest(inspect.getsource(function).encode())


def runtime_key():
    return [platform.python_version(),
            {name: importlib.metadata.version(name)
             for name in ("osmnx", "shapely", "numpy", "pyproj", "lxml", "scipy")}]


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
    """Keep deterministic sheet ordering and close the worker pool after consumption."""
    if workers == 1 or len(jobs) <= 1:
        yield from map(function, jobs)
    else:
        with ProcessPoolExecutor(workers) as pool:
            yield from pool.map(function, jobs)


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
