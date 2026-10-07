"""Validated, per-layer chunk completion records for opt-in map build resume."""

import build_cache
import dtm
import dtm_walls
import ipr_trees
import layers
from osm_area import OUT


def inputs(area, meta, wanted, source, settings):
    cut = build_cache.read_json(f"{source}.source.json") if source else {}
    parent = cut.get("input", {}).get("source")
    common = {"grid": layers.grid_key(meta), "code": build_cache.code_key(),
              "runtime": build_cache.runtime_key(), "source": build_cache.identity(source) if source else None,
              "parent_source": build_cache.identity(parent[0]) if parent else None,
              "settings": settings}
    survey = [build_cache.identity(p) for p in sorted(dtm.PACKAGES.glob("*.zip"))]
    keys = {}
    for name in wanted:
        base = common if name != "parking" else {**common, "source": None, "parent_source": None}
        extra = {}
        if name in ("ground", "streets"):
            extra["dtm"] = survey
        if name == "ground":
            extra["dtm_lines"] = [build_cache.identity(p) for p in sorted(dtm_walls.LINES.glob("*.zip"))]
            extra["trees"] = build_cache.identity(ipr_trees.CACHE)
            # The worn paths follow the footfall map where the area has one (worn_paths.py).
            footfall = OUT / f"{area}_now" / "footfall.png"
            extra["footfall"] = build_cache.identity(footfall) if footfall.exists() else None
        if name == "parking":
            extra["parking"] = build_cache.identity(OUT / f"{area}_parking.json")
        # Overpass data can change without a local input identity. Never resume it.
        keys[name] = build_cache.key([base, extra]) if source or name == "parking" else None
    return keys


def record_path(area, ci, cj):
    return layers.folder(area) / "completed" / f"{ci}_{cj}.json"


def remaining(area, meta, ci, cj, wanted, keys):
    record = build_cache.read_json(record_path(area, ci, cj))
    if record.get("grid") != layers.grid_key(meta) or not isinstance(record.get("layers"), dict):
        return set(wanted)
    todo = set(wanted)
    for name in wanted:
        got = record.get("layers", {}).get(name, {})
        if keys[name] is None or got.get("input") != keys[name]:
            continue
        try:
            raw = layers.chunk_path(area, name, ci, cj).read_bytes()
        except OSError:
            continue
        if build_cache.digest(raw) == got.get("hash"):
            todo.remove(name)
    return todo


def begin(area, meta, ci, cj, wanted):
    """Invalidate before work: an interrupted chunk must not retain an old success."""
    path = record_path(area, ci, cj)
    record = build_cache.read_json(path)
    if record.get("grid") != layers.grid_key(meta) or not isinstance(record.get("layers"), dict):
        record = {"grid": layers.grid_key(meta), "layers": {}}
    for name in wanted:
        record["layers"].pop(name, None)
    build_cache.write_json(path, record)
    return record


def complete(area, ci, cj, record, outputs, keys):
    # The single commit is after every requested layer has been atomically written.
    for name, raw in outputs.items():
        record["layers"][name] = {"input": keys[name], "hash": build_cache.digest(raw.encode())}
    build_cache.write_json(record_path(area, ci, cj), record)


def check_complete(area, meta):
    """Strict assembly rejects interrupted, mixed-grid and damaged chunk outputs."""
    if "build_settings" not in meta:
        raise SystemExit(f"{area}: no build input manifest; rebuild all layers")
    keys = inputs(area, meta, layers.CHUNKED, meta.get("build_source"), meta["build_settings"])
    for ci, cj in layers.chunks(meta):
        record = build_cache.read_json(record_path(area, ci, cj))
        if record.get("grid") != layers.grid_key(meta) or not isinstance(record.get("layers"), dict):
            raise SystemExit(f"{area}: chunk {ci},{cj} has no completion record for this grid; rebuild all layers")
        for name in layers.CHUNKED:
            got = record.get("layers", {}).get(name, {})
            path = layers.chunk_path(area, name, ci, cj)
            if (got.get("input") != keys[name] or not got.get("hash") or not path.exists()
                    or build_cache.digest(path.read_bytes()) != got["hash"]):
                raise SystemExit(f"{area}: {name} chunk {ci},{cj} is incomplete or changed; rebuild it")
