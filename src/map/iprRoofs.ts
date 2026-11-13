import { dominantAxis } from './roofDetails.ts';
import type { RoofSite } from './roofDetails.ts';
import { PARAPET_MIN_AREA } from './roofRules.ts';

// The flat roofs in a tile of IPR's buildings, found from the triangles: those whose roof
// material is bitumen, membrane or gravel (pipeline/ipr_buildings.py) and that face straight
// up, joined where they share a corner. Each roof becomes a RoofSite for planDetails, with
// the triangles themselves as the area it may build on: a lift house IPR models already
// is a hole in it, and so is anything else of IPR's that stands up out of it (a light
// well's walls, a chimney, the wall of a taller wing beside it), though the roof's
// triangles may run on under it.

const CELL = 0.5; // m, of the grid that tells whether a spot is on the roof
const MAX_CELLS = 360;
const MAX_SPREAD = 0.5; // m of height between a roof's lowest and highest corner
const FLAT_MATERIALS = new Set([5, 6, 7]);
const RISE = 0.6; // m over the roof (more than MAX_SPREAD) from which something blocks it

// `pos` is a tile's triangles as the building meshes have them (x, height, -y), `material(o)`
// the roof material of triangle o, `ground(x, y)` the ground's height.
export function iprRoofSites(pos: Float32Array, material: (o: number) => number, ground: (x: number, y: number) => number): RoofSite[] {
  const n = pos.length / 9;
  const flat: number[] = [];
  for (let o = 0; o < n; o++) {
    if (!FLAT_MATERIALS.has(material(o))) continue;
    const i = o * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny > 0.985 * Math.hypot(nx, ny, nz)) flat.push(o);
  }
  if (!flat.length) return [];

  const root = flat.map((_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const corner = new Map<string, number>();
  const key = (i: number) => `${Math.round(pos[i] * 100)},${Math.round(pos[i + 1] * 100)},${Math.round(pos[i + 2] * 100)}`;
  flat.forEach((o, f) => {
    for (let v = 0; v < 3; v++) {
      const k = key(o * 9 + v * 3), at = corner.get(k);
      if (at === undefined) corner.set(k, f);
      else root[find(f)] = find(at);
    }
  });
  // Every triangle's footprint box and top, for what stands up out of a roof.
  const tb = new Float32Array(n * 5);
  for (let o = 0; o < n; o++) {
    const i = o * 9;
    let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity, top = -Infinity;
    for (let v = 0; v < 3; v++) {
      const x = pos[i + v * 3], y = -pos[i + v * 3 + 2];
      a0 = Math.min(a0, x); a1 = Math.max(a1, x); b0 = Math.min(b0, y); b1 = Math.max(b1, y); top = Math.max(top, pos[i + v * 3 + 1]);
    }
    tb.set([a0, b0, a1, b1, top], o * 5);
  }
  const groups = new Map<number, number[]>();
  flat.forEach((o, f) => { const r = find(f); groups.has(r) ? groups.get(r)!.push(o) : groups.set(r, [o]); });

  const sites: RoofSite[] = [];
  for (const tris of groups.values()) {
    let area = 0, zSum = 0, zMin = Infinity, zMax = -Infinity, cx = 0, cy = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of tris) {
      const i = o * 9;
      const a = Math.abs((pos[i + 3] - pos[i]) * (pos[i + 2] - pos[i + 8]) - (pos[i + 6] - pos[i]) * (pos[i + 2] - pos[i + 5])) / 2;
      area += a;
      for (let v = 0; v < 3; v++) {
        const x = pos[i + v * 3], z = pos[i + v * 3 + 1], y = -pos[i + v * 3 + 2];
        zSum += z * a / 3; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
        cx += x * a / 3; cy += y * a / 3;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    if (area < PARAPET_MIN_AREA || zMax - zMin > MAX_SPREAD) continue;
    const w = Math.ceil((x1 - x0) / CELL) + 1, h = Math.ceil((y1 - y0) / CELL) + 1;
    if (w > MAX_CELLS || h > MAX_CELLS) continue;
    const on = new Uint8Array(w * h);
    const edges = new Map<string, [number, number, number, number]>();
    for (const o of tris) {
      const i = o * 9;
      const p = [0, 1, 2].map((v) => [pos[i + v * 3], -pos[i + v * 3 + 2]]);
      const [[ax, ay], [bx, by], [qx, qy]] = p;
      const d = (bx - ax) * (qy - ay) - (qx - ax) * (by - ay);
      if (Math.abs(d) < 1e-9) continue;
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx, qx) - x0) / CELL)), gx1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx, qx) - x0) / CELL));
      const gy0 = Math.max(0, Math.floor((Math.min(ay, by, qy) - y0) / CELL)), gy1 = Math.min(h - 1, Math.ceil((Math.max(ay, by, qy) - y0) / CELL));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const x = x0 + (gx + 0.5) * CELL, y = y0 + (gy + 0.5) * CELL;
        const l1 = ((x - ax) * (qy - ay) - (qx - ax) * (y - ay)) / d, l2 = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / d;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) on[gy * w + gx] = 1;
      }
      for (let v = 0; v < 3; v++) {
        const [ex, ey] = p[v], [fx, fy] = p[(v + 1) % 3];
        const a = `${Math.round(ex * 100)},${Math.round(ey * 100)}`, b = `${Math.round(fx * 100)},${Math.round(fy * 100)}`;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (edges.has(k)) edges.delete(k); else edges.set(k, [ex, ey, fx, fy]);
      }
    }
    // What stands up out of the roof: a top covers the cells under it; a wall the cells
    // along it, and one more either side.
    for (let o = 0; o < n; o++) {
      const k = o * 5;
      if (tb[k + 4] <= zMin + RISE || tb[k + 2] < x0 - 1 || tb[k] > x1 + 1 || tb[k + 3] < y0 - 1 || tb[k + 1] > y1 + 1) continue;
      const i = o * 9;
      const p = [0, 1, 2].map((v) => [pos[i + v * 3], -pos[i + v * 3 + 2], pos[i + v * 3 + 1]]);
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
      const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
      const nz = ux * vy - uy * vx, nl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz);
      const block = (x: number, y: number, r: number) => {
        const gx = Math.floor((x - x0) / CELL), gy = Math.floor((y - y0) / CELL);
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const qx = gx + dx, qy = gy + dy;
          if (qx >= 0 && qy >= 0 && qx < w && qy < h) on[qy * w + qx] = 0;
        }
      };
      if (Math.abs(nz) > 0.3 * nl) {
        const gx0 = Math.max(0, Math.floor((tb[k] - x0) / CELL)), gx1 = Math.min(w - 1, Math.ceil((tb[k + 2] - x0) / CELL));
        const gy0 = Math.max(0, Math.floor((tb[k + 1] - y0) / CELL)), gy1 = Math.min(h - 1, Math.ceil((tb[k + 3] - y0) / CELL));
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
          const x = x0 + (gx + 0.5) * CELL - p[0][0], y = y0 + (gy + 0.5) * CELL - p[0][1];
          const l1 = (x * vy - vx * y) / nz, l2 = (ux * y - x * uy) / nz;
          if (l1 >= -0.1 && l2 >= -0.1 && l1 + l2 <= 1.1) on[gy * w + gx] = 0;
        }
      }
      for (let v = 0; v < 3; v++) {
        const [ax, ay] = p[v], [bx, by] = p[(v + 1) % 3], len = Math.hypot(bx - ax, by - ay);
        for (let t = 0, steps = Math.max(1, Math.ceil(len / (CELL / 2))); t <= steps; t++) block(ax + (bx - ax) * t / steps, ay + (by - ay) * t / steps, 1);
      }
    }
    const mx = cx / (area || 1), my = cy / (area || 1);
    const z = zMin - 0.05;
    sites.push({
      id: `i${Math.round(mx * 2)}_${Math.round(my * 2)}`,
      z,
      height: zSum / (area || 1) - ground(mx, my),
      area,
      box: [x0, y0, x1, y1],
      axis: dominantAxis(edges.values()),
      contains: (x, y) => {
        const gx = Math.floor((x - x0) / CELL), gy = Math.floor((y - y0) / CELL);
        return gx >= 0 && gy >= 0 && gx < w && gy < h && on[gy * w + gx] === 1;
      },
    });
  }
  return sites;
}
