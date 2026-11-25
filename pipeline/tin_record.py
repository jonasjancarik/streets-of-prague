"""What each tile's ground mesh (tin_tiles.py) was made from, so that assembling the map
again keeps the meshes that still fit and leaves out those that don't.

Assembly (layers.py) rewrites index.json, and the mesh list in it (`tin`) used to go with
every rebuild: the game then drew the whole map from the lattice until tin_tiles.py ran
again, all of it. Now tin_tiles.py records each mesh's inputs here, and assembly lists a
mesh only while they are the same; `tin_tiles.py <area> --stale` makes the rest again.

A mesh's inputs are what scripts/tin-target.mjs and tin_tiles.py read of the tile and
its eight neighbours (the target reads 20 m past the tile, the held patches look at the
neighbours' bridges and streets): the heights, the terraces and step lines, the water,
the paved ground, the bridges and tunnels and where the streets run. Not the trees, the
ground cover, the buildings or the lanes' widths. The code isn't in them: after changing
the mesh's own code, run tin_tiles.py on all the tiles.

    record(map) -> {"settings": {...}, "tiles": {k: inputs}}   (.cache/tin/<map>/inputs.json)
"""

import gzip
import json
from pathlib import Path

import build_cache

HERE = Path(__file__).resolve().parent
# As in scripts/tin-target.mjs: what it counts as paved.
PAVED_ROADS = ("road", "sett", "pavement", "pavement_asphalt", "path", "dirt")
PAVED_AREAS = ("parking",)


def path(work: Path) -> Path:
    return Path(work) / "inputs.json"


def default_work(map_name: str) -> Path:
    """Where tin_tiles.py keeps a built map's target, report and record (its --work)."""
    return HERE / ".cache" / "tin" / map_name


def read(work: Path) -> dict:
    got = build_cache.read_json(path(work))
    return got if isinstance(got.get("tiles"), dict) and isinstance(got.get("settings"), dict) else {"settings": {}, "tiles": {}}


def write(work: Path, record: dict):
    build_cache.write_json(path(work), record)


def _load(p: Path):
    for q in (p, p.with_name(p.name + ".gz")):
        if q.exists():
            raw = q.read_bytes()
            return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw
    return None


def own(tile: dict, heights: bytes | None) -> str:
    """The parts of one tile a mesh is made from, as a digest."""
    edges = [[e["pts"], e.get("level"), e.get("levels"), bool(e.get("bridge")), e.get("u"), e.get("v")]
             for kind in ("drive", "walk") for e in tile.get(kind) or []]
    areas, roads = tile.get("areas") or {}, tile.get("roads") or {}
    parts = {
        "box": tile.get("box"), "terraces": tile.get("terraces"), "stepLines": tile.get("stepLines"),
        "water": areas.get("water"), "paved": [roads.get(r) for r in PAVED_ROADS] + [areas.get(a) for a in PAVED_AREAS],
        "structures": [s for s in tile.get("structures") or [] if s.get("kind") in ("bridge", "tunnel")],
        "edges": sorted(edges, key=json.dumps),
        "heights": build_cache.digest(heights) if heights is not None else None,
    }
    return build_cache.key(parts)


def heights(tiles_dir: Path, k: str) -> bytes | None:
    return _load(Path(tiles_dir) / f"{k}.height.bin")


def level_heights(tiles_dir: Path, k: str) -> bytes | None:
    return _load(Path(tiles_dir) / f"{k}.levels.bin")


def inputs(tiles_dir: Path, terrain: dict, keys=None, parts: dict | None = None) -> dict:
    """{k: the inputs of tile k's mesh} for `keys` (default every tile in the folder):
    its own parts and its neighbours', and the terrain's grid. `parts`: {k: own(…)} already
    worked out (assembly has each tile in hand once), read from the folder otherwise."""
    tiles_dir = Path(tiles_dir)
    if keys is None:
        keys = [p.name[:-5] for p in tiles_dir.glob("*_*.json")]
    grid = [terrain.get(f) for f in ("n", "step", "unit")]
    parts = dict(parts or {})

    def part(k):
        if k not in parts:
            raw = _load(tiles_dir / f"{k}.json")
            parts[k] = None if raw is None else own(json.loads(raw), heights(tiles_dir, k))
        return parts[k]

    out = {}
    for k in keys:
        i, j = map(int, k.split("_"))
        out[k] = build_cache.key([grid, [part(f"{i + a}_{j + b}") for a in (-1, 0, 1) for b in (-1, 0, 1)]])
    return out


def fresh(tiles_dir: Path, terrain: dict, record: dict, parts: dict | None = None) -> tuple[list, list]:
    """(the tiles whose mesh file is there and still fits, those whose mesh file is
    there but doesn't), each sorted."""
    tiles_dir = Path(tiles_dir)
    have = sorted(p.name[: -len(".tin.bin.gz")] for p in tiles_dir.glob("*.tin.bin.gz"))
    known = [k for k in have if k in record.get("tiles", {})]
    now = inputs(tiles_dir, terrain, known, parts)
    ok = sorted(k for k in known if now[k] == record["tiles"][k])
    return ok, sorted(set(have) - set(ok))
