"""Real 3D buildings from IPR Praha's open 3D model (CityGML LOD3: actual roof
shapes, towers, domes and dormers) for the tiles made by build_tiles.py.

    uv run ipr_buildings.py centrum            # after build_tiles.py centrum

For every tile it writes tiles/<i>_<j>.ipr.bin next to the tile JSON: the triangles of
every building whose footprint centre is in the tile, with roof or wall colours, and
marks the tile JSON with "ipr" so the game draws these instead of extruding OSM
footprints. OSM footprints still drive collisions and contact shadows.

Source: IPR Praha, 3D model budov (datový podklad © IPR Praha, CC BY). Sheets are
SMO-5 map sheets of 2.5 x 2 km, BD3_Prah_<X>-<Y>, downloaded once into
pipeline/.cache/ipr/ from IPR's ArcGIS Online catalogue (each is ~150-250 MB).
"""

import json
import math
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

import numpy as np
from lxml import etree
from pyproj import Transformer
from shapely import constrained_delaunay_triangles
from shapely.geometry import Point, Polygon

from build_area import AREAS, OUT

CACHE = Path(__file__).parent / ".cache" / "ipr"
ORG = "SBTXIEUGWbqzUecw"
NS = {"gml": "http://www.opengis.net/gml", "bldg": "http://www.opengis.net/citygml/building/2.0"}
BUILDING = f"{{{NS['bldg']}}}Building"
SURFACES = {"RoofSurface": 1, "WallSurface": 0, "GroundSurface": 2, "ClosureSurface": 0, "OuterFloorSurface": 1, "OuterCeilingSurface": 0}

ROOF_TILES = ["#b4543a", "#a64a31", "#bf6440", "#9a4835", "#b9694a", "#8e3f2f", "#c47250", "#a85a3f"]
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
    """SMO-5 sheet (X, Y) holding a point in S-JTSK (EPSG:5514) metres."""
    return math.floor((-725000 - x) / 2500), math.floor((-1040000 - y) / 2000)


def catalogue():
    path = CACHE / "catalogue.json"
    if path.exists():
        return json.loads(path.read_text())
    items = {}
    for start in range(1, 1000, 100):
        url = (f"https://www.arcgis.com/sharing/rest/search?q=title%3A%22BD3_Prah%22%20AND%20orgid%3A{ORG}"
               f"&num=100&start={start}&f=json")
        d = json.load(urllib.request.urlopen(url))
        for r in d.get("results", []):
            if r["type"] == "GML":
                items[r["title"]] = r["id"]
        if d.get("nextStart", -1) == -1:
            break
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


def colours(bid, osm):
    """Roof and wall colour for a building, from the OSM building it sits on if any."""
    hv = (zlib.crc32(bid.encode()) & 0xFFFFFF) / 0xFFFFFF
    wall = hexrgb(WALLS[int(hv * len(WALLS)) % len(WALLS)])
    if osm and osm.get("church"):
        roof = hexrgb(COPPER if osm.get("roof") in ("dome", "onion") else ROOF_SLATE[0])
    elif osm and osm.get("kind") in ("civic", "government", "school", "industrial", "commercial", "office", "retail") and hv > 0.5:
        roof = hexrgb(ROOF_SLATE[int(hv * 10) % 3])
    else:
        roof = hexrgb(ROOF_TILES[int(hv * 997) % len(ROOF_TILES)])
    return roof, wall


def main(area: str = "centrum") -> None:
    out_dir = OUT / f"{area}_now"
    index = json.loads((out_dir / "index.json").read_text())
    w, s, e, n = AREAS[area]
    T = index["tile"]
    ox, oy = index["origin"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_local = krovak_to_local(local)
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    corners = [to_krovak.transform(lon, lat) for lon in (w, e) for lat in (s, n)]
    xs = [sheet(x, y) for x, y in corners]
    X0, X1 = min(c[0] for c in xs), max(c[0] for c in xs)
    Y0, Y1 = min(c[1] for c in xs), max(c[1] for c in xs)
    items = catalogue()
    tiles_on_disk = {(i, j) for i, j, _ in index["tiles"]}

    # OSM buildings per tile, to borrow tags (church, roof shape, kind) for colours.
    osm_by_tile = {}

    def osm_at(i, j, pt):
        if (i, j) not in osm_by_tile:
            p = out_dir / "tiles" / f"{i}_{j}.json"
            bs = json.loads(p.read_text())["buildings"] if p.exists() else []
            osm_by_tile[(i, j)] = [(Polygon(b["rings"][0]), b) for b in bs if len(b["rings"][0]) >= 3]
        for poly, b in osm_by_tile[(i, j)]:
            if poly.contains(pt):
                return b
        return None

    per_tile = {}  # (i, j) → list of (triangles, colour) ; colour per triangle
    for X in range(X0, X1 + 1):
        for Y in range(Y0, Y1 + 1):
            name = f"BD3_Prah_{X}-{Y}"
            path = download(name, items)
            if not path:
                print(f"  {name}: not in the catalogue")
                continue
            count = 0
            for bid, surfaces in buildings(path):
                pts = np.vstack([v for _, v in surfaces])
                base = pts[:, 2].min()
                lx, ly = to_local.transform(pts[:, 0], pts[:, 1])
                cx, cy = float(np.mean(lx)), float(np.mean(ly))
                i, j = math.floor((cx + ox) / T), math.floor((cy + oy) / T)
                if (i, j) not in tiles_on_disk:
                    continue
                osm = osm_at(i, j, Point(cx, cy))
                roof, wall = colours(bid or f"{name}/{count}", osm)
                tris, cols = [], []
                for kind, ring in surfaces:
                    rx, ry = to_local.transform(ring[:, 0], ring[:, 1])
                    loc = np.column_stack([rx, ry, ring[:, 2] - base])
                    for t in triangulate(loc):
                        nrm = np.cross(t[1] - t[0], t[2] - t[0])
                        if kind == 1 and nrm[2] < 0:
                            t, nrm = [t[0], t[2], t[1]], -nrm  # roofs always face up
                        tris.append(t)
                        flat = kind == 1 and nrm[2] > 0.97 * (np.linalg.norm(nrm) or 1)
                        cols.append(flat_roof(roof) if flat else roof if kind == 1 else wall)
                per_tile.setdefault((i, j), []).append((tris, cols))
                count += 1
            print(f"  {name}: {count} buildings in the area")

    total = 0
    for (i, j), blist in per_tile.items():
        x0 = i * T - ox
        y0 = j * T - oy
        pos, col = [], []
        for tris, cols in blist:
            for t, c in zip(tris, cols):
                for v in t:
                    pos += [round((v[0] - x0) * 100), round(v[2] * 100), round((v[1] - y0) * 100)]
                col += list(c)
        n_tris = len(col) // 3
        pos_arr = np.clip(np.array(pos, dtype=np.int32), -32768, 32767).astype("<i2")
        pad = (4 - (8 + pos_arr.nbytes) % 4) % 4
        blob = struct.pack("<II", n_tris, len(blist)) + pos_arr.tobytes() + b"\0" * pad + bytes(col)
        (out_dir / "tiles" / f"{i}_{j}.ipr.bin").write_bytes(blob)
        tj = out_dir / "tiles" / f"{i}_{j}.json"
        t = json.loads(tj.read_text())
        t["ipr"] = {"buildings": len(blist), "triangles": n_tris}
        tj.write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")))
        total += len(blob)
    # Tiles that no longer get IPR buildings go back to OSM ones.
    for i, j, _ in index["tiles"]:
        if (i, j) in per_tile:
            continue
        tj = out_dir / "tiles" / f"{i}_{j}.json"
        t = json.loads(tj.read_text())
        if t.pop("ipr", None):
            tj.write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")))
            (out_dir / "tiles" / f"{i}_{j}.ipr.bin").unlink(missing_ok=True)
    index["ipr"] = True
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(per_tile)} tiles with IPR buildings, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main(*sys.argv[1:])
