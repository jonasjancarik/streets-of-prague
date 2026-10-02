"""ČÚZK's DMR 5G: bare-earth heights from airborne laser scanning, as a 2 m raster.

IPR's terrain model (ipr_terrain.py) has a point about every 10 m; DMR 5G's irregular
points are a metre or two apart, with buildings and trees taken out, so slopes, banks
and cuttings keep their shape. ČÚZK serves it resampled through an ArcGIS image service
(heights in Bpv, like IPR's). PROTOTYPE: fetched for a box and kept in
pipeline/.cache/dmr5g/; ipr_terrain.py --dmr5g uses it for the places in BOXES.

Source: DMR 5G © ČÚZK (CC BY 4.0).
"""

import io
from pathlib import Path

import numpy as np
import requests
from pyproj import Transformer
from pyproj.aoi import AreaOfInterest

URL = "https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage"
CACHE = Path(__file__).parent / ".cache" / "dmr5g"
RES = 2.0  # m
# Where it's tried, as (west, south, east, north) in degrees.
BOXES = {"letna": (14.4080, 50.0915, 14.4340, 50.1005)}


def raster(name):
    """(heights with rows from the north, x0, y1) in S-JTSK for a box of BOXES: the
    raster's west and north edges; a cell is RES metres."""
    path = CACHE / f"{name}.npz"
    if path.exists():
        got = np.load(path)
        return got["h"], float(got["x0"]), float(got["y1"])
    import tifffile  # (only to fetch: not among the pipeline's dependencies yet; uv run --with tifffile)
    w, s, e, n = BOXES[name]
    xs, ys = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True, area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2)).transform([w, w, e, e], [s, n, s, n])
    x0, y0 = np.floor(min(xs) / RES) * RES - 20, np.floor(min(ys) / RES) * RES - 20
    x1, y1 = np.ceil(max(xs) / RES) * RES + 20, np.ceil(max(ys) / RES) * RES + 20
    cols, rows = int((x1 - x0) / RES), int((y1 - y0) / RES)
    parts = []
    for r0 in range(0, rows, 2000):  # (the service gives 4100 rows at most)
        r1 = min(rows, r0 + 2000)
        params = {"bbox": f"{x0},{y1 - r1 * RES},{x1},{y1 - r0 * RES}", "bboxSR": 5514, "imageSR": 5514, "size": f"{cols},{r1 - r0}",
                  "format": "tiff", "pixelType": "F32", "interpolation": "RSP_BilinearInterpolation", "f": "image"}
        res = requests.get(URL, params=params, timeout=180)
        res.raise_for_status()
        parts.append(tifffile.imread(io.BytesIO(res.content)).astype(np.float32))
    h = np.concatenate(parts)
    h[(h < 100) | (h > 700)] = np.nan
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, h=h, x0=x0, y1=y1)
    return h, x0, y1


def sampler(name, local):
    """Heights at points in the game's local metres (bilinear; NaN outside the box).
    Through WGS84 with the Czech datum shift: straight from the local projection, which
    has no datum, pyproj skips the shift and everything lands ~25 m off (as in
    ipr_buildings.krovak_to_local)."""
    h, x0, y1 = raster(name)
    to_wgs = Transformer.from_crs(local, "EPSG:4326", always_xy=True)
    to_krovak = Transformer.from_crs("EPSG:4326", "EPSG:5514", always_xy=True, area_of_interest=AreaOfInterest(14.2, 49.9, 14.8, 50.2))

    def at(xs, ys):
        kx, ky = to_krovak.transform(*to_wgs.transform(np.asarray(xs, float), np.asarray(ys, float)))
        u, v = (kx - x0) / RES - 0.5, (y1 - ky) / RES - 0.5  # (cell centres)
        ok = (u >= 0) & (v >= 0) & (u < h.shape[1] - 1) & (v < h.shape[0] - 1)
        i, j = np.clip(u.astype(int), 0, h.shape[1] - 2), np.clip(v.astype(int), 0, h.shape[0] - 2)
        fu, fv = u - i, v - j
        out = (h[j, i] * (1 - fu) + h[j, i + 1] * fu) * (1 - fv) + (h[j + 1, i] * (1 - fu) + h[j + 1, i + 1] * fu) * fv
        return np.where(ok, out, np.nan)
    return at


if __name__ == "__main__":
    for name in BOXES:
        h, x0, y1 = raster(name)
        print(name, h.shape, f"{np.nanmin(h):.1f}–{np.nanmax(h):.1f} m, {np.isnan(h).mean():.1%} missing")
