"""The map of an area is built in layers, each by its own step, and put together into
the tiles the game reads only at the end, so changing how one thing is drawn
rebuilds that layer alone:

    buildings  OSM buildings                       build_tiles.py --layers buildings
    ground     land use, streets and pavements     build_tiles.py --layers ground
               (kerbs, gardens), parking areas,
               walls, fences, rails, crossings, trees
    streets    the car and footpath networks       build_tiles.py --layers streets
    parking    paid-parking sections               build_tiles.py --layers parking
    ipr        IPR's 3D buildings                  ipr_buildings.py
    terrain    IPR's terrain, bridges, tunnels     ipr_terrain.py
    cover      what the ground nothing maps is    ground_cover.py build
               made of, from IPR's aerial photos
    young      where a mapped wood has only a     young_woods.py build
               low canopy, from IPR's surface model

The first four are kept per chunk in pipeline/.cache/layers/<area>/<layer>/<ci>_<cj>.json
(tile key → what the layer has there, plus what the chunk adds to the whole area,
such as tram rails and street names); ipr and terrain write their .bin files straight
into the tiles and keep the rest in <layer>.json. Every step ends with assemble(),
which writes tiles/<i>_<j>.json, index.json, names.json and leaving.json in public/data/<area>_now/
from the layers, and leaves files whose content hasn't changed alone (so a deploy only
sends what did). Files of tiles no longer in the index are removed.

What depends on what: ipr uses the OSM buildings (colours, and which OSM buildings
IPR doesn't have); terrain works out the bridges and tunnels from the ground and
streets layers; cover looks at the ground the buildings and ground layers leave bare,
with the terrain heights. build_tiles.py says which of the first two to run again; cover
is optional (a map without it keeps its plain beige) and checks itself per tile: a
tile whose ground or heights changed since is left without cover until it is run again.
young is optional in the same way and looks at the wood outlines of the ground layer
with the terrain heights.
"""

import gzip
import json
import os
import re
import subprocess
import time
from pathlib import Path

from osm_area import OUT
import build_cache

CACHE = Path(__file__).parent / ".cache" / "layers"
# The format of the files the game reads. Raise it, together with DATA_FORMAT in
# src/data.ts, whenever a change here means the game's older code can't read the new
# files (or its newer code the old ones). The game refuses a map with another number.
FORMAT = 2
CHUNKED = ("buildings", "ground", "streets", "parking")
# What a tile has when a layer has nothing there, in the order the tile JSON lists it.
EMPTY = {
    "buildings": {"buildings": []},
    "ground": {"areas": {}, "lots": [], "roads": {}, "walls": [], "fences": [], "rails": [], "passages": [], "weirs": [], "crossings": [], "marks": [], "trees": [], "drives": [], "plots": [], "patches": {}, "sheds": []},
    "streets": {"drive": [], "walk": []},
    "parking": {"sections": []},
}
ORDER = ["areas", "lots", "roads", "buildings", "walls", "fences", "rails", "passages", "weirs", "crossings", "marks", "trees", "drives", "plots", "patches", "sheds", "drive", "walk", "sections"]


def gzip_bytes(raw: bytes) -> bytes:
    """Gzipped the same way every time (no timestamp), so unchanged files stay unchanged."""
    return gzip.compress(raw, compresslevel=9, mtime=0)


def write_bin(tiles_dir: Path, name: str, raw: bytes, manifest=None) -> bool:
    """A tile's binary file, gzipped (<name>.gz; the game unpacks it), in place of an
    uncompressed one from before."""
    (tiles_dir / name).unlink(missing_ok=True)
    blob = gzip_bytes(raw)
    changed = write(tiles_dir / f"{name}.gz", blob)
    if manifest is not None:
        manifest[f"{name}.gz"] = [len(blob), build_cache.digest(blob)]
    return changed


def remove_bin(tiles_dir: Path, name: str):
    for p in (tiles_dir / name, tiles_dir / f"{name}.gz"):
        p.unlink(missing_ok=True)


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write(path: Path, data) -> bool:
    """Write text or bytes to path unless it already holds exactly that; True if written."""
    raw = data.encode() if isinstance(data, str) else data
    try:
        if path.stat().st_size == len(raw) and path.read_bytes() == raw:
            return False
    except FileNotFoundError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_bytes(raw)
    tmp.replace(path)
    return True


def folder(area: str) -> Path:
    return CACHE / area


def read_meta(area: str) -> dict | None:
    p = folder(area) / "meta.json"
    return json.loads(p.read_text()) if p.exists() else None


def write_meta(area: str, meta: dict):
    write(folder(area) / "meta.json", json.dumps(meta, indent=1))


def chunk_path(area: str, layer: str, ci: int, cj: int) -> Path:
    return folder(area) / layer / f"{ci}_{cj}.json"


def read_chunk(area: str, layer: str, ci: int, cj: int) -> dict:
    p = chunk_path(area, layer, ci, cj)
    if not p.exists():
        raise SystemExit(f"{area}: the {layer} layer of chunk {ci},{cj} hasn't been built; run build_tiles.py {area} first")
    return json.loads(p.read_text())


def read_layer(area: str, layer: str) -> dict | None:
    """ipr or terrain: None if that step hasn't been run for the area."""
    p = folder(area) / f"{layer}.json"
    return json.loads(p.read_text()) if p.exists() else None


def grid_key(meta):
    return json.loads(json.dumps({k: meta[k] for k in ("area", "bbox_wgs84", "centre", "crs", "box", "origin",
                                                     "tile", "chunk_tiles", "cols", "rows")}))


def dependency_snapshot(area, names, meta=None):
    meta = meta if meta is not None else read_meta(area)
    return {"grid": grid_key(meta), "chunks": {
        f"{name}/{ci}_{cj}": build_cache.identity(chunk_path(area, name, ci, cj))
        for name in names for ci, cj in chunks(meta)}}


# Both stages use tiles(), whose coverage is determined by buildings, ground and walk edges.
DEPENDENCIES = {name: ("buildings", "ground", "streets") for name in ("ipr", "terrain")}


def stage_sources(area, layer, options):
    # Source inventories are read locally, including newly added files and absent
    # optional inputs. Strict assembly uses the options recorded by the producer.
    if layer == "ipr":
        from ipr_buildings import source_paths
    else:
        from ipr_terrain import source_paths
    return build_cache.sources(source_paths(area, options))


def stage_inputs(area, layer, options, meta=None):
    return {"options": options, "dependencies": dependency_snapshot(area, DEPENDENCIES[layer], meta),
            "processing": build_cache.processing(layer), "sources": stage_sources(area, layer, options)}


def stage_current(area, layer, data, inputs):
    return (data and data.get("gzip") is True and data.get("tile") == inputs["dependencies"]["grid"]["tile"]
            and isinstance(data.get("made_for"), list) and isinstance(data.get("tiles"), dict)
            and isinstance(data.get("payloads"), dict)
            and all(data.get(k) == value for k, value in inputs.items()) and layer_complete(area, layer))


def stage_payload_error(area, layer, data):
    """Return a missing or damaged binary's name, or None for a complete payload."""
    needed = {f"{k}.ipr.bin.gz" for k in data["tiles"]} if layer == "ipr" else {
        *(f"{k}.height.bin.gz" for k in data["made_for"]), *(f"{k}.levels.bin.gz" for k in data["tiles"])}
    payloads = data.get("payloads", {})
    tiles_dir = OUT / f"{area}_now" / "tiles"
    if missing := needed.symmetric_difference(payloads):
        return min(missing)
    for filename in sorted(needed):
        try:
            raw = (tiles_dir / filename).read_bytes()
        except OSError:
            return filename
        if payloads[filename] != [len(raw), build_cache.digest(raw)]:
            return filename
    return None


def resume_stage(area, layer, inputs, no_assemble):
    data = build_cache.read_json(folder(area) / f"{layer}.json")
    if not stage_current(area, layer, data, inputs) or stage_payload_error(area, layer, data):
        return False
    if inputs != stage_inputs(area, layer, inputs["options"]):
        return False
    print(f"{area}: reused completed {layer} output", flush=True)
    if not no_assemble:
        assemble(area)
    return True


def begin_layer(area, layer):
    """Invalidate completion before changing any binary, even if inputs are unchanged."""
    build_cache.write_json(folder(area) / f"{layer}.complete.json", {"complete": False})


def write_layer(area: str, layer: str, data: dict):
    if layer in DEPENDENCIES:
        current = dependency_snapshot(area, DEPENDENCIES[layer])
        if data.get("dependencies", current) != current:
            raise RuntimeError(f"{area}: inputs changed while building {layer}; keep output staged and rebuild")
        data = {**data, "dependencies": current}
    raw = dumps(data)
    write(folder(area) / f"{layer}.json", raw)
    if layer in DEPENDENCIES:
        build_cache.write_json(folder(area) / f"{layer}.complete.json",
                               {"complete": True, "metadata": build_cache.digest(raw.encode())})


def layer_complete(area, layer):
    record = build_cache.read_json(folder(area) / f"{layer}.complete.json")
    path = folder(area) / f"{layer}.json"
    if record.get("complete") is not True:
        return False
    try:
        return record.get("metadata") == build_cache.digest(path.read_bytes())
    except OSError:
        return False


def chunks(meta: dict):
    """(ci, cj) of every chunk, in the order the tiles are listed."""
    C, cols, rows = meta["chunk_tiles"], meta["cols"], meta["rows"]
    return [(ci, cj) for ci in range(-(-cols // C)) for cj in range(-(-rows // C))]


def chunk_tiles(meta: dict, ci: int, cj: int):
    """(i, j) of every tile in a chunk, in order."""
    C = meta["chunk_tiles"]
    return [(i, j) for i in range(ci * C, min(meta["cols"], (ci + 1) * C)) for j in range(cj * C, min(meta["rows"], (cj + 1) * C))]


def tile_box(meta: dict, i: int, j: int):
    T, (x0, y0, x1, y1) = meta["tile"], meta["box"]
    return (x0 + i * T, y0 + j * T, min(x1, x0 + (i + 1) * T), min(y1, y0 + (j + 1) * T))


def cover_key(t: dict, height) -> str:
    """What a tile's ground cover (ground_cover.py) depends on in the map: the areas, streets
    and building outlines that leave the ground bare (before the cover is added to
    them), and the digest of the tile's terrain heights. Young woods lie inside a wood that
    is already there, and assemble() puts them into the tile before it compares this key."""
    # (Verges are left out as well: most are strips of grass that was grass already, and a
    # city's worth of cover would go stale for them. Where a verge is unmapped land outside
    # the survey, the cover under it is simply drawn over.)
    areas = {k: v for k, v in t["areas"].items() if k not in ("young_wood", "wood_clearing", "verge")}
    return build_cache.digest(dumps([areas, t["roads"], [b["rings"] for b in t["buildings"]], height]).encode())


def cover_processing() -> list:
    """The code the cover layer is made by (a change to it makes the layer out of date):
    what works a tile's cover out in ground_cover.py (not the prototype's other commands),
    the cell classifier it calls and the material model."""
    here = Path(__file__).parent
    model = here / "cover_model.json"  # (the material model cover_labels.py trains; none: the rules alone)
    return [build_cache.reach_key(here / "ground_cover.py", ["tile_cover", "tile_job"]),
            build_cache.digest((here / "cover_cells.py").read_bytes()),
            build_cache.digest(model.read_bytes()) if model.exists() else None]


def young_key(t: dict, height) -> str:
    """What a tile's young woods (young_woods.py) depend on: its wood outlines (before the
    cover adds any) and the digest of its terrain heights."""
    a = t["areas"]
    return build_cache.digest(dumps([[*a.get("wood", []), *a.get("dtm_wood", [])], height]).encode())


def young_processing() -> list:
    here = Path(__file__).parent
    return [build_cache.digest((here / "young_woods.py").read_bytes()),
            build_cache.reach_key(here / "ground_cover.py", ["burn", "export", "ipr_dsm", "photo", "rings_of", "terrain", "RGB", "DSM", "DSM_SOURCE"])]


def height_digest(terrain, k):
    """The digest of a tile's height file as the terrain layer wrote it (None without one)."""
    return ((terrain or {}).get("payloads", {}).get(f"{k}.height.bin.gz") or [None, None])[1]


def merge_cover(t: dict, cover: dict):
    """Put a tile's classified ground into it as areas the game already draws: cover_<class>
    for each class, tree canopy as wood (which the game fills with trees), and the single
    trees found by the photos, but not those next to a surveyed one."""
    areas = dict(t["areas"])  # (a tile with no ground of its own shares the empty one)
    for cls, polys in cover["areas"].items():
        key = "wood" if cls == "trees" else f"cover_{cls}"
        areas[key] = [*areas.get(key, []), *polys]
    t["areas"] = areas
    known = t["trees"]
    fresh = [p for p in cover["trees"] if not any(abs(q[0] - p[0]) < 2.5 and abs(q[1] - p[1]) < 2.5 for q in known)]
    t["trees"] = [*known, *fresh]


def treesize_processing() -> list:
    here = Path(__file__).parent
    return [build_cache.digest((here / "tree_sizes.py").read_bytes()),
            build_cache.reach_key(here / "ground_cover.py", ["burn", "export", "ipr_dsm", "photo", "terrain_wide", "RGB", "CIR", "DSM", "DSM_SOURCE", "SEEN"])]


def greenery_processing() -> list:
    return [build_cache.digest(Path(__file__).with_name("ipr_greenery.py").read_bytes())]


def utility_processing() -> list:
    return [build_cache.digest(Path(__file__).with_name("ipr_utility.py").read_bytes())]


def surveyed_layer(area, name, processing, meta, command, strict):
    """An optional layer made from a survey (ipr_greenery.py, ipr_utility.py), or None if it
    isn't there or was made by other code, from other downloads or for other tiles."""
    layer = read_layer(area, name)
    if layer and not (layer.get("tile") == meta["tile"] and layer.get("processing") == processing
                      and build_cache.sources_current(layer.get("sources", {}))):
        message = f"{area}: the {name} layer was made by other code or from other sources; run {command} build {area}"
        if strict:
            raise SystemExit(message)
        print(message)
        return None
    return layer


def merge_greenery(t: dict, green: dict, cover: dict | None):
    """Put IPR's surveyed greenery (ipr_greenery.py) into a tile: its lawns, meadows, beds and
    shrub groups and groups of trees as areas of their own, its hedges among the
    fences and its single shrubs. Where it has something it stands for what was guessed
    there: the photos' tree canopy and single trees (`cover`, the tile's ground cover
    before it is merged; changed in place) give way inside it."""
    from shapely import STRtree, points, prepare, union_all
    from shapely.geometry import LineString, Polygon
    areas = dict(t["areas"])
    shapes = [Polygon(p[0], p[1:]).buffer(0) for polys in green["areas"].values() for p in polys]
    if cover and shapes and (cover["areas"].get("trees") or cover["trees"]):
        known = union_all(shapes)
        prepare(known)
        canopy = []
        for p in cover["areas"].get("trees", []):
            g = Polygon(p[0], p[1:]).buffer(0)
            if not known.intersects(g) or known.intersection(g).area < 0.5 * g.area:
                canopy.append(p)
        cover["areas"] = {**cover["areas"], "trees": canopy}
        cover["trees"] = [p for p in cover["trees"] if not known.contains(points(p[0], p[1]))]
    for key, polys in green["areas"].items():
        areas[key] = [*areas.get(key, []), *polys]
    t["areas"] = areas
    if green["hedges"]:
        # A hedge the map already has (OSM's, or one made up along a plot) stays as it is.
        mapped = [LineString(f["pts"]) for f in t["fences"] if f["kind"] == "hedge" and len(f["pts"]) > 1]
        tree = STRtree(mapped) if mapped else None
        fresh = []
        for h in green["hedges"]:
            line = LineString(h["pts"])
            if tree is not None and len(tree.query(line.interpolate(0.5, normalized=True), predicate="dwithin", distance=1.5)):
                continue
            fresh.append({"kind": "hedge", "h": h["h"], "pts": h["pts"]})
        t["fences"] = [*t["fences"], *fresh]
    if green["shrubs"]:
        t["shrubs"] = green["shrubs"]


def building_key(b: dict) -> str:
    """Names one building in a tile across builds: its OSM id and first corner."""
    x, y = b["rings"][0][0]
    return f"{b['id']}@{x},{y}"


def tiles(area: str, meta: dict | None = None):
    """Yield (i, j, tile) for every tile of the area that has anything in it, put
    together from the four chunked layers, in the order of index.json."""
    meta = meta or read_meta(area)
    for ci, cj in chunks(meta):
        parts = {layer: read_chunk(area, layer, ci, cj)["tiles"] for layer in CHUNKED}
        for i, j in chunk_tiles(meta, ci, cj):
            k = f"{i}_{j}"
            t = {}
            for layer in CHUNKED:
                t.update(parts[layer].get(k) or EMPTY[layer])
            t.setdefault("fences", [])  # (chunks built before fences were)
            t.setdefault("drives", [])  # (...and before the drives)
            t.setdefault("marks", [])  # (...and before the road marks)
            for key, empty in (("plots", []), ("patches", {}), ("sheds", [])):  # (...and before the plots)
                t.setdefault(key, empty)
            if not (t["buildings"] or t["areas"] or t["roads"] or t["walk"]):
                continue
            yield i, j, {"i": i, "j": j, "box": [round(v, 2) for v in tile_box(meta, i, j)], **{key: t[key] for key in ORDER}}


def tunnel_shapes(terrain):
    """The tunnel levels' outlines of every tile, as one shape (None without any)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    shapes = [Polygon(p[0], p[1:]).buffer(0) for tile in (terrain or {}).get("tiles", {}).values()
              for lv in tile if lv["kind"] == "tunnel" for p in lv["polys"]]
    return unary_union(shapes) if shapes else None


def in_tunnel(shape, pts):
    """Whether a street (its points in local metres) runs along a tunnel level."""
    if shape is None:
        return False
    from shapely.geometry import LineString
    return LineString(pts).intersection(shape).length > 1.0


def pipeline_commit() -> str:
    """The commit the map is being built from, with -dirty if files differ from it."""
    try:
        return subprocess.run(["git", "describe", "--always", "--dirty", "--abbrev=10", "--exclude", "*"],
                              cwd=Path(__file__).parent, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def assemble(area: str, strict=False) -> dict:
    """Write the game's tiles, index.json and names.json from the layers."""
    meta = read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: no layers yet; run build_tiles.py {area} first")
    started = time.perf_counter()
    if strict:
        from chunk_cache import check_complete
        check_complete(area, meta)
    ipr, terrain = (build_cache.read_json(folder(area) / f"{name}.json") for name in ("ipr", "terrain"))
    cover = read_layer(area, "cover")
    if cover and not (cover.get("tile") == meta["tile"] and cover.get("processing") == cover_processing()
                      and build_cache.sources_current(cover.get("sources", {}))):
        message = f"{area}: the ground cover was made by other code or from other sources; run ground_cover.py build {area}"
        if strict:
            raise SystemExit(message)
        print(message)
        cover = None
    young = read_layer(area, "young")
    if young and not (young.get("tile") == meta["tile"] and young.get("processing") == young_processing()
                      and build_cache.sources_current(young.get("sources", {}))):
        message = f"{area}: the young woods were made by other code or from other sources; run young_woods.py build {area}"
        if strict:
            raise SystemExit(message)
        print(message)
        young = None
    greenery = surveyed_layer(area, "greenery", greenery_processing(), meta, "ipr_greenery.py", strict)
    utility = surveyed_layer(area, "utility", utility_processing(), meta, "ipr_utility.py", strict)
    treesize = surveyed_layer(area, "treesize", treesize_processing(), meta, "tree_sizes.py", strict)
    for name, layer in (("ipr", ipr), ("terrain", terrain)):
        options = layer.get("options")
        current = isinstance(options, dict) and stage_current(area, name, layer, stage_inputs(area, name, options))
        if not current:
            message = f"{area}: {name} dependencies or output are missing or changed; rebuild that step"
            if strict:
                raise SystemExit(message)
            if layer:
                print(message)
    if strict:
        # Check coverage and payloads before the first assembled output is changed.
        keys = set()
        outdated, young_outdated = [], []
        for i, j, t in tiles(area, meta):
            k = f"{i}_{j}"
            keys.add(k)
            if cover and k in cover["inputs"] and cover["inputs"][k] != cover_key(t, height_digest(terrain, k)):
                outdated.append(k)
            if young and k in young["inputs"] and young["inputs"][k] != young_key(t, height_digest(terrain, k)):
                young_outdated.append(k)
        for name, layer in (("ipr", ipr), ("terrain", terrain)):
            if keys - set(layer.get("made_for", [])):
                raise SystemExit(f"{area}: {name} is missing tiles; rebuild that step")
        if young_outdated:
            raise SystemExit(f"{area}: the young woods of {len(young_outdated)} tiles are out of date ({', '.join(young_outdated[:6])} …); run young_woods.py build {area}")
        if outdated:
            raise SystemExit(f"{area}: the ground cover of {len(outdated)} tiles is out of date ({', '.join(outdated[:6])} …); run ground_cover.py build {area}")
        for name, layer in (("ipr", ipr), ("terrain", terrain)):
            if filename := stage_payload_error(area, name, layer):
                raise SystemExit(f"{area}: missing or changed {filename}; rebuild {name}")
    out_dir = OUT / f"{area}_now"
    (out_dir / "tiles").mkdir(parents=True, exist_ok=True)
    # IPR's buildings and the terrain are made for a tile grid; after the tiles changed
    # size they don't fit at all, and tiles that are new since they were made have none.
    for name, layer in (("ipr_buildings", ipr), ("ipr_terrain", terrain)):
        if layer and layer.get("tile") != meta["tile"]:
            print(f"the tiles have changed size since {name}.py ran: run it again")
    ipr = ipr if ipr and ipr.get("tile") == meta["tile"] else None
    terrain = terrain if terrain and terrain.get("tile") == meta["tile"] else None
    listed, rails, names, written = [], [], {}, 0
    outward = {"drive": {}, "walk": {}}
    tunnels = tunnel_shapes(terrain)
    on_levels = None
    if terrain and terrain.get("index", {}).get("wayLevels"):
        import structures
        on_levels = structures.OnLevels(terrain.get("ways", []), terrain.get("tiles", {}))
    for ci, cj in chunks(meta):
        rails += read_chunk(area, "ground", ci, cj)["rails"]
        for name, (length, x, y) in read_chunk(area, "streets", ci, cj)["names"].items():
            if length > names.get(name, (0,))[0]:
                names[name] = (length, x, y)
    out_of_date = young_out_of_date = 0
    for i, j, t in tiles(area, meta):
        k = f"{i}_{j}"
        merged_green = False
        # Where its woods are young, if made for the woods and heights as they are now.
        if young and k in young["inputs"]:
            if young["inputs"][k] != young_key(t, height_digest(terrain, k)):
                young_out_of_date += 1
            else:
                if young["tiles"].get(k):
                    t["areas"] = {**t["areas"], "young_wood": young["tiles"][k]}
                if young.get("clear", {}).get(k):
                    t["areas"] = {**t["areas"], "wood_clearing": young["clear"][k]}
        # The classified bare ground, if it was made for the ground and heights as they are now.
        if cover and k in cover["inputs"]:
            if cover["inputs"][k] != cover_key(t, height_digest(terrain, k)):
                out_of_date += 1
            elif k in cover["tiles"]:
                own = dict(cover["tiles"][k])
                # (IPR's surveyed greenery first: the photos' trees give way inside it.)
                if greenery and k in greenery["tiles"]:
                    merge_greenery(t, greenery["tiles"][k], own)
                    merged_green = True
                merge_cover(t, own)
        if greenery and k in greenery["tiles"] and not merged_green:
            merge_greenery(t, greenery["tiles"][k], None)
        # How tall its trees are and how wide their crowns (tree_sizes.py), by where they stand:
        # [x, y, kind, top, radius].
        # What grows where, and how high (tree_sizes.py, canopy_cells): the game makes trees
        # up only where there are leaves, and fills the canopy no mapped crown covers.
        if treesize and k in treesize.get("canopy", {}):
            t["canopy"] = treesize["canopy"][k]
        if treesize and treesize["tiles"].get(k):
            sizes = {(s[0], s[1]): s[2:] for s in treesize["tiles"][k]}
            t["trees"] = [[p[0], p[1], p[2] if len(p) > 2 else 0, *sizes[p[0], p[1]]] if (p[0], p[1]) in sizes else p
                          for p in t["trees"]]
        # What lies in and stands on its streets (ipr_utility.py): [x, y, kind].
        if utility and utility["tiles"].get(k):
            t["utility"] = utility["tiles"][k]
        got = ipr and ipr["tiles"].get(k)
        if got:
            missing = set(got["noIpr"])
            for b in t["buildings"]:
                if b["own"] and building_key(b) in missing:
                    b["noIpr"] = True
            t["ipr"] = {"buildings": got["buildings"], "triangles": got["triangles"]}
        # A way tagged as a tunnel that no tunnel level has (structures.drop_shallow) is on the ground.
        if terrain:
            for edges in (t["drive"], t["walk"]):
                for e in edges:
                    if e.get("tunnel") and not in_tunnel(tunnels, e["pts"]):
                        del e["tunnel"]
        # Its bridges and tunnels (the heights are in its .levels.bin).
        if terrain and terrain.get("tiles", {}).get(k):
            t["structures"] = terrain["tiles"][k]
        # Which level each street on a bridge or in a tunnel is on, and each stretch of
        # tram track on a bridge: where two bridges cross, the outlines alone don't say.
        if on_levels:
            for edges in (t["drive"], t["walk"]):
                for e in edges:
                    cut = on_levels.over_cutting(e)
                    if cut:  # (a street on the ground over an underpass's cutting: see structures.cuttings)
                        if len(cut) > 1:
                            e["levels"] = cut
                        else:
                            e["level"] = cut[0][1]
                        continue
                    level = on_levels.edge(e)
                    if level is not None:
                        e["level"] = level
                        along = on_levels.stretches(e)
                        if along:  # (an edge of several ways, not all on one level)
                            e["levels"] = along
            if t.get("structures"):  # (listed even when empty: the game then doesn't guess)
                t["deckRails"] = on_levels.rails(k, t["rails"], t["roads"])
        # Its terraces at the foot of retaining walls (dtm_heights.py; their labels are in its .height.bin).
        if terrain and terrain.get("terraces", {}).get(k):
            t["terraces"] = terrain["terraces"][k]
        written += write(out_dir / "tiles" / f"{k}.json", dumps(t))
        leaving(t, meta, outward)
        # Whether it has IPR's buildings, so the game can fetch them with the rest.
        listed.append([i, j, sum(b["own"] for b in t["buildings"]), *([int(bool(got))] if ipr else [])])
    index = {
        # What the game checks before reading anything else, then when and from which
        # commit this map was built (the settings panel shows the date).
        "format": FORMAT, "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pipeline": pipeline_commit(),
        "area": area, "bbox_wgs84": meta["bbox_wgs84"],
        "size": meta["size"], "origin": meta["origin"],
        "tile": meta["tile"], "cols": meta["cols"], "rows": meta["rows"], "tiles": listed, "rails": rails, "graphs": True,
        "parkingInTiles": meta["parking"],
        # leaving.json lists the streets that run on past the map's edge.
        "leaving": True,
    }
    if ipr:
        index["ipr"] = True
        index["iprRef"] = ipr["iprRef"]
    if terrain:
        index["terrain"] = terrain["index"]
    keys = {f"{i}_{j}" for i, j, *_ in listed}
    for name, layer in (("ipr_buildings", ipr), ("ipr_terrain", terrain)):
        if layer and keys - set(layer["made_for"]):
            message = f"{len(keys - set(layer['made_for']))} tiles are new since {name}.py ran: run it again"
            if strict:
                raise SystemExit(message)
            print(message)
    # The tiles' .bin files are gzipped (.bin.gz) since both IPR steps do it.
    gz = [bool(layer.get("gzip")) for layer in (ipr, terrain) if layer]
    if gz and all(gz):
        index["gzip"] = True
    elif any(gz):
        print("the IPR buildings and the terrain were built by different versions: run both again")
    if out_of_date:
        print(f"{out_of_date} tiles changed since their ground cover was made, and have none: run ground_cover.py build {area}")
    if young_out_of_date:
        print(f"{young_out_of_date} tiles changed since their young woods were made, and have none: run young_woods.py build {area}")
    write(out_dir / "index.json", dumps(index))
    write(out_dir / "names.json", dumps({k: v[1:] for k, v in sorted(names.items())}))
    write(out_dir / "leaving.json", dumps({graph: list(edges.values()) for graph, edges in outward.items()}))
    print(f"{area}: {len(listed)} tiles, {written} changed → {out_dir.name}/")
    remove_stale(out_dir / "tiles", keys)
    build_cache.report_times(f"{area} assemble", {"total": time.perf_counter() - started})
    return index


TILE_FILE = re.compile(r"^(-?\d+_-?\d+)\.[a-z0-9.]+$")


def leaving(t: dict, meta: dict, into: dict):
    """Add to `into` the streets of a tile on the map's rim that run on outside the map:
    each goes on to its next junction, and the countryside the game makes out there
    (src/countrysideJoin.ts) joins its own streets to them. The edges are the tile's
    own, so the game takes them as the same ones."""
    if not (t["i"] in (0, meta["cols"] - 1) or t["j"] in (0, meta["rows"] - 1)):
        return
    ox, oy = meta["origin"]
    x1, y1 = meta["size"][0] - ox, meta["size"][1] - oy  # (the map ends there, part of the way across its last tiles)
    for graph in ("drive", "walk"):
        for e in t.get(graph) or []:
            if any(x < -ox or x > x1 or y < -oy or y > y1 for x, y in e["pts"]):
                into[graph].setdefault(e["id"], e)


def remove_stale(tiles_dir: Path, keys: set):
    """Remove the files of tiles no longer in the index (a tile drops out when the area
    or its contents change, and its old files would stay behind and go out with a
    deploy). Only files named after a tile, only in the tiles folder."""
    stale = sorted(p for p in tiles_dir.iterdir() if p.is_file() and (m := TILE_FILE.match(p.name)) and m.group(1) not in keys)
    for p in stale:
        p.unlink()
    if stale:
        gone = sorted({TILE_FILE.match(p.name).group(1) for p in stale})
        print(f"removed {len(stale)} files of {len(gone)} tiles no longer in the index: {', '.join(gone[:20])}{' …' if len(gone) > 20 else ''}")


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Assemble the map from completed layers")
    ap.add_argument("area", nargs="?", default="centrum")
    ap.add_argument("--strict", action="store_true", help="reject incomplete chunks or stale IPR/terrain dependencies before publication")
    args = ap.parse_args()
    assemble(args.area, strict=args.strict)
