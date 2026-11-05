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
    grid = layers.grid_key(meta)
    osm = {"source": build_cache.identity(source) if source else None,
           "parent_source": build_cache.identity(parent[0]) if parent else None,
           "osmium": build_cache.osmium_identity() if source else None}
    keys = {}
    for name in wanted:
        if name == "parking":
            extra = {"parking": build_cache.identity(OUT / f"{area}_parking.json")}
        else:
            extra = {**osm, "settings": {k: v for k, v in settings.items() if k != "road_tolerance" or name == "ground"}}
        if name in ("ground", "streets"):
            extra["dtm"] = [build_cache.identity(p) for p in sorted(dtm.PACKAGES.glob("*.zip"))]
        if name == "ground":
            extra["dtm_lines"] = [build_cache.identity(p) for p in sorted(dtm_walls.LINES.glob("*.zip"))]
            extra["trees"] = build_cache.identity(ipr_trees.CACHE)
            # Worn paths use both the image and its coordinate metadata.
            extra["footfall"] = [build_cache.identity(OUT / f"{area}_now" / f"footfall.{ext}")
                                 for ext in ("png", "json")]
        keys[name] = build_cache.key([grid, build_cache.processing(name), extra])
    return keys


def record_path(area, ci, cj):
    return layers.folder(area) / "completed" / f"{ci}_{cj}.json"


def remaining(area, meta, ci, cj, wanted, keys):
    record = build_cache.read_json(record_path(area, ci, cj))
    if record.get("grid") != layers.grid_key(meta) or not isinstance(record.get("layers"), dict):
        return set(wanted)
    todo = set(wanted)
    for name in wanted:
        # Strict assembly can validate Overpass output, but it has no local source
        # identity to compare when deciding whether to skip a fresh build.
        if name != "parking" and not meta.get("build_source"):
            continue
        got = record["layers"].get(name, {})
        if not isinstance(got, dict) or got.get("input") != keys[name]:
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
            if (not isinstance(got, dict) or got.get("input") != keys[name] or not got.get("hash") or not path.exists()
                    or build_cache.digest(path.read_bytes()) != got["hash"]):
                raise SystemExit(f"{area}: {name} chunk {ci},{cj} is incomplete or changed; rebuild it")
