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
import time
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
WALL_STEP = 0.5
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


def top_view(mesh: Mesh, x0: float, y0: float, size: float, res: float = RES):
    """The mesh seen straight from above over the square from (x0, y0) of `size` m:
    colour (h, w, 3) uint8 and height (h, w), NaN where there's nothing. Row 0 is the
    north edge."""
    w = int(round(size / res))
    height = np.full(w * w, -np.inf)
    colour = np.zeros((w * w, 3), np.uint8)
    t = mesh.tris
    # Walls are seen edge on from above; leave them out.
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
    order = np.argsort(bw * bh)
    start = 0
    while start < len(order):
        # A batch of triangles of similar size, each tested against its bounding box.
        cw, ch = bw[order[start]], bh[order[start]]
        end = start
        budget = 4_000_000
        while end < len(order) and (end - start + 1) * max(cw, bw[order[end]]) * max(ch, bh[order[end]]) <= budget:
            cw, ch = max(cw, bw[order[end]]), max(ch, bh[order[end]])
            end += 1
        end = max(end, start + 1)
        idx = order[start:end]
        cw, ch = bw[idx].max(), bh[idx].max()
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
            last = np.r_[pix[o][1:] != pix[o][:-1], True]
            o = o[last]
            pix, z, tri, b = pix[o], z[o], tri[o], b[o]
            better = z > height[pix]
            pix, z, tri, b = pix[better], z[better], tri[better], b[better]
            height[pix] = z
            uv = (b[:, :, None] * mesh.uv[tri]).sum(1)
            colour[pix] = mesh.colour(mesh.tex[tri], uv)
        start = end
    height[~np.isfinite(height)] = np.nan
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
        cells, owners = [], []
        for k in range(len(t)):
            xs = np.arange(lo[k, 0], hi[k, 0] + 1) - self.origin[0]
            ys = np.arange(lo[k, 1], hi[k, 1] + 1) - self.origin[1]
            c = (ys[:, None] * self.cols + xs[None]).ravel()
            cells.append(c)
            owners.append(np.full(len(c), k))
        cells = np.concatenate(cells) if cells else np.empty(0, int)
        owners = np.concatenate(owners) if owners else np.empty(0, int)
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
            o = np.lexsort((dist, r))
            first = np.r_[True, r[o][1:] != r[o][:-1]]
            o = o[first]
            r, k, dist, u, v = r[o], k[o], dist[o], u[o], v[o]
            closer = dist < best_t[r]
            r, k, dist, u, v = r[closer], k[closer], dist[closer], u[closer], v[closer]
            best_t[r], best_k[r] = dist, k
            best_uv[r] = np.column_stack((u, v))
        return best_k, best_t, best_uv


def wall_samples(mesh: Mesh, grid: RayGrid, tris: np.ndarray):
    """Where the walls `tris` (k, 3, 3, local metres) meet the mesh: for each sample
    point on them, the wall triangle it's on, its point, the area it stands for, its
    colour and the mesh's normal there. Points whose ray met nothing are left out."""
    pts, owner, weight = lattice(tris, WALL_STEP)
    nrm = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    nrm[:, 2] = 0  # rays go level, straight at the wall
    ln = np.linalg.norm(nrm, axis=1)
    nrm = nrm / np.maximum(ln, 1e-12)[:, None]
    ok = ln[owner] > 1e-9
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


def debug_tile(area: str, meta: dict, ij, buildings, top, walls, out: Path):
    """Two pictures of the tile side by side: the mesh from above, and IPR's
    buildings' outlines with the colours their walls' samples found."""
    from PIL import ImageDraw
    T, (ox, oy) = meta["tile"], meta["origin"]
    x0, y0 = ij[0] * T - ox, ij[1] * T - oy
    colour, _ = top
    w = colour.shape[0]
    right = Image.new("RGB", (w, w), (40, 40, 40))
    draw = ImageDraw.Draw(right)

    def px(x, y):
        return (x - x0) / RES, (y0 + T - y) / RES

    for _, _, _, fp in buildings:
        for g in fp:
            for poly in getattr(g, "geoms", [g]):
                if poly.geom_type == "Polygon":
                    draw.polygon([px(x, y) for x, y in poly.exterior.coords], fill=(70, 70, 70), outline=(110, 110, 110))
    for _, p, _, c, _ in walls:
        for (x, y, _), rgb in zip(p, c):
            u, v = px(x, y)
            draw.rectangle([u - 1, v - 1, u + 1, v + 1], fill=tuple(int(q) for q in rgb))
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
    ap.add_argument("--debug", action="store_true", help="write debug images per tile")
    a = ap.parse_args()
    meta = layers.read_meta(a.area)
    if not meta:
        raise SystemExit(f"{a.area}: run build_tiles.py {a.area} first")
    T, (ox, oy) = meta["tile"], meta["origin"]
    wanted = {tuple(map(int, t.split("_"))) for t in a.tiles} if a.tiles else {(i, j) for i, j, _ in layers.tiles(a.area, meta)}
    by_tile = tile_buildings(a.area, meta, wanted)
    for ij in sorted(by_tile):
        blds = by_tile[ij]
        x0, y0 = ij[0] * T - ox, ij[1] * T - oy
        tris = [unpack(pos, ij, meta) for _, pos, _, _ in blds]
        allt = np.concatenate(tris)
        lo, hi = allt[:, :, :2].reshape(-1, 2).min(0), allt[:, :, :2].reshape(-1, 2).max(0)
        bounds = (min(lo[0], x0), min(lo[1], y0), max(hi[0], x0 + T), max(hi[1], y0 + T))
        t0 = time.perf_counter()
        mesh = load_mesh(meta["crs"], bounds)
        t1 = time.perf_counter()
        top = top_view(mesh, x0, y0, T)
        t2 = time.perf_counter()
        grid = RayGrid(mesh)
        walls = []
        hits = total = 0
        for (bid, _, codes, _), t in zip(blds, tris):
            wt = t[codes == 0]
            if not len(wt):
                continue
            s = wall_samples(mesh, grid, wt)
            walls.append(s)
            hits += len(s[0])
            total += len(lattice(wt, WALL_STEP)[0])
        t3 = time.perf_counter()
        print(f"{ij[0]}_{ij[1]}: {len(blds)} buildings, {len(mesh.tris)} mesh triangles, "
              f"{hits} of {total} wall samples met the mesh "
              f"(mesh {t1 - t0:.1f} s, from above {t2 - t1:.1f} s, walls {t3 - t2:.1f} s)")
        if a.debug:
            debug_tile(a.area, meta, ij, blds, top, walls, OUT_DIR / a.area / f"{ij[0]}_{ij[1]}.png")


if __name__ == "__main__":
    main()
