"""Terrain heights for the tiles made by build_tiles.py, from IPR Praha's open 3D
terrain model (a TIN with ~10 m spacing, CityGML), for hill shading in the game.

    uv run ipr_terrain.py centrum            # after build_tiles.py centrum

Writes tiles/<i>_<j>.height.bin: a (N+1) x (N+1) grid of heights every 4 m across
the tile (N = tile / 4), as little-endian uint16 decimetres above 100 m a.s.l.,
rows from the tile's south edge; and "terrain" in index.json with the grid step.

Source: IPR Praha, 3D model terénu (datový podklad © IPR Praha, CC BY), SMO-5
sheets TER_Prah_<X>-<Y>, downloaded once into pipeline/.cache/ipr/.
"""

import io
import json
import math
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from lxml import etree
from pyproj import Transformer

from build_area import AREAS, OUT
from ipr_buildings import CACHE, ORG, krovak_to_local, sheet

STEP = 4.0
GML = "http://www.opengis.net/gml"


def catalogue():
    path = CACHE / "terrain_catalogue.json"
    if path.exists():
        return json.loads(path.read_text())
    items = {}
    for start in range(1, 1000, 100):
        url = (f"https://www.arcgis.com/sharing/rest/search?q=title%3A%22TER_Prah%22%20AND%20orgid%3A{ORG}"
               f"&num=100&start={start}&f=json")
        d = json.load(urllib.request.urlopen(url))
        for r in d.get("results", []):
            if r["title"].endswith("_gml"):
                items[r["title"][: -len("_gml")]] = r["id"]
        if d.get("nextStart", -1) == -1:
            break
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=1))
    return items


def download(name, items):
    path = CACHE / f"{name}_gml.gml"
    if path.exists():
        return path
    if name not in items:
        return None
    print(f"  downloading {name}…")
    data = urllib.request.urlopen(f"https://www.arcgis.com/sharing/rest/content/items/{items[name]}/data").read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(m for m in z.namelist() if m.lower().endswith(".gml"))
        path.write_bytes(z.read(member))
    return path


def triangles(path):
    """All TIN triangles of a sheet as an (n, 3, 3) array in S-JTSK + height."""
    tris = []
    for _, el in etree.iterparse(str(path), events=("end",), tag=f"{{{GML}}}Triangle", huge_tree=True):
        pl = next(el.iter(f"{{{GML}}}posList"))
        v = np.array(pl.text.split(), dtype=float).reshape(-1, 3)[:3]
        tris.append(v)
        el.clear()
    return np.array(tris)


def rasterise(tris, x0, y0, nx, ny, step, grid):
    """Barycentric fill of the grid (heights at x0 + i*step, y0 + j*step)."""
    for a, b, c in tris:
        xs, ys = (a[0], b[0], c[0]), (a[1], b[1], c[1])
        i0, i1 = max(0, math.ceil((min(xs) - x0) / step)), min(nx - 1, math.floor((max(xs) - x0) / step))
        j0, j1 = max(0, math.ceil((min(ys) - y0) / step)), min(ny - 1, math.floor((max(ys) - y0) / step))
        if i0 > i1 or j0 > j1:
            continue
        gx, gy = np.meshgrid(x0 + np.arange(i0, i1 + 1) * step, y0 + np.arange(j0, j1 + 1) * step)
        d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
        if abs(d) < 1e-9:
            continue
        l1 = ((b[1] - c[1]) * (gx - c[0]) + (c[0] - b[0]) * (gy - c[1])) / d
        l2 = ((c[1] - a[1]) * (gx - c[0]) + (a[0] - c[0]) * (gy - c[1])) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        z = l1 * a[2] + l2 * b[2] + l3 * c[2]
        sub = grid[j0:j1 + 1, i0:i1 + 1]
        sub[inside] = z[inside]


def main(area: str = "centrum") -> None:
    out_dir = OUT / f"{area}_now"
    index = json.loads((out_dir / "index.json").read_text())
    w, s, e, n = AREAS[area]
    T = index["tile"]
    ox, oy = index["origin"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m"
    to_local = krovak_to_local(local)
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True)
    corners = [sheet(*to_krovak.transform(lon, lat)) for lon in (w, e) for lat in (s, n)]
    items = catalogue()

    # Heights on one 4 m lattice over the area (x = -ox + i * STEP), kept per tile and
    # filled sheet by sheet, so memory follows the tiles that exist, not the bbox.
    N = int(T // STEP)
    gx0, gy0 = -ox, -oy
    tiles = {(i, j): np.full((N + 1, N + 1), np.nan, dtype=np.float32) for i, j, _ in index["tiles"]}
    lo, hi = math.inf, -math.inf
    for X in range(min(c[0] for c in corners), max(c[0] for c in corners) + 1):
        for Y in range(min(c[1] for c in corners), max(c[1] for c in corners) + 1):
            path = download(f"TER_Prah_{X}-{Y}", items)
            if not path:
                print(f"  TER_Prah_{X}-{Y}: not in the catalogue")
                continue
            tris = triangles(path)
            flat = tris.reshape(-1, 3)
            lx, ly = to_local.transform(flat[:, 0], flat[:, 1])
            tris = np.column_stack([lx, ly, flat[:, 2]]).reshape(-1, 3, 3)
            gi0, gi1 = math.floor((lx.min() - gx0) / STEP), math.ceil((lx.max() - gx0) / STEP)
            gj0, gj1 = math.floor((ly.min() - gy0) / STEP), math.ceil((ly.max() - gy0) / STEP)
            sub = np.full((gj1 - gj0 + 1, gi1 - gi0 + 1), np.nan)
            rasterise(tris, gx0 + gi0 * STEP, gy0 + gj0 * STEP, sub.shape[1], sub.shape[0], STEP, sub)
            lo, hi = min(lo, np.nanmin(sub)), max(hi, np.nanmax(sub))
            for (i, j), arr in tiles.items():
                ci, cj = int(round(i * T / STEP)), int(round(j * T / STEP))
                a0, a1 = max(ci, gi0), min(ci + N, gi1)
                b0, b1 = max(cj, gj0), min(cj + N, gj1)
                if a0 > a1 or b0 > b1:
                    continue
                part = sub[b0 - gj0:b1 - gj0 + 1, a0 - gi0:a1 - gi0 + 1]
                view = arr[b0 - cj:b1 - cj + 1, a0 - ci:a1 - ci + 1]
                ok = ~np.isnan(part)
                view[ok] = part[ok]
            print(f"  TER_Prah_{X}-{Y}: {len(tris)} triangles")
    if lo == math.inf:
        print("no terrain")
        return
    # Anything no sheet covers gets the area's mean height: flat, so unshaded.
    known = np.concatenate([a[~np.isnan(a)] for a in tiles.values()])
    mean = float(known.mean()) if known.size else lo
    for (i, j), arr in tiles.items():
        arr[np.isnan(arr)] = mean
        dm = np.clip(np.round((arr - 100) * 10), 0, 65535).astype("<u2")
        (out_dir / "tiles" / f"{i}_{j}.height.bin").write_bytes(dm.tobytes())
    index["terrain"] = {"step": STEP, "n": N + 1, "min": float(lo), "max": float(hi)}
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")))
    print(f"terrain {lo:.0f}–{hi:.0f} m for {len(index['tiles'])} tiles")


if __name__ == "__main__":
    main(*sys.argv[1:])
