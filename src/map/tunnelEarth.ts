// The elevation survey describes the ground viewed from above. Where it dips across
// a mapped tunnel its triangles can run through the traffic lane. Split those
// triangles at the lane outline once in the worker. From inside, only the part
// outside the bore is drawn. From the street above the original surface is whole.
import { ShapeUtils, Vector2 } from 'three';
import type { Polygons } from './geo.ts';
import type { GroundLayer } from '../surface.ts';

type Plane = (x: number, h: number, y: number) => number;
interface Prism {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  bottom: number;
  top: number;
  sides: Plane[];
}
type Geometry = GroundLayer['geometry'];

// A tile may hold both carriageways of a long tunnel and several slip roads.
// Most of its street triangles are nowhere near those bores.
export class TunnelIndex {
  private cells: (Prism[] | undefined)[];
  private x0: number;
  private y0: number;
  private width: number;
  private height: number;
  private hits: Prism[] = [];
  private seen = new Set<Prism>();
  constructor(prisms: Prism[]) {
    this.x0 = Math.floor(Math.min(...prisms.map((p) => p.x0)) / 16);
    this.y0 = Math.floor(Math.min(...prisms.map((p) => p.y0)) / 16);
    this.width = Math.floor(Math.max(...prisms.map((p) => p.x1)) / 16) - this.x0 + 1;
    this.height = Math.floor(Math.max(...prisms.map((p) => p.y1)) / 16) - this.y0 + 1;
    this.cells = prisms.length ? new Array(this.width * this.height) : [];
    for (const p of prisms) {
      for (let j = Math.floor(p.y0 / 16); j <= Math.floor(p.y1 / 16); j++) {
        for (let i = Math.floor(p.x0 / 16); i <= Math.floor(p.x1 / 16); i++) {
          // A long diagonal triangle can cover several rows of empty cells within its box.
          if (
            p.sides.slice(0, 3).some((side) =>
              Math.max(
                side(i * 16, 0, j * 16),
                side((i + 1) * 16, 0, j * 16),
                side(i * 16, 0, (j + 1) * 16),
                side((i + 1) * 16, 0, (j + 1) * 16),
              ) < -1e-7
            )
          ) {
            continue;
          }
          (this.cells[(j - this.y0) * this.width + i - this.x0] ??= []).push(p);
        }
      }
    }
  }
  near(x0: number, y0: number, x1: number, y1: number) {
    const left = Math.max(0, Math.floor(x0 / 16) - this.x0), bottom = Math.max(0, Math.floor(y0 / 16) - this.y0);
    const right = Math.min(this.width - 1, Math.floor(x1 / 16) - this.x0),
      top = Math.min(this.height - 1, Math.floor(y1 / 16) - this.y0);
    if (left > right || bottom > top) return;
    if (left === right && bottom === top) return this.cells[bottom * this.width + left];
    this.hits.length = 0;
    this.seen.clear();
    for (let j = bottom; j <= top; j++) {
      for (let i = left; i <= right; i++) {
        const cell = this.cells[j * this.width + i];
        if (!cell) continue;
        for (const p of cell) {
          if (!this.seen.has(p)) {
            this.seen.add(p);
            this.hits.push(p);
          }
        }
      }
    }
    return this.hits.length ? this.hits : undefined;
  }
}

export function tunnelPrisms(polys: Polygons, floor: (x: number, y: number) => number): Prism[] {
  const prisms: Prism[] = [];
  for (const rings of polys) {
    if (!rings[0]?.length) continue;
    const contours = rings.map((r) => r.map(([x, y]) => new Vector2(x, y)));
    const tris = ShapeUtils.triangulateShape(contours[0], contours.slice(1)), pts = contours.flat();
    for (const ids of tris) {
      const [a, b, c] = ids.map((i) => pts[i]);
      const cross = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(cross) < 1e-7) continue;
      const corners = [a, b, c], heights = corners.map((p) => floor(p.x, p.y));
      const [ha, hb, hc] = heights;
      const dx = ((hb - ha) * (c.y - a.y) - (hc - ha) * (b.y - a.y)) / cross;
      const dy = ((hc - ha) * (b.x - a.x) - (hb - ha) * (c.x - a.x)) / cross;
      const delta: Plane = (x, h, y) => h - ha - (x - a.x) * dx - (y - a.y) * dy;
      const sides: Plane[] = corners.map((p, i) => {
        const q = corners[(i + 1) % 3], sign = Math.sign(cross);
        return (x, _h, y) => ((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x)) * sign;
      });
      sides.push((x, h, y) => delta(x, h, y) + 1, (x, h, y) => 6 - delta(x, h, y));
      prisms.push({
        x0: Math.min(a.x, b.x, c.x),
        x1: Math.max(a.x, b.x, c.x),
        y0: Math.min(a.y, b.y, c.y),
        y1: Math.max(a.y, b.y, c.y),
        bottom: Math.min(...heights) - 1,
        top: Math.max(...heights) + 6,
        sides,
      });
    }
  }
  return prisms;
}

// Keep both sides in a single index buffer. A draw range switches them without
// uploading geometry or adding a draw call. Interpolate paint, shadows and other
// attached attributes exactly like the uncut triangle.
export function splitTunnelEarth(g: Geometry, index: TunnelIndex) {
  if (!g.index.length) return;
  const position = g.position, outside: number[] = [], inside: number[] = [];
  const entries = Object.entries(g).filter(([key]) => key !== 'index') as [Exclude<keyof Geometry, 'index'>, Float32Array][];
  const attrs = entries.map(([key, src]) => ({
    key,
    src,
    stride: src.length / (position.length / 3),
    extra: [] as number[],
  }));
  const xyz = attrs.find((a) => a.key === 'position')!;
  const read = (a: typeof xyz, i: number) => i < a.src.length ? a.src[i] : a.extra[i - a.src.length];
  const p = (i: number, k: number) => read(xyz, i * 3 + k);
  function meet(a: number, b: number, t: number) {
    const id = (position.length + xyz.extra.length) / 3;
    for (const attr of attrs) {
      for (let k = 0; k < attr.stride; k++) {
        const v = read(attr, a * attr.stride + k);
        attr.extra.push(v + t * (read(attr, b * attr.stride + k) - v));
      }
    }
    return id;
  }
  function fan(r: number[], to: number[]) {
    for (let i = 1; i < r.length - 1; i++) to.push(r[0], r[i], r[i + 1]);
  }
  for (let j = 0; j < g.index.length; j += 3) {
    const a = g.index[j], b = g.index[j + 1], c = g.index[j + 2];
    const ai = a * 3, bi = b * 3, ci = c * 3;
    const x0 = Math.min(position[ai], position[bi], position[ci]), x1 = Math.max(position[ai], position[bi], position[ci]);
    const y0 = -Math.max(position[ai + 2], position[bi + 2], position[ci + 2]),
      y1 = -Math.min(position[ai + 2], position[bi + 2], position[ci + 2]);
    const prisms = index.near(x0, y0, x1, y1);
    if (!prisms) {
      outside.push(a, b, c);
      continue;
    }
    const lo = Math.min(position[ai + 1], position[bi + 1], position[ci + 1]),
      hi = Math.max(position[ai + 1], position[bi + 1], position[ci + 1]);
    let parts: number[][] | undefined;
    for (const prism of prisms) {
      if (x0 > prism.x1 || x1 < prism.x0 || y0 > prism.y1 || y1 < prism.y0 || lo > prism.top || hi < prism.bottom) continue;
      const rest: number[][] = [];
      for (const part of parts ?? [[a, b, c]]) {
        const saved: number[][] = [];
        let kept = part;
        for (const side of prism.sides) {
          const d = kept.map((id) => side(p(id, 0), p(id, 1), -p(id, 2)));
          if (d.every((v) => v >= -1e-7)) continue;
          if (d.every((v) => v <= 1e-7)) {
            kept = [];
            break;
          }
          const yes: number[] = [], no: number[] = [];
          for (let i = 0; i < kept.length; i++) {
            const k = (i + 1) % kept.length, v = d[i], w = d[k];
            if (v >= -1e-7) yes.push(kept[i]);
            if (v <= 1e-7) no.push(kept[i]);
            if ((v > 1e-7 && w < -1e-7) || (v < -1e-7 && w > 1e-7)) {
              const id = meet(kept[i], kept[k], v / (v - w));
              yes.push(id);
              no.push(id);
            }
          }
          saved.push(no);
          kept = yes;
        }
        if (kept.length < 3) {
          rest.push(part);
          continue;
        }
        fan(kept, inside);
        rest.push(...saved);
      }
      parts = rest;
      if (!parts.length) break;
    }
    if (parts) { for (const r of parts) fan(r, outside); }
    else outside.push(a, b, c);
  }
  if (!inside.length) return;
  for (const { key, src, extra } of attrs) {
    if (extra.length) {
      const out = new Float32Array(src.length + extra.length);
      out.set(src);
      out.set(extra, src.length);
      g[key] = out;
    }
  }
  const ordered = new Uint32Array(outside.length + inside.length);
  ordered.set(outside);
  ordered.set(inside, outside.length);
  g.index = ordered;
  return outside.length;
}
