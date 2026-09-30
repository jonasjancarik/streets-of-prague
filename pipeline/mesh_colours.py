"""The real colours of IPR's buildings, measured on IPR's photorealistic 3D mesh.

For each tile with IPR buildings this takes the mesh over it (photomesh.py, level 13,
about 20-25 cm per pixel on facades) and looks at it two ways:

- from above: an orthographic colour and height raster of the tile, where the
  highest surface wins, for the roofs;
- from beside each wall: points on a grid over every wall of IPR's city model, moved
  1.5 m out along the wall's normal (the mesh sits up to a metre in front of the
  model's walls), and the colour where a ray from there back towards the wall meets
  the mesh.

Only colours and material classes leave this step; the game keeps drawing its own
procedural roofs and facades in them.

    uv run mesh_colours.py ujezd --tiles 2_0 --debug     one tile, with debug images

Needs the area's tiles (build_tiles.py) and IPR's sheets parsed (ipr_buildings.py).
The mesh's files are kept in pipeline/.cache/mesh/, debug images go to
pipeline/.cache/mesh_colours/<area>/.
"""

import argparse
import os
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

import ipr_buildings as ipr
import layers
import photomesh as pm

LEVEL = 13
RES = 0.2  # the top raster's pixel, m
OUT_DIR = Path(__file__).parent / ".cache" / "mesh_colours"

# Wall samples: a point every WALL_STEP m over each wall, looked at from WALL_OUT m out
# along its normal, as far as WALL_REACH m back in.
WALL_STEP = 0.75
WALL_OUT = 1.5
WALL_REACH = 3.0


@dataclass
class Mesh:
    """The mesh's triangles over a piece of the area: positions in the area's local
    metres (x east, y north, height above ipr.REF_HEIGHT), UVs, and which atlas each
    triangle is textured from."""

    tris: np.ndarray  # (n, 3, 3)
    uv: np.ndarray  # (n, 3, 2)
    tex: np.ndarray  # (n,) index into atlases
    atlases: list

    def colour(self, which, uv):
        """Colours (k, 3) uint8 at `uv` (k, 2) on the atlases `which` (k,)."""
        out = np.zeros((len(which), 3), np.uint8)
        for k in np.unique(which):
            sel = which == k
            a = self.atlases[k]
            h, w = a.shape[:2]
            px = np.clip((uv[sel, 0] * w).astype(int), 0, w - 1)
            py = np.clip((uv[sel, 1] * h).astype(int), 0, h - 1)
            out[sel] = a[py, px]
        return out


def load_mesh(crs: str, bounds, level: int = LEVEL, margin: float = 5.0) -> Mesh:
    """The mesh's triangles whose middles are within `bounds` (local x0, y0, x1, y1)
    widened by `margin`."""
    x0, y0, x1, y1 = bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin
    to3857 = Transformer.from_crs(crs, "EPSG:3857", always_xy=True)
    back = Transformer.from_crs("EPSG:3857", crs, always_xy=True)
    xs, ys = to3857.transform([x0, x1, x0, x1], [y0, y0, y1, y1])
    nodes = pm.nodes_over((min(xs), min(ys), max(xs), max(ys)), level)
    pm.prefetch(nodes)
    tris, uvs, tex, atlases = [], [], [], []
    for n in nodes:
        pos, uv = pm.triangles(n)
        x, y = back.transform(pos[:, 0], pos[:, 1])
        p = np.column_stack((x, y, pos[:, 2] - ipr.REF_HEIGHT)).reshape(-1, 3, 3)
        c = p.mean(1)
        keep = (c[:, 0] >= x0) & (c[:, 0] <= x1) & (c[:, 1] >= y0) & (c[:, 1] <= y1)
        if not keep.any():
            continue
        tris.append(p[keep])
        uvs.append(uv.reshape(-1, 3, 2)[keep])
        tex.append(np.full(keep.sum(), len(atlases)))
        atlases.append(pm.texture(n))
    if not tris:
        return Mesh(np.empty((0, 3, 3)), np.empty((0, 3, 2)), np.empty(0, int), [])
    return Mesh(np.concatenate(tris), np.concatenate(uvs), np.concatenate(tex), atlases)


def rasterize(tris: np.ndarray, x0: float, y0: float, size: float, res: float = RES):
    """Which of `tris` (local metres) is highest over each pixel of the square from
    (x0, y0) of `size` m, seen straight from above: triangle index (-1 for none),
    barycentric weights and height, each per pixel, row 0 at the north edge. Walls,
    seen edge on, are left out."""
    w = int(round(size / res))
    height = np.full(w * w, -np.inf)
    which = np.full(w * w, -1)
    weights = np.zeros((w * w, 3))
    t = tris
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    up = np.abs(nrm[:, 2]) / np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)
    keep = np.nonzero(up > 0.1)[0]
    # Pixel coordinates: column from the west edge, row from the north edge.
    gx = (t[keep, :, 0] - x0) / res - 0.5
    gy = (y0 + size - t[keep, :, 1]) / res - 0.5
    lo_x = np.clip(np.floor(gx.min(1)).astype(int), 0, w - 1)
    hi_x = np.clip(np.ceil(gx.max(1)).astype(int), 0, w - 1)
    lo_y = np.clip(np.floor(gy.min(1)).astype(int), 0, w - 1)
    hi_y = np.clip(np.ceil(gy.max(1)).astype(int), 0, w - 1)
    bw, bh = hi_x - lo_x + 1, hi_y - lo_y + 1
    # Batches of triangles of similar size, each tested against its bounding box.
    order = np.argsort(bw * bh)
    start = 0
    while start < len(order):
        end = start + 1
        cw, ch = bw[order[start]], bh[order[start]]
        while end < len(order):
            nw, nh = max(cw, bw[order[end]]), max(ch, bh[order[end]])
            if (end - start + 1) * nw * nh > 4_000_000:
                break
            cw, ch, end = nw, nh, end + 1
        idx = order[start:end]
        ox, oy = np.meshgrid(np.arange(cw), np.arange(ch))
        px = lo_x[idx, None] + ox.ravel()[None]
        py = lo_y[idx, None] + oy.ravel()[None]
        ax, ay = gx[idx, 0, None], gy[idx, 0, None]
        bx, by = gx[idx, 1, None], gy[idx, 1, None]
        cx, cy = gx[idx, 2, None], gy[idx, 2, None]
        det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        det = np.where(np.abs(det) < 1e-12, 1e-12, det)
        l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det
        l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6) & (px < w) & (py < w)
        k, s = np.nonzero(inside)
        if len(k):
            tri = keep[idx[k]]
            b = np.column_stack((l1[k, s], l2[k, s], l3[k, s]))
            z = (b * t[tri, :, 2]).sum(1)
            pix = py[k, s] * w + px[k, s]
            # The highest surface per pixel in this batch, then against what's there.
            o = np.lexsort((z, pix))
            o = o[np.r_[pix[o][1:] != pix[o][:-1], True]]
            better = z[o] > height[pix[o]]
            o = o[better]
            height[pix[o]], which[pix[o]], weights[pix[o]] = z[o], tri[o], b[o]
        start = end
    height[which < 0] = np.nan
    return which, weights, height


def top_view(mesh: Mesh, x0: float, y0: float, size: float, res: float = RES):
    """The mesh seen straight from above over the square from (x0, y0) of `size` m:
    colour (h, w, 3) uint8 and height (h, w), NaN where there's nothing."""
    which, b, height = rasterize(mesh.tris, x0, y0, size, res)
    w = int(round(size / res))
    colour = np.zeros((w * w, 3), np.uint8)
    got = which >= 0
    uv = (b[got, :, None] * mesh.uv[which[got]]).sum(1)
    colour[got] = mesh.colour(mesh.tex[which[got]], uv)
    return colour.reshape(w, w, 3), height.reshape(w, w)


def lattice(tris: np.ndarray, step: float):
    """Points spread evenly over each triangle, about `step` m apart: the middles of its
    n × n sub-triangles. Returns the points (k, 3), the triangle each is on and the
    area each stands for."""
    area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
    # Sub-triangles of about step² / 2 each, so thin slivers don't get a crowd of points.
    ns = np.maximum(1, np.ceil(np.sqrt(2 * area) / step).astype(int))
    pts, owner, weight = [], [], []
    for n in np.unique(ns):
        sel = np.nonzero(ns == n)[0]
        # Barycentric middles of the sub-triangles, upright and upside-down ones.
        bary = [((a + 1 / 3) / n, (b + 1 / 3) / n) for a in range(n) for b in range(n - a)]
        bary += [((a + 2 / 3) / n, (b + 2 / 3) / n) for a in range(n - 1) for b in range(n - 1 - a)]
        bary = np.array(bary)
        l = np.column_stack((bary, 1 - bary.sum(1)))
        p = np.einsum("kj,tjc->tkc", l, tris[sel])
        pts.append(p.reshape(-1, 3))
        owner.append(np.repeat(sel, len(l)))
        weight.append(np.repeat(area[sel] / (n * n), len(l)))
    if not pts:
        return np.empty((0, 3)), np.empty(0, int), np.empty(0)
    return np.concatenate(pts), np.concatenate(owner), np.concatenate(weight)


class RayGrid:
    """The mesh's triangles by square cells of x/y, to cast short horizontal rays at."""

    def __init__(self, mesh: Mesh, cell: float = 2.0):
        self.mesh, self.cell = mesh, cell
        t = mesh.tris
        lo = np.floor(t[:, :, :2].min(1) / cell).astype(int)
        hi = np.floor(t[:, :, :2].max(1) / cell).astype(int)
        self.origin = lo.min(0) if len(t) else np.zeros(2, int)
        self.cols = (hi.max(0)[0] - self.origin[0] + 1) if len(t) else 1
        # Every cell of each triangle's bounding box.
        nx, ny = hi[:, 0] - lo[:, 0] + 1, hi[:, 1] - lo[:, 1] + 1
        count = nx * ny
        owners = np.repeat(np.arange(len(t)), count)
        k = np.arange(count.sum()) - np.repeat(np.cumsum(count) - count, count)
        cx = lo[owners, 0] + k % nx[owners] - self.origin[0]
        cy = lo[owners, 1] + k // nx[owners] - self.origin[1]
        cells = cy * self.cols + cx
        o = np.argsort(cells, kind="stable")
        self.cells, self.owners = cells[o], owners[o]

    def cast(self, start: np.ndarray, direction: np.ndarray, reach: float):
        """The first mesh triangle each horizontal ray meets within `reach`: triangle
        index (-1 for none), distance and barycentric (u, v)."""
        n = len(start)
        best_t = np.full(n, np.inf)
        best_k = np.full(n, -1)
        best_uv = np.zeros((n, 2))
        if not len(self.cells) or not n:
            return best_k, best_t, best_uv
        # The cells along each ray, a few steps along it.
        steps = np.linspace(0, reach, int(np.ceil(reach / (self.cell / 2))) + 1)
        xy = start[:, None, :2] + direction[:, None, :2] * steps[None, :, None]
        c = np.floor(xy / self.cell).astype(int) - self.origin
        ok = (c[..., 0] >= 0) & (c[..., 0] < self.cols) & (c[..., 1] >= 0)
        cell = np.where(ok, c[..., 1] * self.cols + c[..., 0], -1)
        ray = np.repeat(np.arange(n), len(steps))
        cell = cell.ravel()
        pairs = np.unique(np.column_stack((ray, cell))[cell >= 0], axis=0)
        a = np.searchsorted(self.cells, pairs[:, 1], "left")
        b = np.searchsorted(self.cells, pairs[:, 1], "right")
        cnt = b - a
        rays = np.repeat(pairs[:, 0], cnt)
        pos = np.repeat(a - np.cumsum(np.r_[0, cnt[:-1]]), cnt) + np.arange(cnt.sum())
        tri = self.owners[pos]
        # A triangle can be in several of a ray's cells.
        rt = np.unique(np.column_stack((rays, tri)), axis=0)
        for chunk in np.array_split(rt, max(1, len(rt) // 2_000_000 + 1)):
            r, k = chunk[:, 0], chunk[:, 1]
            t = self.mesh.tris[k]
            o, d = start[r], direction[r]
            e1, e2 = t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]
            p = np.cross(d, e2)
            det = (e1 * p).sum(1)
            good = np.abs(det) > 1e-9
            inv = 1 / np.where(good, det, 1)
            s = o - t[:, 0]
            u = (s * p).sum(1) * inv
            q = np.cross(s, e1)
            v = (d * q).sum(1) * inv
            dist = (e2 * q).sum(1) * inv
            hit = good & (u >= 0) & (v >= 0) & (u + v <= 1) & (dist >= 0) & (dist <= reach)
            r, k, dist, u, v = r[hit], k[hit], dist[hit], u[hit], v[hit]
            if not len(r):
                continue
            o = np.lexsort((dist, r))
            first = np.r_[True, r[o][1:] != r[o][:-1]]
            o = o[first]
            r, k, dist, u, v = r[o], k[o], dist[o], u[o], v[o]
            closer = dist < best_t[r]
            r, k, dist, u, v = r[closer], k[closer], dist[closer], u[closer], v[closer]
            best_t[r], best_k[r] = dist, k
            best_uv[r] = np.column_stack((u, v))
        return best_k, best_t, best_uv


def wall_samples(mesh: Mesh, grid: RayGrid, tris: np.ndarray, wanted=None):
    """Where the walls `tris` (k, 3, 3, local metres) meet the mesh: for each sample
    point on them, the wall triangle it's on, its point, the area it stands for, its
    colour and the mesh's normal there. Points whose ray met nothing are left out, and
    so are the ones `wanted(points, outward normals)` says no to, before any ray."""
    pts, owner, weight = lattice(tris, WALL_STEP)
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    nrm[:, 2] = 0  # rays go level, straight at the wall
    ln = np.linalg.norm(nrm, axis=1)
    nrm = nrm / np.maximum(ln, 1e-12)[:, None]
    ok = ln[owner] > 1e-9
    pts, owner, weight = pts[ok], owner[ok], weight[ok]
    if wanted is not None and len(pts):
        ok = wanted(pts, nrm[owner])
        pts, owner, weight = pts[ok], owner[ok], weight[ok]
    d = -nrm[owner]
    k, _, bary = grid.cast(pts - d * WALL_OUT, d, WALL_REACH)
    got = k >= 0
    k, bary = k[got], bary[got]
    uv = mesh.uv[k]
    uvh = uv[:, 0] * (1 - bary.sum(1))[:, None] + uv[:, 1] * bary[:, :1] + uv[:, 2] * bary[:, 1:]
    colour = mesh.colour(mesh.tex[k], uvh)
    t = mesh.tris[k]
    mn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    mn /= np.maximum(np.linalg.norm(mn, axis=1), 1e-12)[:, None]
    return owner[got], pts[got], weight[got], colour, mn


def tile_buildings(area: str, meta: dict, wanted: set):
    """IPR's buildings of the tiles `wanted` ((i, j) pairs), as read_sheet gives them:
    (gml id, (i, j), positions, codes, footprints), in the order the tiles get them."""
    _, jobs = ipr.sheet_jobs(area, meta)
    out = {}
    for job in jobs:
        _, found = ipr.read_sheet(job)
        for bid, _, _, ij, pos, codes, fp in found:
            if ij in wanted and pos is not None:
                out.setdefault(ij, []).append((bid, pos, codes, fp))
    return out


def unpack(pos: np.ndarray, ij, meta: dict) -> np.ndarray:
    """A building's triangles from read_sheet's packing into local metres (k, 3, 3),
    (x east, y north, height above ipr.REF_HEIGHT)."""
    T, (ox, oy) = meta["tile"], meta["origin"]
    v = pos.reshape(-1, 3).astype(np.float64) / 100
    return np.column_stack((v[:, 0] + ij[0] * T - ox, v[:, 2] + ij[1] * T - oy, v[:, 1])).reshape(-1, 3, 3)


def lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (k, 3) 0-255 → CIELAB (k, 3), D65."""
    c = np.asarray(rgb, np.float64).reshape(-1, 3) / 255
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = c @ np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]).T
    xyz /= [0.95047, 1.0, 1.08883]
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.column_stack((116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])))


def rgb(c: np.ndarray) -> np.ndarray:
    """CIELAB (k, 3) → sRGB (k, 3) uint8."""
    L, a, b = np.atleast_2d(c).T
    fy = (L + 16) / 116
    f = np.column_stack((fy + a / 500, fy, fy - b / 200))
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * [0.95047, 1.0, 1.08883]
    s = xyz @ np.array([[3.2406, -1.5372, -0.4986], [-0.9689, 1.8758, 0.0415], [0.0557, -0.2040, 1.0570]]).T
    s = np.where(s <= 0.0031308, 12.92 * s, 1.055 * np.clip(s, 0, None) ** (1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)


def hexc(c) -> str:
    return "#%02x%02x%02x" % tuple(int(v) for v in rgb(c)[0])


# The dominant colour: samples binned in L*a*b*, the fullest bin (with its neighbours),
# and the median of the samples near it.
BIN = 5.0
NEAR = 8.0


def dominant(labs: np.ndarray, weight: np.ndarray):
    """The colour most of a surface is (L*a*b*), and the share of the samples (by
    weight) near it. Windows, shadows under eaves, chimneys and the odd tree are
    minorities and drop out; a dark or glass building stays dark or glass."""
    if not len(labs) or weight.sum() <= 0:
        return None, 0.0
    q = np.floor(labs / BIN).astype(int)
    keys, inv = np.unique(q, axis=0, return_inverse=True)
    mass = np.bincount(inv.ravel(), weight, len(keys))
    # Each bin with its 26 neighbours, so a colour on a bin edge isn't split.
    lookup = {tuple(k): m for k, m in zip(keys.tolist(), mass)}
    offs = [(i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1)]
    smooth = [sum(lookup.get((x + i, y + j, z + k), 0.0) for i, j, k in offs) for x, y, z in keys.tolist()]
    centre = (keys[int(np.argmax(smooth))] + 0.5) * BIN
    near = np.linalg.norm(labs - centre, axis=1) < NEAR
    for _ in range(2):  # settle on the samples' own middle
        centre = np.median(labs[near], axis=0)
        near = np.linalg.norm(labs - centre, axis=1) < NEAR
    if not near.any():
        return None, 0.0
    return np.median(labs[near], axis=0), float(weight[near].sum() / weight.sum())


# Roof material classes, by the roof's measured colour (L*a*b*).
COPPER_A = -5.0  # a* below this, with some chroma: green-cyan patina
COPPER_CHROMA = 6.0
TILE_CHROMA = 12.0  # warm (a*, b* > 0) with at least this much chroma: clay tiles
SLATE_L = 50.0  # grey roofs darker than this are slate, lighter ones sheet metal
MATERIALS = ("tiles", "slate", "metal", "copper", "flat")


def material(c, flat: bool) -> str:
    if flat:
        return "flat"
    L, a, b = c
    chroma = float(np.hypot(a, b))
    if a < COPPER_A and chroma > COPPER_CHROMA:
        return "copper"
    if a > 0 and b > 0 and chroma >= TILE_CHROMA:
        return "tiles"
    return "slate" if L < SLATE_L else "metal"


# When a measurement is too unsure to use: fewer samples than MIN_SAMPLES, or the
# dominant colour holding less than MIN_SHARE of them.
MIN_SAMPLES = 40
MIN_SHARE = 0.4
GROUND_FLOOR = 3.0  # m; shop fronts, cars and people are below
TREE_REACH = 4.0  # m round IPR's trees where walls aren't sampled
ROOF_SHRINK = 2  # pixels (0.4 m) off each roof face's edge
ROOF_GAP = 1.0  # m; mesh pixels further than this from the roof plane are something else
FACES = 4096  # roof faces per building, for packing (building, face) in one number

# The light in the photographs, estimated by `--calibrate` on centrum (every 6th tile,
# 38 tiles, 2026-09-30): the sun was in the east-south-east and low (a summer
# morning); a surface's brightness goes with how squarely it faces the sun (x, the
# cosine, 0 when facing away) as SUN * x + SKY, fitted on 5,450 clay tile roof faces
# (R² 0.60). Shadows are nearly black: a wall in shade would need about ten times the
# light, and between buildings anything from 4 to 23 times, far too loose to recover
# its colour, so walls seen only in shade count as unsure. Walls facing the sun more
# than LIT (cosine, level) are lit, facing away more than that shaded.
SUN_AZIMUTH = 100.0  # degrees from north
SUN_ELEVATION = 32.5
SUN, SKY = 0.88, 0.12
LIT = 0.3
ROOF_LIT = 0.15  # roof faces meeting the sun less squarely than this are in shade
# The camera's cast and the haze, one correction for the whole city (see calibrate): a
# gain per channel (linear RGB) that brings the median clay tile roof nearest
# TILE_REFERENCE and the median plaster wall nearest PLASTER_REFERENCE, both after the
# light is taken out, then CHROMA times the colourfulness (L*a*b* a* and b*), which
# the haze took, to give the median tile roof the reference's. No offset: fitted on two
# light colours, one pushed dark roofs and walls to black.
TILE_REFERENCE = "#ab5f48"  # the middle of the game's old tile palette
PLASTER_REFERENCE = "#ddd3bf"  # a light, slightly warm plaster
BALANCE_GAIN = (0.803, 0.751, 0.693)
CHROMA = 1.28


def sun_vector(az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION) -> np.ndarray:
    az, el = np.radians(az), np.radians(el)
    return np.array([np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)])


def unlight(labs: np.ndarray, normals: np.ndarray, az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION) -> np.ndarray:
    """Colours (k, 3 L*a*b*) measured on surfaces with these normals (k, 3), as they'd
    be facing the sun squarely."""
    x = np.maximum(0.0, np.atleast_2d(normals) @ sun_vector(az, el))
    gain = (SUN + SKY) / (SUN * x + SKY)
    return lab(linear_rgb(labs_linear(labs) * gain[:, None]))


def roof_faces(t: np.ndarray, codes: np.ndarray) -> np.ndarray:
    """Groups a building's roof triangles into planes: a face number per triangle,
    -1 for walls."""
    face = np.full(len(t), -1)
    planes = []
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)[:, None]
    for k in np.nonzero(codes != 0)[0]:
        d = nrm[k] @ t[k, 0]
        for f, (n, dd) in enumerate(planes):
            if n @ nrm[k] > 0.995 and abs(dd - d) < 0.3:
                face[k] = f
                break
        else:
            face[k] = len(planes)
            planes.append((nrm[k], d))
    return face


def labs_linear(c) -> np.ndarray:
    """L*a*b* (k, 3) → linear RGB (k, 3), 0-1."""
    s = rgb(c) / 255
    return np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)


def linear_rgb(lin) -> np.ndarray:
    """Linear RGB (k, 3), 0-1 → sRGB 0-255 (float, for lab())."""
    s = np.clip(lin, 0, 1)
    return np.where(s <= 0.0031308, 12.92 * s, 1.055 * s ** (1 / 2.4) - 0.055) * 255


def balance(c: np.ndarray) -> np.ndarray:
    """Takes the camera's cast and haze out of colours (k, 3 L*a*b*)."""
    out = lab(linear_rgb(labs_linear(c) * np.array(BALANCE_GAIN)))
    out[:, 1:] *= CHROMA
    return out


def sample_tile(meta, ij, blds, mesh: Mesh, trees: np.ndarray, debug: bool = False):
    """What the mesh shows of a tile's buildings, before anything depends on the light:
    per building its wall samples (outward normal, L*a*b*, weight) and per roof face
    its dominant colour as seen. With `debug`, also the top raster and the roof faces'
    pixels."""
    import shapely
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    w = int(round(T / RES))
    tris = [unpack(pos, ij, meta) for _, pos, _, _ in blds]
    # Roofs from above: the mesh and IPR's own roofs, pixel by pixel.
    which, weights, mesh_z = rasterize(mesh.tris, x0, y0, T)
    got = which >= 0
    colour = np.zeros((len(which), 3), np.uint8)
    colour[got] = mesh.colour(mesh.tex[which[got]], (weights[got, :, None] * mesh.uv[which[got]]).sum(1))
    roofs, owner, faces = [], [], []
    for b, ((_, _, codes, _), t) in enumerate(zip(blds, tris)):
        f = roof_faces(t, codes)
        sel = codes != 0
        roofs.append(t[sel])
        owner.append(b * FACES + f[sel])
        faces.append(f)
    roofs = np.concatenate(roofs) if roofs else np.empty((0, 3, 3))
    owner = np.concatenate(owner) if owner else np.empty(0, int)
    rw, _, roof_z = rasterize(roofs, x0, y0, T)
    # A face number for each pixel, shrunk off its edges.
    fid = np.where(rw >= 0, owner[np.maximum(rw, 0)] if len(owner) else -1, -1).reshape(w, w)
    core = fid >= 0
    pad = np.pad(fid, ROOF_SHRINK, constant_values=-1)
    for dy in range(2 * ROOF_SHRINK + 1):
        for dx in range(2 * ROOF_SHRINK + 1):
            core &= pad[dy:dy + w, dx:dx + w] == fid
    core = core.ravel() & got & (np.abs(mesh_z - roof_z) < ROOF_GAP)
    pix_face = fid.ravel()[core]
    pix_lab = lab(colour[core])
    order = np.argsort(pix_face, kind="stable")
    pix_face, pix_lab = pix_face[order], pix_lab[order]
    cuts = np.r_[0, np.nonzero(np.diff(pix_face))[0] + 1, len(pix_face)]
    roof_samples = {int(pix_face[a]): pix_lab[a:b] for a, b in zip(cuts[:-1], cuts[1:]) if b > a}

    # Walls: what's outside a party wall is the neighbour, and trees stand in front of some.
    footprints = [g for _, _, _, fp in blds for g in fp]
    party = shapely.union_all([g.buffer(0.3) for g in footprints]) if footprints else None
    tree_index = shapely.STRtree(shapely.points(trees)) if len(trees) else None
    grid = RayGrid(mesh)
    out = []
    for b, ((bid, _, codes, _), t) in enumerate(zip(blds, tris)):
        base = t[:, :, 2].min()
        wt = t[codes == 0]
        rec = {"id": bid, "walls": None, "roofs": []}
        if len(wt):

            def wanted(p, n, base=base):
                keep = p[:, 2] - base >= GROUND_FLOOR
                if party is not None and keep.any():
                    outside = p[:, :2] + n[:, :2] * WALL_OUT
                    keep &= ~shapely.contains_xy(party, outside[:, 0], outside[:, 1])
                if tree_index is not None and keep.any():
                    idx = np.nonzero(keep)[0]
                    near = tree_index.query(shapely.points(p[idx, :2]), predicate="dwithin", distance=TREE_REACH)[0]
                    keep[idx[np.unique(near)]] = False
                return keep

            tri, p, wgt, c, mn = wall_samples(mesh, grid, wt, wanted)
            wn = np.cross(wt[:, 1] - wt[:, 0], wt[:, 2] - wt[:, 0])[:, :2]
            wn /= np.maximum(np.linalg.norm(wn, axis=1), 1e-12)[:, None]
            # Where the mesh turns away from the wall, the ray met something else.
            keep = (mn[:, :2] * wn[tri]).sum(1) > 0.5
            rec["walls"] = (wn[tri[keep]], lab(c[keep]), wgt[keep])
        f = faces[b]
        for face in np.unique(f[f >= 0]):
            labs = roof_samples.get(b * FACES + int(face), np.empty((0, 3)))
            dom, share = dominant(labs, np.ones(len(labs)))
            ft = t[f == face]
            fn = np.cross(ft[:, 1] - ft[:, 0], ft[:, 2] - ft[:, 0]).sum(0)
            rec["roofs"].append({"face": int(face), "tris": np.nonzero(f == face)[0], "raw": dom, "share": share,
                                 "n": len(labs), "normal": fn / max(np.linalg.norm(fn), 1e-12),
                                 "flat": bool((codes[f == face] == 2).all())})
        out.append(rec)
    return {"buildings": out, "top": colour.reshape(w, w, 3) if debug else None, "fid": fid if debug else None}


def summarise(sampled, az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION, balanced: bool = True):
    """The colours of a tile's buildings from its samples (sample_tile): per building
    the walls' colour and per roof face its colour and material, each with how sure it
    is, the light (and with `balanced`, the camera's cast) taken out."""
    out = []
    for b in sampled["buildings"]:
        rec = {"id": b["id"], "wall": None, "roofs": []}
        if b["walls"] is not None:
            wn, labs, wgt = b["walls"]
            # Sun or shade by which way the wall faces, never by how dark it is, or a dark
            # building would be brightened as "shaded". Only lit walls are measured.
            lit = wn @ np.array([np.sin(np.radians(az)), np.cos(np.radians(az))]) > LIT
            dom, share = None, 0.0
            if lit.any():
                normals = np.column_stack((wn[lit], np.zeros(lit.sum())))
                dom, share = dominant(unlight(labs[lit], normals, az, el), wgt[lit])
            n = int(lit.sum())
            if dom is not None and balanced:
                dom = balance(dom)[0]
            rec["wall"] = {"lab": dom, "share": share, "n": n, "sure": dom is not None and n >= MIN_SAMPLES and share >= MIN_SHARE}
        for f in b["roofs"]:
            dom = f["raw"]
            if dom is not None:
                dom = unlight(dom, f["normal"], az, el)[0]
                if balanced:
                    dom = balance(dom)[0]
            # A face in its own shade is as unsure as a wall in shade.
            lit = float(f["normal"] @ sun_vector(az, el)) > ROOF_LIT
            rec["roofs"].append(dict(f, lab=dom, material=material(dom, f["flat"]) if dom is not None else None,
                                     sure=dom is not None and lit and f["n"] >= MIN_SAMPLES and f["share"] >= MIN_SHARE))
        out.append(rec)
    return out


def debug_tile(meta: dict, ij, blds, colour, fid, measured, out: Path):
    """Two pictures of the tile side by side: the mesh from above, and IPR's buildings
    in the colours measured for them (roof faces filled, walls as a thick outline;
    unsure roofs striped grey, unsure walls magenta)."""
    from PIL import ImageDraw
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    w = colour.shape[0]
    img = np.full((w, w, 3), 40, np.uint8)
    stripes = ((np.arange(w)[:, None] + np.arange(w)[None]) // 6 % 2).astype(bool)
    faces = {b * FACES + r["face"]: r for b, rec in enumerate(measured) for r in rec["roofs"]}
    for key in np.unique(fid[fid >= 0]):
        r = faces.get(int(key))
        m = fid == key
        if r and r["sure"]:
            img[m] = rgb(r["lab"])[0]
        else:
            img[m & stripes] = (150, 150, 150)
            img[m & ~stripes] = (90, 90, 90)
    right = Image.fromarray(img)
    draw = ImageDraw.Draw(right)

    def px(x, y):
        return (x - x0) / RES, (y0 + T - y) / RES

    for (_, _, _, fp), rec in zip(blds, measured):
        wall = rec["wall"]
        c = tuple(int(v) for v in rgb(wall["lab"])[0]) if wall and wall["sure"] else (255, 0, 255)
        for g in fp:
            for poly in getattr(g, "geoms", [g]):
                if poly.geom_type == "Polygon":
                    draw.line([px(x, y) for x, y in poly.exterior.coords], fill=c, width=6)
    both = Image.new("RGB", (w * 2 + 8, w), (255, 255, 255))
    both.paste(Image.fromarray(colour), (0, 0))
    both.paste(right, (w + 8, 0))
    out.parent.mkdir(parents=True, exist_ok=True)
    both.save(out)
    print(f"  {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("area")
    ap.add_argument("--tiles", nargs="*", help="only these tiles (i_j)")
    ap.add_argument("--debug", action="store_true", help="write a debug image and a table per tile")
    ap.add_argument("--calibrate", action="store_true", help="estimate the sun and the shade correction instead")
    ap.add_argument("--every", type=int, default=1, help="with --calibrate: only every n-th tile")
    ap.add_argument("--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 2)), help="tiles measured side by side")
    a = ap.parse_args()
    meta = layers.read_meta(a.area)
    if not meta:
        raise SystemExit(f"{a.area}: run build_tiles.py {a.area} first")
    wanted = {tuple(map(int, t.split("_"))) for t in a.tiles} if a.tiles else {(i, j) for i, j, _ in layers.tiles(a.area, meta)}
    by_tile = tile_buildings(a.area, meta, wanted)
    trees = area_trees(meta)
    tiles = sorted(by_tile)[::a.every] if a.calibrate else sorted(by_tile)
    started = time.perf_counter()
    sampled = {}
    for ij, s, took in sample_tiles(meta, {ij: by_tile[ij] for ij in tiles}, trees, a.jobs, a.debug):
        if a.calibrate:
            sampled[ij] = s
            continue
        measured = summarise(s)
        walls = sum(1 for r in measured if r["wall"] and r["wall"]["sure"])
        roofs = [f for r in measured for f in r["roofs"]]
        print(f"{ij[0]}_{ij[1]}: walls measured for {walls} of {len(measured)} buildings, "
              f"{sum(f['sure'] for f in roofs)} of {len(roofs)} roof faces ({took:.0f} s)", flush=True)
        if a.debug:
            name = f"{ij[0]}_{ij[1]}"
            debug_tile(meta, ij, by_tile[ij], s["top"], s["fid"], measured, OUT_DIR / a.area / f"{name}.png")
            (OUT_DIR / a.area / f"{name}.tsv").write_text(table(measured))
    print(f"{len(tiles)} tiles in {time.perf_counter() - started:.0f} s")
    if a.calibrate:
        calibrate(sampled)


def sample_job(job):
    meta, ij, blds, trees, debug = job
    started = time.perf_counter()
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    allt = np.concatenate([unpack(pos, ij, meta) for _, pos, _, _ in blds])
    lo, hi = allt[:, :, :2].reshape(-1, 2).min(0), allt[:, :, :2].reshape(-1, 2).max(0)
    bounds = (min(lo[0], x0), min(lo[1], y0), max(hi[0], x0 + T), max(hi[1], y0 + T))
    mesh = load_mesh(meta["crs"], bounds)
    near = ((trees[:, 0] > bounds[0] - 10) & (trees[:, 0] < bounds[2] + 10)
            & (trees[:, 1] > bounds[1] - 10) & (trees[:, 1] < bounds[3] + 10))
    return ij, sample_tile(meta, ij, blds, mesh, trees[near], debug), time.perf_counter() - started


def sample_tiles(meta, by_tile, trees, jobs: int, debug: bool):
    """sample_tile for each tile, `jobs` tiles side by side: yields (tile, samples,
    seconds) as they're done."""
    work = [(meta, ij, by_tile[ij], trees, debug) for ij in sorted(by_tile)]
    if jobs <= 1 or len(work) == 1:
        yield from map(sample_job, work)
        return
    with ProcessPoolExecutor(jobs) as pool:
        yield from pool.map(sample_job, work)


def calibrate(sampled):
    """Estimates the light in the photographs from the buildings themselves: the sun's
    azimuth, as the direction that best splits bright walls from dark ones; the gains
    that bring a wall in shade to its colour in the sun, from buildings measured on
    both sides; and the sun's elevation with the roofs' light, from how bright clay
    tile roofs are against how squarely they face the sun."""
    walls = [b["walls"] for s in sampled.values() for b in s["buildings"] if b["walls"] is not None]
    az = np.degrees(np.arctan2(np.concatenate([w[0][:, 0] for w in walls]), np.concatenate([w[0][:, 1] for w in walls]))) % 360
    L = np.concatenate([w[1][:, 0] for w in walls])
    best = None
    for sun in np.arange(0, 360, 2.5):
        facing = np.cos(np.radians(az - sun))
        lit, dark = L[facing > LIT], L[facing < -LIT]
        if len(lit) and len(dark):
            split = np.median(lit) - np.median(dark)
            if best is None or split > best[0]:
                best = (split, sun)
    sun = best[1]
    print(f"sun from azimuth {sun:.1f}° ({len(L)} wall samples on {len(sampled)} tiles; lit walls {best[0]:.1f} L* brighter)")
    # Pitched clay tile roofs: much the same colour everywhere, so their brightness
    # shows the light.
    faces = [f for s in sampled.values() for b in s["buildings"] for f in b["roofs"]
             if f["raw"] is not None and not f["flat"] and f["n"] >= MIN_SAMPLES and f["share"] >= MIN_SHARE
             and f["raw"][1] > 5 and f["raw"][2] > 5]
    nrm = np.array([f["normal"] for f in faces])
    lum = labs_linear(np.array([f["raw"] for f in faces])) @ [0.2126, 0.7152, 0.0722]
    wt = np.array([f["n"] for f in faces], float)
    # The sun's elevation and the light model: the best straight-line fit of brightness
    # against how squarely a face meets the sun.
    fit = None
    for el in np.arange(15, 75, 2.5):
        x = np.maximum(0, nrm @ sun_vector(sun, el))
        A = np.column_stack((x, np.ones_like(x))) * np.sqrt(wt)[:, None]
        (a, b), res, *_ = np.linalg.lstsq(A, lum * np.sqrt(wt), rcond=None)
        r2 = 1 - (res[0] if len(res) else 0) / (((lum - np.average(lum, weights=wt)) ** 2) * wt).sum()
        if fit is None or r2 > fit[0]:
            fit = (r2, el, a, b)
    r2, el, a, b = fit
    global SUN, SKY
    SUN, SKY = a / (a + b), b / (a + b)
    print(f"sun {el:.1f}° high; brightness {a:.3f} x + {b:.3f} (R² {r2:.2f}, {len(faces)} tile roof faces), "
          f"so SUN, SKY = {SUN:.2f}, {SKY:.2f}")
    # The camera's cast: the median tile roof and the median plaster wall, the light
    # taken out, onto their references.
    tiles, walls = [], []
    for s in sampled.values():
        for r in summarise(s, sun, el, balanced=False):
            if r["wall"] and r["wall"]["sure"]:
                walls.append(r["wall"]["lab"])
            tiles += [f["lab"] for f in r["roofs"] if f["sure"] and f["material"] == "tiles"]
    mt = labs_linear(np.median(tiles, axis=0)[None])[0]
    mw = labs_linear(np.median(walls, axis=0)[None])[0]
    rt = labs_linear(lab(np.array(ipr.hexrgb(TILE_REFERENCE))))[0]
    rw = labs_linear(lab(np.array(ipr.hexrgb(PLASTER_REFERENCE))))[0]
    gain = (rt * mt + rw * mw) / (mt * mt + mw * mw)
    tile = lab(linear_rgb(mt * gain))[0]
    ref = lab(linear_rgb(rt))[0]
    chroma = np.hypot(*ref[1:]) / np.hypot(*tile[1:])
    wall = lab(linear_rgb(mw * gain))[0]
    print(f"median tile roof {hexc(np.median(tiles, axis=0))} ({len(tiles)} faces), median wall "
          f"{hexc(np.median(walls, axis=0))} ({len(walls)} buildings), so "
          f"BALANCE_GAIN = {tuple(round(float(g), 3) for g in gain)}, CHROMA = {chroma:.2f}; they become "
          f"{hexc(tile * [1, chroma, chroma])} and {hexc(wall * [1, chroma, chroma])}")


def table(measured) -> str:
    """The measurements as a tab-separated table; '?' marks the unsure ones."""

    def show(m):
        return (hexc(m["lab"]) if m["lab"] is not None else "-") + ("" if m["sure"] else "?")

    rows = ["building\twall\tshare\tsamples\troof faces (colour material share pixels)"]
    for r in measured:
        wl = r["wall"] or {"lab": None, "sure": False, "share": 0, "n": 0}
        faces = " ".join(f"{show(f)} {f['material']} {f['share']:.2f} {f['n']}" for f in r["roofs"])
        rows.append(f"{r['id']}\t{show(wl)}\t{wl['share']:.2f}\t{wl['n']}\t{faces}")
    return "\n".join(rows) + "\n"


def area_trees(meta: dict) -> np.ndarray:
    """IPR's trees in the area's local metres."""
    import ipr_trees
    t = ipr_trees._all()
    x, y = Transformer.from_crs("EPSG:4326", meta["crs"], always_xy=True).transform(t[:, 0], t[:, 1])
    return np.column_stack((x, y))


if __name__ == "__main__":
    main()
