"""Real 3D buildings from IPR Praha's open 3D model (CityGML LOD3: actual roof
shapes, towers, domes and dormers) for the tiles made by build_tiles.py.

    uv run ipr_buildings.py centrum            # after build_tiles.py centrum
    uv run ipr_buildings.py praha --jobs 4     # sheets read side by side (default: cores - 2)

For every tile it writes tiles/<i>_<j>.ipr.bin.gz next to the tile JSON: the triangles of
every building whose footprint centre is in the tile, with roof or wall colours; the
tile JSON gets "ipr" so the game draws these instead of extruding OSM footprints. OSM
buildings that no IPR building stands on (newer ones, sheds, anything past the edge of
the model) get "noIpr" and are still extruded. OSM footprints still drive collisions
and contact shadows. What the tiles get is kept as the ipr layer (see layers.py).

Each sheet is read once: its buildings, triangulated in the area's local metres, are
kept in pipeline/.cache/ipr/parsed/<area>/, so running this again (after the OSM
buildings changed, say) only matches them up and colours them.

Source: IPR Praha, 3D model budov (datový podklad © IPR Praha, CC BY). Sheets are
SMO-5 map sheets of 2.5 x 2 km, BD3_<block>_<X>-<Y>, downloaded once into
pipeline/.cache/ipr/ from IPR's ArcGIS Online catalogue (each is ~150-250 MB).
"""

import argparse
import json
import math
import os
import pickle
import struct
import time
import urllib.request
import zlib
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import shapely
from lxml import etree
from pyproj import Transformer
from shapely import STRtree, constrained_delaunay_triangles
from shapely.geometry import MultiPoint, Point, Polygon

import layers
import roofs
from osm_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "ipr"
ORG = "SBTXIEUGWbqzUecw"
NS = {"gml": "http://www.opengis.net/gml", "bldg": "http://www.opengis.net/citygml/building/2.0"}
BUILDING = f"{{{NS['bldg']}}}Building"
SURFACES = {"RoofSurface": 1, "WallSurface": 0, "GroundSurface": 2, "ClosureSurface": 0, "OuterFloorSurface": 1, "OuterCeilingSurface": 0}

# Heights are stored in cm above this, so buildings stand on the terrain (ipr_terrain.py).
REF_HEIGHT = 180.0

ROOF_TILES = ["#b2644b", "#a6543f", "#bf7256", "#9e5442", "#ad5f45", "#a8634f", "#ba6e50", "#a15540"]
ROOF_SLATE = ["#6c6d70", "#5e6064", "#77746f"]
COPPER = "#6f9483"
WALLS = ["#e4d4b1", "#dac49b", "#efe3c6", "#cfb98f", "#e9d0a2", "#d8c7b0", "#e6c9a8"]


class krovak_to_local:
    """S-JTSK (EPSG:5514) → the game's local metres, through WGS84 with the Czech
    datum shift. Going straight to the local projection (which has no datum) would
    silently skip the shift and put every building ~25 m off."""

    def __init__(self, local):
        from pyproj.aoi import AreaOfInterest
        self.to_wgs = Transformer.from_crs("EPSG:5514", "EPSG:4326", always_xy=True,
                                           area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))
        self.to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)

    def transform(self, x, y):
        return self.to_local.transform(*self.to_wgs.transform(x, y))


def sheet(x, y):
    """SMO-5 sheet (X, Y) holding a point in S-JTSK (EPSG:5514) metres, counted from the
    Praha block's north-east corner (X grows west, Y south)."""
    return math.floor((-725000 - x) / 2500), math.floor((-1040000 - y) / 2000)


# SMO-5 sheets come in blocks of 10 x 10 named after a town; the city spills over from
# the Praha block into these neighbours, keyed by (X // 10, Y // 10).
BLOCKS = {(0, 0): "Prah", (1, 0): "Bero", (1, -1): "Klad", (0, -1): "Krav", (-1, 0): "Cbro"}


def sheet_name(X, Y):
    """The block and number of sheet (X, Y), e.g. (10, 1) → "Bero_0-1"; None outside the blocks IPR covers."""
    block = BLOCKS.get((X // 10, Y // 10))
    return block and f"{block}_{X % 10}-{Y % 10}"


def search(prefix):
    """{title: item id} of every IPR catalogue item whose title starts with prefix."""
    found, start = {}, 1
    while start != -1:
        url = (f"https://www.arcgis.com/sharing/rest/search?q=title%3A{prefix}%20AND%20orgid%3A{ORG}"
               f"&num=100&start={start}&f=json")
        d = json.load(urllib.request.urlopen(url))
        for r in d.get("results", []):
            if r["title"].startswith(prefix):
                found[r["title"]] = (r["id"], r["type"])
        start = d.get("nextStart", -1)
    return found


def catalogue():
    path = CACHE / "catalogue_bd3.json"
    if path.exists():
        return json.loads(path.read_text())
    items = {t: i for t, (i, kind) in search("BD3_").items() if kind == "GML"}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=1))
    return items


def download(name, items):
    path = CACHE / f"{name}.gml"
    if path.exists():
        return path
    if name not in items:
        return None
    print(f"  downloading {name}…")
    tmp = path.with_suffix(".part")
    with urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{items[name]}/data") as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.rename(path)
    return path


def buildings(path):
    """Yield (id, [(kind, ring 3D array)]) for every building in a sheet, streaming."""
    for _, el in etree.iterparse(str(path), events=("end",), tag=BUILDING, huge_tree=True):
        surfaces = []
        for surf in el.iter():
            tag = etree.QName(surf).localname
            if tag not in SURFACES:
                continue
            for pl in surf.iter(f"{{{NS['gml']}}}posList"):
                v = np.array(pl.text.split(), dtype=float).reshape(-1, 3)
                if len(v) >= 4:
                    surfaces.append((SURFACES[tag], v[:-1] if np.allclose(v[0], v[-1]) else v))
        gid = el.get(f"{{{NS['gml']}}}id")
        el.clear()
        while el.getprevious() is not None:
            del el.getparent()[0]
        if surfaces:
            yield gid, surfaces


def triangulate(ring):
    """Triangles (k x 3 x 3) of one planar 3D polygon."""
    n = np.zeros(3)
    for a, b in zip(ring, np.roll(ring, -1, axis=0)):
        n += np.array([(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])])
    ln = np.linalg.norm(n)
    if ln < 1e-9:
        return []
    n /= ln
    u = np.cross(n, [0, 0, 1] if abs(n[2]) < 0.9 else [1, 0, 0])
    u /= np.linalg.norm(u)
    w = np.cross(n, u)
    o = ring[0]
    flat = [((p - o) @ u, (p - o) @ w) for p in ring]
    lookup = {(round(a, 4), round(b, 4)): p for (a, b), p in zip(flat, ring)}
    try:
        poly = Polygon(flat)
        if not poly.is_valid:
            poly = poly.buffer(0)
        tris = constrained_delaunay_triangles(poly)
    except Exception:
        return []
    out = []
    for t in getattr(tris, "geoms", []):
        pts = list(t.exterior.coords)[:3]
        vs = [lookup.get((round(a, 4), round(b, 4))) for a, b in pts]
        if any(v is None for v in vs):
            # A vertex made by buffer(0): lift it back onto the plane.
            vs = [o + a * u + b * w for a, b in pts]
        # Keep the surface's outward normal (GML rings wind counter-clockwise from outside).
        if np.dot(np.cross(vs[1] - vs[0], vs[2] - vs[0]), n) < 0:
            vs = [vs[0], vs[2], vs[1]]
        out.append(vs)
    return out


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def flat_roof(c):
    # Flat roofs are tar, gravel or sheet metal: mostly grey whatever the tiles would be.
    return tuple(round(v * 0.35 + 138 * 0.65) for v in c)


COVERS = ("tiles", "slate", "copper")


def colours(bid, osm):
    """A building's wall colour, its roof colour for each cover (roofs.py), and the
    cover its roofs get where OSM doesn't say: the OSM building it sits on if that
    says, else slate or copper for churches and red tiles for everything else, which
    is what nearly all pitched roofs in Prague are. Flat roofs are greyed in flat_roof."""
    hv = (zlib.crc32(bid.encode()) & 0xFFFFFF) / 0xFFFFFF
    wall = hexrgb(WALLS[int(hv * len(WALLS)) % len(WALLS)])
    roof = {
        "tiles": hexrgb(ROOF_TILES[int(hv * 997) % len(ROOF_TILES)]),
        "slate": hexrgb(ROOF_SLATE[int(hv * 10) % len(ROOF_SLATE)]),
        "copper": hexrgb(COPPER),
    }
    if osm and osm.get("cover"):
        default = osm["cover"]
    elif osm and osm.get("church"):
        default = "copper" if osm.get("roof") in ("dome", "onion") else "slate"
    else:
        default = "tiles"
    return wall, roof, default


class RoofRegions:
    """The OSM buildings and building parts of a tile whose roof cover is known, and
    the hand-drawn regions of roofs.py. A roof triangle takes the cover of a region
    it lies in: a hand-drawn one first, else the smallest (a tower's part inside the
    whole church, say)."""

    def __init__(self, shapes):
        self.covers = np.array([COVERS.index(c) for _, c, _ in shapes], dtype=np.int8)
        self.rank = np.array([(0 if hand else 1e9) + g.area for g, _, hand in shapes])
        self.tree = STRtree([g for g, _, _ in shapes]) if shapes else None

    def __call__(self, xy):
        """Cover index for each point, -1 where no region says."""
        out = np.full(len(xy), -1, dtype=np.int8)
        if self.tree is None or not len(xy):
            return out
        pt, reg = self.tree.query(shapely.points(xy), predicate="within")
        if len(pt):
            order = np.lexsort((self.rank[reg], pt))
            pt, reg = pt[order], reg[order]
            first = np.r_[True, pt[1:] != pt[:-1]]
            out[pt[first]] = self.covers[reg[first]]
        return out


PARSED_VERSION = 1  # bump when read_sheet's output changes


def read_sheet(job):
    """Every building of one sheet: (gml id, tile (i, j), int16 positions packed for the
    tile, a code per triangle (0 wall, 1 roof, 2 flat roof), ground outlines); None
    for the positions where a building has no triangles. Kept per area and sheet."""
    name, path, local, T, origin = job
    cache = CACHE / "parsed" / f"{name}_{zlib.crc32(local.encode()):08x}.pkl"
    st = Path(path).stat()
    key = [PARSED_VERSION, st.st_mtime_ns, st.st_size, local, T, origin, REF_HEIGHT]
    if cache.exists():
        with open(cache, "rb") as f:
            got = pickle.load(f)
        if got["key"] == key:
            return name, got["buildings"]
    to_local = krovak_to_local(local)
    ox, oy = origin
    out = []
    for bid, surfaces in buildings(path):
        pts = np.vstack([v for _, v in surfaces])
        lx, ly = to_local.transform(pts[:, 0], pts[:, 1])
        cx, cy = float(np.mean(lx)), float(np.mean(ly))
        i, j = math.floor((cx + ox) / T), math.floor((cy + oy) / T)
        tris, codes, ground = [], [], []
        for kind, ring in surfaces:
            rx, ry = to_local.transform(ring[:, 0], ring[:, 1])
            if kind == 2 and len(ring) >= 3:
                ground.append(Polygon(np.column_stack([rx, ry])).buffer(0))
            loc = np.column_stack([rx, ry, ring[:, 2] - REF_HEIGHT])
            for t in triangulate(loc):
                nrm = np.cross(t[1] - t[0], t[2] - t[0])
                if kind == 1 and nrm[2] < 0:
                    t, nrm = [t[0], t[2], t[1]], -nrm  # roofs always face up
                tris.append(t)
                flat = kind == 1 and nrm[2] > 0.97 * (np.linalg.norm(nrm) or 1)
                codes.append(2 if flat else 1 if kind == 1 else 0)
        pos = footprints = None
        if tris:
            footprints = [g for g in ground if g.area > 0.5] or [MultiPoint(np.column_stack([lx, ly])).convex_hull]
            # Pack right away: centimetres from the tile corner, (x, height, y).
            x0, y0 = i * T - ox, j * T - oy
            v = np.array(tris, dtype=np.float64).reshape(-1, 3)
            p = np.column_stack([(v[:, 0] - x0) * 100, v[:, 2] * 100, (v[:, 1] - y0) * 100])
            pos = np.clip(np.round(p), -32768, 32767).astype("<i2").ravel()
        out.append((bid, cx, cy, (i, j), pos, np.array(codes, dtype=np.uint8), footprints))
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        pickle.dump({"key": key, "buildings": out}, f, protocol=5)
    tmp.replace(cache)
    return name, out


def sheet_jobs(area, meta):
    """The area's local projection, and a read_sheet job for each sheet over the area
    (downloaded if it isn't yet)."""
    w, s, e, n = AREAS[area]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    corners = [to_krovak.transform(lon, lat) for lon in (w, e) for lat in (s, n)]
    xs = [sheet(x, y) for x, y in corners]
    X0, X1 = min(c[0] for c in xs), max(c[0] for c in xs)
    Y0, Y1 = min(c[1] for c in xs), max(c[1] for c in xs)
    items = catalogue()
    jobs = []
    for X in range(X0, X1 + 1):
        for Y in range(Y0, Y1 + 1):
            if not sheet_name(X, Y):
                continue
            name = f"BD3_{sheet_name(X, Y)}"
            path = download(name, items)
            if not path:
                print(f"  {name}: not in the catalogue")
                continue
            jobs.append((name, str(path), local, meta["tile"], meta["origin"]))
    return local, jobs


def main() -> None:
    ap = argparse.ArgumentParser(description="IPR Praha's 3D buildings for an area's tiles")
    ap.add_argument("area", nargs="?", default="centrum", choices=AREAS)
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="sheets read side by side")
    args = ap.parse_args()
    area = args.area
    out_dir = OUT / f"{area}_now"
    meta = layers.read_meta(area)
    if not meta:
        raise SystemExit(f"{area}: run build_tiles.py {area} first")
    T = meta["tile"]
    origin = meta["origin"]
    local, sheets = sheet_jobs(area, meta)

    # OSM buildings per tile, to borrow tags (church, roof shape, roof cover) for colours.
    osm_by_tile = {}
    for i, j, t in layers.tiles(area, meta):
        bs = [b for b in t["buildings"] if len(b["rings"][0]) >= 3]
        osm_by_tile[(i, j)] = (bs, [Polygon(b["rings"][0]) for b in bs], None)

    def osm_at(i, j, pt):
        bs, polys, tree = osm_by_tile[(i, j)]
        if tree is None:
            tree = STRtree(polys)
            osm_by_tile[(i, j)] = (bs, polys, tree)
        for k in sorted(tree.query(pt)):
            if polys[k].contains(pt):
                return bs[k]
        return None

    # What says which roof is covered with what (roofs.py): OSM's building parts (kept
    # in the buildings layer for this), its buildings, and the hand-drawn regions.
    parts_by_tile = {}
    for ci, cj in layers.chunks(meta):
        for k, t in layers.read_chunk(area, "buildings", ci, cj)["tiles"].items():
            if t.get("parts"):
                parts_by_tile[tuple(map(int, k.split("_")))] = t["parts"]
    # The river and ponds: IPR's model also holds moored boats, which aren't houses.
    water = []
    for ci, cj in layers.chunks(meta):
        for t in layers.read_chunk(area, "ground", ci, cj)["tiles"].values():
            water += [Polygon(r[0], r[1:]).buffer(0) for r in t["areas"].get("water", [])]
    water_tree = STRtree(water)
    afloat = 0

    def on_water(fp):
        """Most of the building's footprint is over water."""
        area_sum = sum(g.area for g in fp)
        if area_sum <= 0:
            return False
        hit = 0.0
        for g in fp:
            for k in water_tree.query(g, predicate="intersects"):
                hit += g.intersection(water[k]).area
        return hit >= 0.6 * area_sum

    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    hand = [(Polygon([to_local.transform(lon, lat) for lon, lat in ring]), cover) for cover, _, ring in roofs.REGIONS]
    regions_by_tile = {}

    def regions(i, j):
        if (i, j) not in regions_by_tile:
            shapes = [(g, c, True) for g, c in hand]
            # The neighbouring tiles' too: a big IPR building reaches well past its own.
            seen = set()
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    near = (i + di, j + dj)
                    for b in (osm_by_tile[near][0] if near in osm_by_tile else []) + parts_by_tile.get(near, []):
                        key = (b["id"], tuple(b["rings"][0][0]))
                        if b.get("cover") and key not in seen:
                            seen.add(key)
                            shapes.append((Polygon(b["rings"][0], b["rings"][1:]), b["cover"], False))
            regions_by_tile[(i, j)] = RoofRegions(shapes)
        return regions_by_tile[(i, j)]

    started = time.perf_counter()
    per_tile = {}  # (i, j) → list of (int16 positions, uint8 colours), one pair per building
    footprints = []  # ground outlines of every IPR building, to find OSM ones it doesn't cover
    run = map if args.jobs == 1 or len(sheets) == 1 else ProcessPoolExecutor(args.jobs).map
    for name, found in run(read_sheet, sheets):
        count = 0
        for bid, cx, cy, (i, j), pos, codes, fp in found:
            if (i, j) not in osm_by_tile:
                continue
            if fp and water and on_water(fp):
                afloat += 1
                continue
            osm = osm_at(i, j, Point(cx, cy))
            wall, roof, default = colours(bid or f"{name}/{count}", osm)
            if pos is not None:
                footprints += fp
                # Colour 0 is the wall, 1-3 the pitched roofs and 4-6 the flat ones, by cover.
                palette = np.array([wall] + [roof[c] for c in COVERS] + [flat_roof(roof[c]) for c in COVERS], dtype=np.uint8)
                which = np.zeros(len(codes), dtype=np.int8)
                top = codes != 0
                if top.any():
                    v = pos.reshape(-1, 3, 3)[top].astype(np.float64) / 100
                    xy = np.column_stack([v[:, :, 0].mean(1) + i * T - origin[0], v[:, :, 2].mean(1) + j * T - origin[1]])
                    cover = regions(i, j)(xy)
                    cover[cover < 0] = COVERS.index(default)
                    which[top] = 1 + cover + np.where(codes[top] == 2, 3, 0)
                per_tile.setdefault((i, j), []).append((pos, palette[which].ravel()))
            count += 1
        print(f"  {name}: {count} buildings in the area", flush=True)
    print(f"  sheets read in {time.perf_counter() - started:.0f} s; {afloat} buildings left out for standing on water")

    # An OSM building counts as IPR's if IPR buildings stand on at least 40 % of it.
    tree = STRtree(footprints)

    def covered(b):
        poly = Polygon(b["rings"][0]).buffer(0)
        if poly.area < 1:
            return True
        hit = sum(poly.intersection(footprints[k]).area for k in tree.query(poly, predicate="intersects"))
        return hit >= 0.4 * poly.area

    total = extra = 0
    tiles = {}
    for (i, j), blist in per_tile.items():
        pos_arr = np.concatenate([p for p, _ in blist])
        col = np.concatenate([c for _, c in blist])
        n_tris = len(col) // 3
        pad = (4 - (8 + pos_arr.nbytes) % 4) % 4
        blob = struct.pack("<II", n_tris, len(blist)) + pos_arr.tobytes() + b"\0" * pad + col.tobytes()
        layers.write_bin(out_dir / "tiles", f"{i}_{j}.ipr.bin", blob)
        missing = [layers.building_key(b) for b in osm_by_tile[(i, j)][0] if b["own"] and not covered(b)]
        extra += len(missing)
        tiles[f"{i}_{j}"] = {"buildings": len(blist), "triangles": n_tris, "noIpr": missing}
        total += len(blob)
    # Tiles that no longer get IPR buildings go back to OSM ones.
    for i, j in osm_by_tile:
        if (i, j) not in per_tile:
            layers.remove_bin(out_dir / "tiles", f"{i}_{j}.ipr.bin")
    # Heights in the .ipr.bin are above iprRef, in metres a.s.l.
    layers.write_layer(area, "ipr", {"iprRef": REF_HEIGHT, "gzip": True, "tile": T, "made_for": [f"{i}_{j}" for i, j in osm_by_tile], "tiles": tiles})
    print(f"{len(per_tile)} tiles with IPR buildings, {total / 1e6:.1f} MB before gzip; {extra} OSM buildings IPR doesn't have")
    layers.assemble(area)


if __name__ == "__main__":
    main()
