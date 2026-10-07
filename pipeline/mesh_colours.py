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
import gzip
import json
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
    seen edge on, are left out. Scanline by scanline: each triangle's pixels row by
    row, only the ones inside it."""
    w = int(round(size / res))
    height = np.full(w * w, -np.inf)
    which = np.full(w * w, -1)
    weights = np.zeros((w * w, 3))
    t = tris
    if not len(t):
        height[:] = np.nan
        return which, weights, height
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    up = np.abs(nrm[:, 2]) / np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)
    keep = np.nonzero(up > 0.1)[0]
    # Pixel coordinates: pixel centres at whole numbers, column from the west edge, row
    # from the north edge.
    gx = (t[keep, :, 0] - x0) / res - 0.5
    gy = (y0 + size - t[keep, :, 1]) / res - 0.5
    row0 = np.clip(np.ceil(gy.min(1)).astype(int), 0, w)
    row1 = np.clip(np.floor(gy.max(1)).astype(int), -1, w - 1)
    rows = np.maximum(row1 - row0 + 1, 0)
    # Batches of about a million rows' worth of triangles.
    cum = np.cumsum(rows)
    cuts = np.searchsorted(cum, np.arange(1, cum[-1] // 1_000_000 + 2) * 1_000_000) if len(cum) and cum[-1] else []
    start = 0
    for end in [*cuts, len(keep)]:
        end = min(max(end, start + 1), len(keep))
        if start >= end:
            break
        k = np.arange(start, end)
        start = end
        n = rows[k]
        if not n.sum():
            continue
        # One entry per (triangle, row).
        tk = np.repeat(k, n)
        py = np.repeat(row0[k], n) + np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        ax, ay = gx[tk].T, gy[tk].T  # (3, m)
        bx, by = np.roll(ax, -1, 0), np.roll(ay, -1, 0)
        span = ((ay - py) * (by - py) <= 0) & (ay != by)
        xs = np.where(span, ax + (py - ay) * (bx - ax) / np.where(ay != by, by - ay, 1), np.nan)
        xl = np.clip(np.ceil(np.nanmin(np.where(span, xs, np.inf), 0)), 0, w)
        xr = np.clip(np.floor(np.nanmax(np.where(span, xs, -np.inf), 0)), -1, w - 1)
        cnt = np.maximum(xr - xl + 1, 0).astype(int)
        if not cnt.sum():
            continue
        # One entry per pixel.
        pt = np.repeat(tk, cnt)
        pyy = np.repeat(py, cnt)
        pxx = np.repeat(xl.astype(int), cnt) + np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        vx, vy = gx[pt], gy[pt]
        det = (vy[:, 1] - vy[:, 2]) * (vx[:, 0] - vx[:, 2]) + (vx[:, 2] - vx[:, 1]) * (vy[:, 0] - vy[:, 2])
        det = np.where(np.abs(det) < 1e-12, 1e-12, det)
        l1 = ((vy[:, 1] - vy[:, 2]) * (pxx - vx[:, 2]) + (vx[:, 2] - vx[:, 1]) * (pyy - vy[:, 2])) / det
        l2 = ((vy[:, 2] - vy[:, 0]) * (pxx - vx[:, 2]) + (vx[:, 0] - vx[:, 2]) * (pyy - vy[:, 2])) / det
        b = np.clip(np.column_stack((l1, l2, 1 - l1 - l2)), 0, 1)
        tri = keep[pt]
        z = (b * t[tri, :, 2]).sum(1)
        pix = pyy * w + pxx
        # The highest surface per pixel in this batch, then against what's there.
        o = np.lexsort((z, pix))
        o = o[np.r_[pix[o][1:] != pix[o][:-1], True]]
        o = o[z[o] > height[pix[o]]]
        height[pix[o]], which[pix[o]], weights[pix[o]] = z[o], tri[o], b[o]
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


RGB_XYZ = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
WHITE = np.array([0.95047, 1.0, 1.08883])


def linear_lab(lin: np.ndarray) -> np.ndarray:
    """Linear RGB (k, 3; may go past 1) → CIELAB (k, 3), D65."""
    xyz = np.asarray(lin, np.float64).reshape(-1, 3) @ RGB_XYZ.T / WHITE
    f = np.where(xyz > 216 / 24389, np.cbrt(xyz), (24389 / 27 * xyz + 16) / 116)
    return np.column_stack((116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])))


def labs_linear(c) -> np.ndarray:
    """CIELAB (k, 3) → linear RGB (k, 3), not clipped."""
    L, a, b = np.atleast_2d(c).T
    fy = (L + 16) / 116
    f = np.column_stack((fy + a / 500, fy, fy - b / 200))
    xyz = np.where(f ** 3 > 216 / 24389, f ** 3, (116 * f - 16) / (24389 / 27)) * WHITE
    return xyz @ np.linalg.inv(RGB_XYZ).T


def lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (k, 3) 0-255 → CIELAB (k, 3)."""
    c = np.asarray(rgb, np.float64).reshape(-1, 3) / 255
    return linear_lab(np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4))


def rgb(c: np.ndarray) -> np.ndarray:
    """CIELAB (k, 3) → sRGB (k, 3) uint8, clipped."""
    s = np.clip(labs_linear(c), 0, 1)
    s = np.where(s <= 0.0031308, 12.92 * s, 1.055 * s ** (1 / 2.4) - 0.055)
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


# Roof material classes, by the roof's measured colour (L*a*b*). Pitched roofs:
COPPER_A = -5.0  # a* below this, with some chroma: green-cyan patina
COPPER_CHROMA = 6.0
TILE_CHROMA = 12.0  # warm (a*, b* > 0) with at least this much chroma: clay tiles
SLATE_L = 50.0  # grey roofs darker than this are slate, lighter ones sheet metal
# Flat roofs (in centrum about a sixth each dark, light and warm, a third mid grey):
GREEN_A, GREEN_B = -5.0, 6.0  # a* below and b* above: yellow-green, a planted roof
PAVING_CHROMA = 14.0  # warm with this much chroma: a terrace of tiles or paving
BITUMEN_L = 40.0  # grey and darker than this: bitumen or tar sheets
MEMBRANE_L = 68.0  # grey and lighter than this: a plastic membrane; between: gravel
MATERIALS = ("tiles", "slate", "metal", "copper", "bitumen", "membrane", "gravel", "green", "paving")


def material(c, flat: bool) -> str:
    L, a, b = c
    chroma = float(np.hypot(a, b))
    if flat:
        if a < GREEN_A and b > GREEN_B:
            return "green"
        if a > 0 and b > 0 and chroma >= PAVING_CHROMA:
            return "paving"
        return "bitumen" if L < BITUMEN_L else "membrane" if L > MEMBRANE_L else "gravel"
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
# cosine, 0 when facing away) as SUN * x + SKY, fitted on 5,150 clay tile roof faces
# out of other buildings' shadows (R² 0.59). Shadows are nearly black: guessing a
# wall's colour in the sun from its shaded side missed by ΔE 17 on 463 buildings seen
# both ways, worse than taking another building's (11), so walls seen only in shade
# count as unsure (tried again on 7 October 2026 with the ground's light beside each
# building as a calibration, on 604 buildings: no better, docs/evidence/shaded-walls).
# Walls facing the sun more
# than LIT (cosine, level) are lit, facing away more than that shaded.
SUN_AZIMUTH = 100.0  # degrees from north
SUN_ELEVATION = 35.0
SUN, SKY = 0.91, 0.09
LIT = 0.3
# Roof faces meeting the sun less squarely than this count as in shade: the gain that
# would bring them to full sun (2.4 or more) also blows up the sky's blue in them.
ROOF_LIT = 0.35
FLAT = 0.995  # a roof face whose normal is steeper than this (under 6°) is flat
LUMA = np.array([0.2126, 0.7152, 0.0722])
# Walls seen only in shade (see from_shade and calibrate): the sky's tint to take out
# (linear RGB, green 1), and the brightness (linear luminance) of walls in shade at
# each twentieth of the city's walls, darkest first, against the same for walls in
# the sun, the light taken out.
SHADE_TINT = (1.267, 1.0, 0.775)
SHADE_Y = (0.0036, 0.0086, 0.0131, 0.0172, 0.0212, 0.0243, 0.0281, 0.033, 0.036, 0.0403, 0.0475, 0.0537, 0.0584,
           0.0668, 0.076, 0.0825, 0.0971, 0.1133, 0.1349, 0.1768, 0.6971)
LIT_Y = (0.0316, 0.4406, 0.5555, 0.6245, 0.6701, 0.7094, 0.7392, 0.7775, 0.8089, 0.8343, 0.8585, 0.8853, 0.9068,
         0.9331, 0.9581, 0.9855, 1.0222, 1.0597, 1.118, 1.3666, 2.4252)
# The camera's cast and the haze (see calibrate): gains per channel (linear RGB) that
# take the median plaster wall to PLASTER_REFERENCE after the light is taken out, and
# for roofs the same times one brightness factor that gives the median clay tile roof
# TILE_REFERENCE's brightness (not its hue: the old palette is redder than Prague's
# roofs), and ROOF_CHROMA times the colourfulness (L*a*b* a* and b*), which the haze
# took, to give it the reference's too. Walls and roofs differ in brightness since the light model is fitted on
# roofs, and a wall sees only half the sky and the street's light besides; with one
# gain for both the roofs came out pale. No offset for the
# haze: fitted on light colours, one pushed dark roofs and walls to black.
TILE_REFERENCE = "#ab5f48"  # the middle of the game's old tile palette
PLASTER_REFERENCE = "#ddd3bf"  # a light, slightly warm plaster
ROOF_GAIN = (0.489, 0.468, 0.434)
ROOF_CHROMA = 1.47
WALL_GAIN = (0.796, 0.761, 0.706)


def sun_vector(az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION) -> np.ndarray:
    az, el = np.radians(az), np.radians(el)
    return np.array([np.sin(az) * np.cos(el), np.cos(az) * np.cos(el), np.sin(el)])


def unlight(labs: np.ndarray, normals: np.ndarray, az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION) -> np.ndarray:
    """Colours (k, 3 L*a*b*) measured on surfaces with these normals (k, 3), as they'd
    be facing the sun squarely."""
    x = np.maximum(0.0, np.atleast_2d(normals) @ sun_vector(az, el))
    gain = (SUN + SKY) / (SUN * x + SKY)
    return linear_lab(labs_linear(labs) * gain[:, None])


def roof_faces(t: np.ndarray, codes: np.ndarray) -> np.ndarray:
    """Groups a building's roof triangles into faces: a face number per triangle, -1 for
    walls. Triangles facing the same way join when they share an edge (IPR's roof
    quads are often a little warped, so their two halves aren't quite one plane) or lie
    in one plane."""
    roof = np.nonzero(codes != 0)[0]
    face = np.full(len(t), -1)
    if not len(roof):
        return face
    nrm = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1), 1e-12)[:, None]
    parent = {int(k): int(k) for k in roof}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    edges, planes = {}, []
    for k in map(int, roof):
        v = [tuple(np.round(t[k, i], 2)) for i in range(3)]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            e = (v[a], v[b]) if v[a] < v[b] else (v[b], v[a])
            o = edges.setdefault(e, k)
            if o != k and nrm[k] @ nrm[o] > 0.99:
                parent[find(k)] = find(o)
        d = nrm[k] @ t[k, 0]
        for o, n, dd in planes:
            if n @ nrm[k] > 0.995 and abs(dd - d) < 0.3:
                parent[find(k)] = find(o)
                break
        else:
            planes.append((k, nrm[k], d))
    roots = {}
    for k in map(int, roof):
        face[k] = roots.setdefault(find(k), len(roots))
    return face


def balance(c: np.ndarray, gain, chroma: float = 1.0) -> np.ndarray:
    """Takes the camera's cast and haze out of colours (k, 3 L*a*b*), with ROOF_GAIN and
    ROOF_CHROMA or WALL_GAIN."""
    out = linear_lab(labs_linear(c) * np.array(gain))
    out[:, 1:] *= chroma
    return out


# Shadows cast by other buildings (and trees): with the sun low, the houses across a
# street shade facades that face it, and courtyards are in shade all morning. Each
# sample looks towards the sun over a height map of the mesh, SHADOW_REACH m far.
SHADOW_REACH = 70.0  # m; a 40 m building's shadow at 32.5° is 63 m long
SHADOW_RES = 0.5  # m, the height map's pixel
SHADOW_TOL = 0.5  # m the sun's ray may pass under the height map without being blocked


class HeightMap:
    """The highest surface of the mesh on a square grid, to look for shadows on."""

    def __init__(self, mesh: Mesh, x0: float, y0: float, size: float, res: float = SHADOW_RES):
        _, _, h = rasterize(mesh.tris, x0, y0, size, res)
        self.w = int(round(size / res))
        self.h = np.nan_to_num(h, nan=-np.inf).reshape(self.w, self.w)
        self.x0, self.y1, self.res = x0, y0 + size, res

    def in_sun(self, pts: np.ndarray) -> np.ndarray:
        """Whether the sun reaches each point (k, 3)."""
        s = sun_vector()
        flat = np.hypot(s[0], s[1])
        dx, dy, rise = s[0] / flat, s[1] / flat, s[2] / flat
        steps = np.arange(self.res, SHADOW_REACH, self.res)
        out = np.ones(len(pts), bool)
        for a in range(0, len(pts), 20000):
            p = pts[a:a + 20000]
            col = np.floor((p[:, 0, None] + dx * steps - self.x0) / self.res).astype(int)
            row = np.floor((self.y1 - (p[:, 1, None] + dy * steps)) / self.res).astype(int)
            ok = (col >= 0) & (col < self.w) & (row >= 0) & (row < self.w)
            h = np.where(ok, self.h[np.clip(row, 0, self.w - 1), np.clip(col, 0, self.w - 1)], -np.inf)
            out[a:a + 20000] = ~(h > p[:, 2, None] + rise * steps + SHADOW_TOL).any(1)
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
    # Roof pixels in another building's shadow are left out.
    hm = HeightMap(mesh, x0 - SHADOW_REACH, y0 - SHADOW_REACH, T + 2 * SHADOW_REACH)
    idx = np.nonzero(core)[0]
    px = np.column_stack((x0 + (idx % w + 0.5) * RES, y0 + T - (idx // w + 0.5) * RES, mesh_z[idx]))
    core[idx[~hm.in_sun(px)]] = False
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
            sun = hm.in_sun(np.column_stack((p[keep, :2] + wn[tri[keep]] * WALL_OUT, p[keep, 2])))
            rec["walls"] = (wn[tri[keep]], lab(c[keep]), wgt[keep], sun)
        f = faces[b]
        for face in np.unique(f[f >= 0]):
            labs = roof_samples.get(b * FACES + int(face), np.empty((0, 3)))
            dom, share = dominant(labs, np.ones(len(labs)))
            ft = t[f == face]
            fn = np.cross(ft[:, 1] - ft[:, 0], ft[:, 2] - ft[:, 0]).sum(0)
            rec["roofs"].append({"face": int(face), "tris": np.nonzero(f == face)[0], "raw": dom, "share": share,
                                 "n": len(labs), "normal": fn / max(np.linalg.norm(fn), 1e-12),
                                 # Only really flat: IPR also counts roofs up to 14° as flat,
                                 # and those are tiles or metal as often as not.
                                 "flat": bool((codes[f == face] == 2).all()) and fn[2] / max(np.linalg.norm(fn), 1e-12) > FLAT})
        out.append(rec)
    return {"buildings": out, "top": colour.reshape(w, w, 3) if debug else None, "fid": fid if debug else None}



# Roof windows, found in the mesh's colours (its geometry is too coarse for anything as
# small): on level 14 (about 11 cm per pixel), from above at 10 cm, dark or bluish
# patches in a pitched roof face the size and shape of a roof window.
WINDOW_LEVEL = 14
WINDOW_RES = 0.1
WINDOW_BRIGHT = 20.0  # L* this much above the face's own colour, grey: the sky in the glass
WINDOW_BRIGHT_CHROMA = 20.0
WINDOW_DARK = 18.0  # or this much below it: dark glass
WINDOW_BLUE = 10.0  # or b* this much below it (a blue sky) and a little darker
WINDOW_W = (0.55, 1.7)  # m across the slope
WINDOW_H = (0.7, 1.9)  # m down the slope
WINDOW_FILL = 0.55  # the share of its rectangle the patch fills
WINDOW_PLANE = 1.2  # m; the mesh there is no further than this from IPR's roof plane
WINDOW_NEAR = 1.5  # m round a patch, and
WINDOW_SUNWARD = 2.5  # m towards the sun from it, where nothing may stand up
WINDOW_SHADOW = 0.55  # m above the patch, for a dark one: it would be that thing's shadow
WINDOW_BESIDE = 0.9  # and for a bright one: a chimney's top or side
WINDOW_COLOURED = 15.0  # roofs with more chroma than this (clay tiles): a dark window in one
WINDOW_GREYER = 0.62  # has no more than this share of the roof's chroma
CHIMNEY_SIZE = 0.75  # m; a dark patch no bigger than this either way is a chimney and its shadow


FEATURES = None  # a list, to collect what's known of each window found (for tuning)


def detect_windows(meta, ij, blds, debug: bool = False):
    """Roof windows in a tile's pitched roofs: per building (by its index in `blds`),
    [centre x, y, z, across-the-slope x, y, z, down-the-slope x, y, z, width, height]
    in the area's local metres, on IPR's roof plane."""
    from scipy import ndimage
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    w = int(round(T / WINDOW_RES))
    mesh = load_mesh(meta["crs"], (x0, y0, x0 + T, y0 + T), level=WINDOW_LEVEL)
    tris = [unpack(pos, ij, meta) for _, pos, _, _ in blds]
    roofs, owner, normals = [], [], {}
    for b, ((_, _, codes, _), t) in enumerate(zip(blds, tris)):
        f = roof_faces(t, codes)
        sel = codes == 1
        roofs.append(t[sel])
        owner.append(b * FACES + f[sel])
        for face in np.unique(f[sel]):
            ft = t[f == face]
            n = np.cross(ft[:, 1] - ft[:, 0], ft[:, 2] - ft[:, 0]).sum(0)
            normals[b * FACES + int(face)] = n / max(np.linalg.norm(n), 1e-12)
    roofs = np.concatenate(roofs) if roofs else np.empty((0, 3, 3))
    owner = np.concatenate(owner) if owner else np.empty(0, int)
    rw, _, rz = rasterize(roofs, x0, y0, T, WINDOW_RES)
    # Only the mesh over the pitched roofs (a third or so of the tile): its triangles whose
    # bounding box meets a metre square with roof in it.
    cell = int(round(1 / WINDOW_RES))
    m = w // cell
    occ = (rw >= 0).reshape(m, cell, m, cell).any((1, 3))
    sat = np.pad(occ.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    mt = mesh.tris
    c0 = np.clip(((mt[:, :, 0].min(1) - x0) // 1).astype(int), 0, m - 1)
    c1 = np.clip(((mt[:, :, 0].max(1) - x0) // 1).astype(int), 0, m - 1)
    r0 = np.clip(((y0 + T - mt[:, :, 1].max(1)) // 1).astype(int), 0, m - 1)
    r1 = np.clip(((y0 + T - mt[:, :, 1].min(1)) // 1).astype(int), 0, m - 1)
    near = (sat[r1 + 1, c1 + 1] - sat[r0, c1 + 1] - sat[r1 + 1, c0] + sat[r0, c0]) > 0
    which, weights, mz = rasterize(mt[near], x0, y0, T, WINDOW_RES)
    above = (mz - rz).reshape(w, w)  # the mesh over IPR's roof plane, m
    if near.any():
        which = np.where(which >= 0, np.nonzero(near)[0][np.maximum(which, 0)], -1)
    fid = np.where(rw >= 0, owner[np.maximum(rw, 0)] if len(owner) else -1, -1).reshape(w, w)
    core = fid >= 0
    pad = np.pad(fid, 2, constant_values=-1)
    for dy in range(5):
        for dx in range(5):
            core &= pad[dy:dy + w, dx:dx + w] == fid
    fid = fid.ravel()
    core = core.ravel() & (which >= 0)
    idx = np.nonzero(core)[0]
    colour = np.zeros((w * w, 3), np.uint8)
    got = which[idx]
    colour[idx] = mesh.colour(mesh.tex[got], (weights[idx, :, None] * mesh.uv[got]).sum(1))
    labs = np.full((w * w, 3), np.nan)
    labs[idx] = lab(colour[idx])
    # What stands out from each face's own colour: grey and much brighter (the sky in
    # the glass), or much darker or bluer.
    # Each face's median, all faces at once: pixels sorted by face and value.
    faces = fid[idx]
    ref = np.empty((len(idx), 3))
    for ch in range(3 if len(idx) else 0):
        o = np.lexsort((labs[idx, ch], faces))
        fs = faces[o]
        starts = np.r_[0, np.nonzero(np.diff(fs))[0] + 1]
        ends = np.r_[starts[1:], len(fs)]
        ref[o, ch] = np.repeat(labs[idx[o[(starts + ends - 1) // 2]], ch], ends - starts)
    d = labs[idx] - ref
    bright, dark = np.zeros(w * w, bool), np.zeros(w * w, bool)
    bright[idx] = (d[:, 0] > WINDOW_BRIGHT) & (np.hypot(labs[idx, 1], labs[idx, 2]) < WINDOW_BRIGHT_CHROMA)
    dark[idx] = (d[:, 0] < -WINDOW_DARK) | ((d[:, 2] < -WINDOW_BLUE) & (d[:, 0] < -5))

    sv = sun_vector()
    sun_col, sun_row = sv[0] / np.hypot(sv[0], sv[1]), sv[1] / np.hypot(sv[0], sv[1])

    def window(pix, is_dark):
        f = int(np.bincount(fid[pix] - fid[pix].min()).argmax() + fid[pix].min())
        n = normals.get(f)
        if n is None or len(pix) < 20:
            return None
        rr, cc = np.divmod(pix, w)
        e = np.array([-n[1], n[0], 0.0]) / max(np.hypot(n[0], n[1]), 1e-9)
        d = np.cross(n, e)
        d = d if d[2] < 0 else -d
        p = np.column_stack((x0 + (cc + 0.5) * WINDOW_RES, y0 + T - (rr + 0.5) * WINDOW_RES, rz[pix]))
        a, dn = p @ e, p @ d
        width, height = np.ptp(a) + WINDOW_RES, np.ptp(dn) + WINDOW_RES / max(n[2], 0.3)
        fill = len(pix) * WINDOW_RES ** 2 / max(n[2], 0.3) / (width * height)
        if not (WINDOW_W[0] <= width <= WINDOW_W[1] and WINDOW_H[0] <= height <= WINDOW_H[1] and fill >= WINDOW_FILL):
            return None
        if is_dark and max(width, height) <= CHIMNEY_SIZE:
            return None
        # What tells a window from the rest (measured on 42 roofs, docs/evidence/roof-windows):
        # it lies in the roof's plane, nothing stands just beside it or between it and the
        # sun (those are chimneys, their sides and their shadows), and a dark one on a
        # coloured roof is greyer than the roof (a shadow keeps the tiles' colour).
        r0, r1, c0, c1 = rr.min(), rr.max(), cc.min(), cc.max()
        k = int(WINDOW_NEAR / WINDOW_RES)
        ring = above[max(r0 - k, 0):r1 + k + 1, max(c0 - k, 0):c1 + k + 1]
        steps = np.arange(0.3, WINDOW_SUNWARD, WINDOW_RES) / WINDOW_RES
        sr = np.clip((rr[:, None] - sun_row * steps).astype(int), 0, w - 1)
        sc = np.clip((cc[:, None] + sun_col * steps).astype(int), 0, w - 1)
        with np.errstate(all="ignore"):
            dz = float(np.nanmedian(above[rr, cc]))
            beside = float(np.nanpercentile(ring, 95)) - dz if np.isfinite(ring).any() else 0.0
            sunward = float(np.nanmax(above[sr, sc])) - dz if np.isfinite(above[sr, sc]).any() else 0.0
        chroma = float(np.hypot(*np.nanmedian(labs[pix, 1:], axis=0)))
        own = float(np.hypot(*np.median(ref[np.searchsorted(idx, pix), 1:], axis=0)))
        if FEATURES is not None:
            FEATURES.append({"face": f, "dark": is_dark, "w": float(width), "h": float(height), "fill": float(fill), "dz": dz,
                             "beside": beside, "sunward": sunward, "chroma": chroma, "own": own})
        if abs(dz) > WINDOW_PLANE:
            return None
        if is_dark and (sunward > WINDOW_SHADOW or (own > WINDOW_COLOURED and chroma > WINDOW_GREYER * own)):
            return None
        if not is_dark and max(sunward, beside) > WINDOW_BESIDE:
            return None
        centre = e * (a.min() + a.max()) / 2 + d * (dn.min() + dn.max()) / 2
        centre += n * float((p.mean(0) - centre) @ n)  # back onto the roof plane
        win = [*np.round(centre, 2), *np.round(e, 3), *np.round(d, 3), round(float(width), 2), round(float(height), 2)]
        return f, win, (rr.min(), cc.min(), rr.max(), cc.max())

    out, boxes = {}, []
    for mask, is_dark in ((bright, False), (dark, True)):
        comps, _ = ndimage.label(mask.reshape(w, w))
        for c, sl in enumerate(ndimage.find_objects(comps), 1):
            if sl is None:
                continue
            rr, cc = np.nonzero(comps[sl] == c)
            got = window((rr + sl[0].start) * w + cc + sl[1].start, is_dark)
            if got:
                out.setdefault(got[0] // FACES, []).append(got[1])
                boxes.append(got[2])
    if debug:
        return out, colour.reshape(w, w, 3), boxes
    return out


def summarise(sampled, az: float = SUN_AZIMUTH, el: float = SUN_ELEVATION, balanced: bool = True):
    """The colours of a tile's buildings from its samples (sample_tile): per building
    the walls' colour and per roof face its colour and material, each with how sure it
    is, the light (and with `balanced`, the camera's cast) taken out."""
    out = []
    s = np.array([np.sin(np.radians(az)), np.cos(np.radians(az))])
    for b in sampled["buildings"]:
        rec = {"id": b["id"], "wall": None, "shade": None, "roofs": []}
        if b["walls"] is not None:
            wn, labs, wgt, sun = b["walls"]
            # Sun or shade by which way the wall faces and what stands between it and the
            # sun, never by how dark it is, or a dark building would be brightened as
            # "shaded".
            facing = wn @ s
            lit, shaded = (facing > LIT) & sun, facing < -LIT
            dom, share = None, 0.0
            if lit.any():
                normals = np.column_stack((wn[lit], np.zeros(lit.sum())))
                dom, share = dominant(unlight(labs[lit], normals, az, el), wgt[lit])
            n = int(lit.sum())
            if dom is not None and balanced:
                dom = balance(dom, WALL_GAIN)[0]
            rec["wall"] = {"lab": dom, "share": share, "n": n, "sure": dom is not None and n >= MIN_SAMPLES and share >= MIN_SHARE}
            dom, share = dominant(labs[shaded], wgt[shaded])
            n = int(shaded.sum())
            rec["shade"] = {"raw": dom, "share": share, "n": n, "sure": dom is not None and n >= MIN_SAMPLES and share >= MIN_SHARE}
            if dom is not None:
                est = from_shade(dom)
                rec["shade"]["lab"] = balance(est, WALL_GAIN)[0] if balanced else est
        for f in b["roofs"]:
            dom = f["raw"]
            if dom is not None:
                dom = unlight(dom, f["normal"], az, el)[0]
                if balanced:
                    dom = balance(dom, ROOF_GAIN, ROOF_CHROMA)[0]
            # A face in its own shade is as unsure as a wall in shade.
            lit = float(f["normal"] @ sun_vector(az, el)) > ROOF_LIT
            rec["roofs"].append(dict(f, lab=dom, material=material(dom, f["flat"]) if dom is not None else None,
                                     sure=dom is not None and lit and f["n"] >= MIN_SAMPLES and f["share"] >= MIN_SHARE))
        out.append(rec)
    return out


def from_shade(c) -> np.ndarray:
    """A wall's colour in the sun (L*a*b*, before balance) guessed from its colour in
    shade: the hue with the sky's blue taken out (SHADE_TINT), and the brightness a
    wall as far up the city's walls in shade would have in the sun (SHADE_Y → LIT_Y),
    so dark buildings stay dark."""
    lin = labs_linear(np.atleast_2d(c))[0]
    y = lin @ LUMA
    tint = lin * np.array(SHADE_TINT)
    tint /= max(tint @ LUMA, 1e-6)
    return linear_lab(tint[None] * np.interp(y, SHADE_Y, LIT_Y))[0]


# ΔE; a building's roof faces of one material closer than this are one colour. More for
# metal and slate: they shine, and a shine doesn't follow the light model.
ROOF_SAME = {"tiles": 12.0, "copper": 12.0, "slate": 25.0, "metal": 25.0}  # (flat roofs aren't evened)


def even_roofs(rec) -> None:
    """Gives a building's measured pitched roof faces of one material the same colour
    (the median by pixels) where they're close to it: what's left of the light
    between the slopes, not a real difference. A patch really different, a repair in
    other tiles say, keeps its own."""
    sure = [f for f in rec["roofs"] if f["sure"] and not f["flat"]]
    for m in {f["material"] for f in sure}:
        same = [f for f in sure if f["material"] == m]
        if len(same) < 2:
            continue
        labs = np.array([f["lab"] for f in same])
        mid = weighted_median(labs, np.array([f["n"] for f in same], float))
        for f, c in zip(same, labs):
            if np.linalg.norm(c - mid) < ROOF_SAME[m]:
                f["lab"] = mid


def weighted_median(labs: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """The weighted median of each of L*, a* and b*."""
    out = np.empty(3)
    for k in range(3):
        o = np.argsort(labs[:, k])
        out[k] = labs[o[np.searchsorted(np.cumsum(weights[o]), weights.sum() / 2)], k]
    return out


def fill_roofs(rec) -> None:
    """Gives a building's unsure roof faces the colour of its sure ones (the median,
    by pixels, of the sure pitched ones for pitched faces, of the flat ones for flat
    faces). Faces with no sure neighbour keep none."""
    for flat in (False, True):
        sure = [f for f in rec["roofs"] if f["sure"] and f["flat"] == flat]
        if not sure:
            continue
        labs = np.array([f["lab"] for f in sure])
        wts = np.array([f["n"] for f in sure], float)
        order = np.argsort(labs[:, 0])
        mid = order[np.searchsorted(np.cumsum(wts[order]), wts.sum() / 2)]
        for f in rec["roofs"]:
            if not f["sure"] and f["flat"] == flat:
                f["lab"], f["material"], f["filled"] = sure[mid]["lab"], sure[mid]["material"], True


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
        if r and (r["sure"] or r.get("filled")):
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
    ap.add_argument("--resume", action="store_true", help="go on from where a run stopped (it saves every 100 tiles)")
    ap.add_argument("--no-windows", action="store_true", help="don't look for roof windows (saves the level-14 mesh)")
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
    sampled, colours = {}, {}
    path = OUT_DIR / f"{a.area}.json.gz"
    done_path = OUT_DIR / f"{a.area}.tiles.json"
    done = []
    if a.resume and path.exists() and done_path.exists():
        colours = json.loads(gzip.decompress(path.read_bytes()))
        done = json.loads(done_path.read_text())
        tiles = [ij for ij in tiles if f"{ij[0]}_{ij[1]}" not in set(done)]
        print(f"resuming: {len(done)} tiles done, {len(tiles)} to go")

    def save():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(gzip.compress(json.dumps(colours, separators=(",", ":")).encode()))
        tmp.replace(path)
        done_path.write_text(json.dumps(done))

    for ij, s, took in sample_tiles(meta, {ij: by_tile[ij] for ij in tiles}, trees, a.jobs, a.debug, not (a.no_windows or a.calibrate)):
        if a.calibrate:
            sampled[ij] = s
            continue
        measured = summarise(s)
        for b, r in enumerate(measured):
            even_roofs(r)
            fill_roofs(r)
            if r["id"]:
                colours[r["id"]] = entry(r, s["windows"].get(b))
        walls = sum(1 for r in measured if r["wall"] and r["wall"]["sure"])
        roofs = [f for r in measured for f in r["roofs"]]
        print(f"{ij[0]}_{ij[1]}: walls measured for {walls} of {len(measured)} buildings, "
              f"{sum(f['sure'] for f in roofs)} of {len(roofs)} roof faces, "
              f"{sum(bool(f.get('filled')) for f in roofs)} more from the rest of their roof ({took:.0f} s)", flush=True)
        done.append(f"{ij[0]}_{ij[1]}")
        # Saved as it goes, so a long run (the whole city) can go on with --resume.
        if not a.tiles and len(done) % 100 == 0:
            save()
        if a.debug:
            name = f"{ij[0]}_{ij[1]}"
            debug_tile(meta, ij, by_tile[ij], s["top"], s["fid"], measured, OUT_DIR / a.area / f"{name}.png")
            (OUT_DIR / a.area / f"{name}.tsv").write_text(table(measured))
    print(f"{len(tiles)} tiles in {time.perf_counter() - started:.0f} s")
    if a.calibrate:
        calibrate(sampled)
        return
    if a.tiles and path.exists() and not a.resume:
        colours = {**json.loads(gzip.decompress(path.read_bytes())), **colours}
    save()
    print(f"{path}: {len(colours)} buildings")


def entry(r, windows=None) -> dict:
    """A building's colours for ipr_buildings.py: its walls' measured in the sun, or
    guessed from the shade ("shade"), and its roof faces' (triangle numbers in
    read_sheet's order, colour, material, and whether it's taken from the rest of the
    roof), all as sRGB bytes; and its roof windows (detect_windows)."""
    out = {}
    if r["wall"] and r["wall"]["sure"]:
        out["wall"] = rgb(r["wall"]["lab"])[0].tolist()
    elif r["shade"] and r["shade"]["sure"]:
        out["shade"] = rgb(r["shade"]["lab"])[0].tolist()
    roofs = [[f["tris"].tolist(), rgb(f["lab"])[0].tolist(), f["material"], bool(f.get("filled"))]
             for f in r["roofs"] if f["lab"] is not None and (f["sure"] or f.get("filled"))]
    if roofs:
        out["roofs"] = roofs
    if windows:
        out["windows"] = windows
    return out

def sample_job(job):
    meta, ij, blds, trees, debug, windows = job
    started = time.perf_counter()
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    allt = np.concatenate([unpack(pos, ij, meta) for _, pos, _, _ in blds])
    lo, hi = allt[:, :, :2].reshape(-1, 2).min(0), allt[:, :, :2].reshape(-1, 2).max(0)
    bounds = (min(lo[0], x0), min(lo[1], y0), max(hi[0], x0 + T), max(hi[1], y0 + T))
    mesh = load_mesh(meta["crs"], bounds, margin=SHADOW_REACH)
    near = ((trees[:, 0] > bounds[0] - 10) & (trees[:, 0] < bounds[2] + 10)
            & (trees[:, 1] > bounds[1] - 10) & (trees[:, 1] < bounds[3] + 10))
    sampled = sample_tile(meta, ij, blds, mesh, trees[near], debug)
    sampled["windows"] = detect_windows(meta, ij, blds) if windows else {}
    return ij, sampled, time.perf_counter() - started


def sample_tiles(meta, by_tile, trees, jobs: int, debug: bool, windows: bool = False):
    """sample_tile for each tile, `jobs` tiles side by side: yields (tile, samples,
    seconds) as they're done."""
    work = [(meta, ij, by_tile[ij], trees, debug, windows) for ij in sorted(by_tile)]
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
    tiles, walls, shades, both = [], [], [], []
    for s in sampled.values():
        for r in summarise(s, sun, el, balanced=False):
            if r["wall"] and r["wall"]["sure"]:
                walls.append(r["wall"]["lab"])
            if r["shade"] and r["shade"]["sure"]:
                shades.append(r["shade"]["raw"])
                if r["wall"]["sure"]:
                    both.append((r["wall"]["lab"], r["shade"]["raw"]))
            tiles += [f["lab"] for f in r["roofs"] if f["sure"] and f["material"] == "tiles"]
    # Walls seen only in shade: the brightness by rank, and the sky's tint from
    # buildings seen both ways.
    global SHADE_TINT, SHADE_Y, LIT_Y
    q = np.linspace(0, 100, 21)
    LIT_Y = tuple(np.percentile(labs_linear(np.array(walls)) @ LUMA, q))
    SHADE_Y = tuple(np.percentile(labs_linear(np.array(shades)) @ LUMA, q))
    lit_lin = labs_linear(np.array([b[0] for b in both]))
    sh_lin = labs_linear(np.array([b[1] for b in both]))
    ratio = (lit_lin / np.maximum(lit_lin @ LUMA, 1e-6)[:, None]) / np.maximum(sh_lin / np.maximum(sh_lin @ LUMA, 1e-6)[:, None], 1e-6)
    tint = np.median(ratio, axis=0)
    SHADE_TINT = tuple(tint / tint[1])
    actual = np.array([b[0] for b in both])
    mid = np.median(np.array(walls), axis=0)
    y_mid = float(labs_linear(mid[None])[0] @ LUMA)

    def hue_only(c):
        lin = labs_linear(np.atleast_2d(c))[0] * np.array(SHADE_TINT)
        return linear_lab(lin / max(lin @ LUMA, 1e-6) * y_mid)[0]

    print(f"walls in shade: SHADE_TINT = {tuple(round(float(t), 3) for t in SHADE_TINT)}; "
          f"on {len(both)} buildings seen both ways, their colour in the sun guessed from the shade misses by (ΔE, median and quartiles):")
    for name, guess in (("hue and brightness by rank", [from_shade(b[1]) for b in both]),
                        ("hue, the city's median brightness", [hue_only(b[1]) for b in both]),
                        ("the city's median wall", [mid] * len(both)),
                        ("another building's colour", np.roll(actual, 1, axis=0))):
        err = np.linalg.norm(np.array(guess) - actual, axis=1)
        print(f"  {name:36s} {np.median(err):5.1f}  ({np.percentile(err, 25):.1f}-{np.percentile(err, 75):.1f})")
    print(f"SHADE_Y = {tuple(round(float(v), 4) for v in SHADE_Y)}")
    print(f"LIT_Y = {tuple(round(float(v), 4) for v in LIT_Y)}")
    mt = labs_linear(np.median(tiles, axis=0)[None])[0]
    mw = labs_linear(np.median(walls, axis=0)[None])[0]
    rt = labs_linear(lab(np.array(ipr.hexrgb(TILE_REFERENCE))))[0]
    rw = labs_linear(lab(np.array(ipr.hexrgb(PLASTER_REFERENCE))))[0]
    wall_gain = rw / mw
    k = float(rt @ LUMA) / float((mt * wall_gain) @ LUMA)
    tile = linear_lab(mt * wall_gain * k)[0]
    ref = linear_lab(rt[None])[0]
    chroma = float(np.hypot(*ref[1:]) / np.hypot(*tile[1:]))
    print(f"median tile roof {hexc(np.median(tiles, axis=0))} ({len(tiles)} faces), median wall "
          f"{hexc(np.median(walls, axis=0))} ({len(walls)} buildings), so WALL_GAIN = "
          f"{tuple(round(float(g), 3) for g in wall_gain)}, ROOF_GAIN = {tuple(round(float(g), 3) for g in wall_gain * k)}; "
          f"ROOF_CHROMA = {chroma:.2f}; the median tile roof becomes {hexc(tile * [1, chroma, chroma])}")


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
