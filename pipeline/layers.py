"""The map of an area is built in layers, each by its own step, and put together into
the tiles the game reads only at the end, so changing how one thing is drawn
rebuilds that layer alone:

    buildings  OSM buildings                       build_tiles.py --layers buildings
    ground     land use, streets and pavements     build_tiles.py --layers ground
               (kerbs, gardens), parking areas,
               walls, rails, crossings, trees
    streets    the car and footpath networks       build_tiles.py --layers streets
    parking    paid-parking sections               build_tiles.py --layers parking
    ipr        IPR's 3D buildings                  ipr_buildings.py
    terrain    IPR's terrain, bridge decks         ipr_terrain.py

The first four are kept per chunk in pipeline/.cache/layers/<area>/<layer>/<ci>_<cj>.json
(tile key → what the layer has there, plus what the chunk adds to the whole area,
such as tram rails and street names); ipr and terrain write their .bin files straight
into the tiles and keep the rest in <layer>.json. Every step ends with assemble(),
which writes tiles/<i>_<j>.json, index.json and names.json in public/data/<area>_now/
from the layers, and leaves files whose content hasn't changed alone (so a deploy only
sends what did).

What depends on what: ipr uses the OSM buildings (colours, and which OSM buildings
IPR doesn't have); terrain works out the bridge decks from the ground layer. build_tiles.py says
which of the two to run again.
"""

import gzip
import json
import os
from pathlib import Path

from osm_area import OUT

CACHE = Path(__file__).parent / ".cache" / "layers"
CHUNKED = ("buildings", "ground", "streets", "parking")
# What a tile has when a layer has nothing there, in the order the tile JSON lists it.
EMPTY = {
    "buildings": {"buildings": []},
    "ground": {"areas": {}, "lots": [], "roads": {}, "walls": [], "rails": [], "passages": [], "weirs": [], "crossings": [], "trees": []},
    "streets": {"drive": [], "walk": []},
    "parking": {"sections": []},
}
ORDER = ["areas", "lots", "roads", "buildings", "walls", "rails", "passages", "weirs", "crossings", "trees", "drive", "walk", "sections"]


def gzip_bytes(raw: bytes) -> bytes:
    """Gzipped the same way every time (no timestamp), so unchanged files stay unchanged."""
    return gzip.compress(raw, compresslevel=9, mtime=0)


def write_bin(tiles_dir: Path, name: str, raw: bytes) -> bool:
    """A tile's binary file, gzipped (<name>.gz; the game unpacks it), in place of an
    uncompressed one from before."""
    (tiles_dir / name).unlink(missing_ok=True)
    return write(tiles_dir / f"{name}.gz", gzip_bytes(raw))


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


def write_layer(area: str, layer: str, data: dict):
    write(folder(area) / f"{layer}.json", dumps(data))


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
            if not (t["buildings"] or t["areas"] or t["roads"] or t["walk"]):
                continue
            yield i, j, {"i": i, "j": j, "box": [round(v, 2) for v in tile_box(meta, i, j)], **{key: t[key] for key in ORDER}}


def assemble(area: str) -> dict:
    """Write the game's tiles, index.json and names.json from the layers."""
    meta = read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: no layers yet; run build_tiles.py {area} first")
    out_dir = OUT / f"{area}_now"
    (out_dir / "tiles").mkdir(parents=True, exist_ok=True)
    ipr, terrain = read_layer(area, "ipr"), read_layer(area, "terrain")
    # IPR's buildings and the terrain are made for a tile grid; after the tiles changed
    # size they don't fit at all, and tiles that are new since they were made have none.
    for name, layer in (("ipr_buildings", ipr), ("ipr_terrain", terrain)):
        if layer and layer.get("tile") != meta["tile"]:
            print(f"the tiles have changed size since {name}.py ran: run it again")
    ipr = ipr if ipr and ipr.get("tile") == meta["tile"] else None
    terrain = terrain if terrain and terrain.get("tile") == meta["tile"] else None
    listed, rails, names, written = [], [], {}, 0
    for ci, cj in chunks(meta):
        rails += read_chunk(area, "ground", ci, cj)["rails"]
        for name, (length, x, y) in read_chunk(area, "streets", ci, cj)["names"].items():
            if length > names.get(name, (0,))[0]:
                names[name] = (length, x, y)
    for i, j, t in tiles(area, meta):
        k = f"{i}_{j}"
        got = ipr and ipr["tiles"].get(k)
        if got:
            missing = set(got["noIpr"])
            for b in t["buildings"]:
                if b["own"] and building_key(b) in missing:
                    b["noIpr"] = True
            t["ipr"] = {"buildings": got["buildings"], "triangles": got["triangles"]}
        written += write(out_dir / "tiles" / f"{k}.json", dumps(t))
        # Whether it has IPR's buildings, so the game can fetch them with the rest.
        listed.append([i, j, sum(b["own"] for b in t["buildings"]), *([int(bool(got))] if ipr else [])])
    index = {
        "area": area, "bbox_wgs84": meta["bbox_wgs84"],
        "size": meta["size"], "origin": meta["origin"],
        "tile": meta["tile"], "cols": meta["cols"], "rows": meta["rows"], "tiles": listed, "rails": rails, "graphs": True,
        "parkingInTiles": meta["parking"],
    }
    if ipr:
        index["ipr"] = True
        index["iprRef"] = ipr["iprRef"]
    if terrain:
        index["terrain"] = terrain["index"]
    keys = {f"{i}_{j}" for i, j, *_ in listed}
    for name, layer in (("ipr_buildings", ipr), ("ipr_terrain", terrain)):
        if layer and keys - set(layer["made_for"]):
            print(f"{len(keys - set(layer['made_for']))} tiles are new since {name}.py ran: run it again")
    # The tiles' .bin files are gzipped (.bin.gz) since both IPR steps do it.
    gz = [bool(layer.get("gzip")) for layer in (ipr, terrain) if layer]
    if gz and all(gz):
        index["gzip"] = True
    elif any(gz):
        print("the IPR buildings and the terrain were built by different versions: run both again")
    write(out_dir / "index.json", dumps(index))
    write(out_dir / "names.json", dumps({k: v[1:] for k, v in sorted(names.items())}))
    print(f"{area}: {len(listed)} tiles, {written} changed → {out_dir.name}/")
    return index


if __name__ == "__main__":
    import sys
    assemble(sys.argv[1] if len(sys.argv) > 1 else "centrum")
