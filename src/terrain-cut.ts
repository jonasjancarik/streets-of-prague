// Cut draped triangles at the surveyed step outlines. Classifying just their corners
// misses narrow terraces, islands and three sides meeting inside a triangle.
import * as THREE from 'three';
import type { Point2, Polygons } from './map/geo.ts';

const CELL = 16;
const EPS = 1e-7; // m: only suppress numerical slivers
interface Segment { a: Point2; b: Point2; nx: number; ny: number }

// Built once per tile, shared by its ground layers. Only nearby outline segments are
// visited; the height lattice and the rest of the ground keep their existing density.
export class TerrainStepIndex {
  private segments: Segment[] = [];
  private cells = new Map<string, number[]>();
  private seen: Uint32Array;
  private stamp = 0;

  constructor(polys: Polygons) {
    const unique = new Set<string>();
    for (const rings of polys) for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        if (len <= EPS) continue;
        const ka = `${Math.round(a[0] / EPS)},${Math.round(a[1] / EPS)}`, kb = `${Math.round(b[0] / EPS)},${Math.round(b[1] / EPS)}`;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        if (unique.has(key)) continue;
        unique.add(key);
        const id = this.segments.length;
        this.segments.push({ a, b, nx: -dy / len, ny: dx / len });
        for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
          for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
            const key = `${x},${y}`;
            const cell = this.cells.get(key);
            if (cell) cell.push(id); else this.cells.set(key, [id]);
          }
        }
      }
    }
    this.seen = new Uint32Array(this.segments.length);
  }

  near(x0: number, y0: number, x1: number, y1: number) {
    if (++this.stamp > 0xffffffff) { this.seen.fill(0); this.stamp = 1; }
    const out: Segment[] = [];
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) {
        for (const id of this.cells.get(`${x},${y}`) ?? []) {
          if (this.seen[id] === this.stamp) continue;
          this.seen[id] = this.stamp;
          const s = this.segments[id];
          if (Math.max(s.a[0], s.b[0]) < x0 || Math.min(s.a[0], s.b[0]) > x1
            || Math.max(s.a[1], s.b[1]) < y0 || Math.min(s.a[1], s.b[1]) > y1) continue;
          out.push(s);
        }
      }
    }
    return out;
  }
}

interface Vertex { x: number; y: number; alpha: number; original?: number }
const distance = (s: Segment, p: Vertex) => (p.x - s.a[0]) * s.nx + (p.y - s.a[1]) * s.ny;

// Clip the segment's parameter range to a convex triangle. Its supporting line only
// counts if the actual finite outline enters the triangle, including an enclosed ring.
function enters(s: Segment, tri: Vertex[]) {
  const cx = (tri[0].x + tri[1].x + tri[2].x) / 3, cy = (tri[0].y + tri[1].y + tri[2].y) / 3;
  let lo = 0, hi = 1;
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3], dx = b.x - a.x, dy = b.y - a.y;
    const sign = Math.sign(dx * (cy - a.y) - dy * (cx - a.x));
    const da = sign * (dx * (s.a[1] - a.y) - dy * (s.a[0] - a.x));
    const db = sign * (dx * (s.b[1] - a.y) - dy * (s.b[0] - a.x));
    if (da < 0 && db < 0) return false;
    if (da < 0) lo = Math.max(lo, da / (da - db));
    else if (db < 0) hi = Math.min(hi, da / (da - db));
    if (lo > hi) return false;
  }
  return hi - lo > 1e-10;
}

function split(poly: Vertex[], s: Segment): Vertex[][] {
  const ds = poly.map((p) => distance(s, p));
  if (!ds.some((d) => d > EPS) || !ds.some((d) => d < -EPS)) return [poly];
  const left: Vertex[] = [], right: Vertex[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = ds[i], db = ds[(i + 1) % poly.length];
    if (da >= -EPS) left.push(a);
    if (da <= EPS) right.push(a);
    if ((da > EPS && db < -EPS) || (da < -EPS && db > EPS)) {
      const t = da / (da - db);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, alpha: a.alpha + (b.alpha - a.alpha) * t };
      left.push(p); right.push(p);
    }
  }
  return [left, right];
}

function simplify(ring: Vertex[]) {
  // Extensions leave collinear vertices on the triangle's original edges.
  // Remove them: retaining them on only one tile could crack on a curved height field.
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) <= EPS * (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y))) {
        ring.splice(i, 1); changed = true; break;
      }
    }
  }
  return ring;
}

// Join arrangement cells on the same side before triangulation. This removes the
// supporting-line extensions, including artificial vertices on a tile's outer edge.
// Only actual step intersections remain there, so independently cut neighbours agree.
function outline(parts: Vertex[][], sign: number) {
  const key = (p: Vertex) => `${Math.round(p.x / EPS)},${Math.round(p.y / EPS)}`;
  const canonical = new Map<string, Vertex>();
  const edges = new Map<string, { a: Vertex; b: Vertex; from: string; to: string }>();
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const a0 = part[i], b0 = part[(i + 1) % part.length], from = key(a0), to = key(b0);
      if (from === to) continue;
      if (!canonical.has(from)) canonical.set(from, a0);
      if (!canonical.has(to)) canonical.set(to, b0);
      const reverse = `${to}|${from}`;
      if (edges.has(reverse)) edges.delete(reverse);
      else edges.set(`${from}|${to}`, { a: canonical.get(from)!, b: canonical.get(to)!, from, to });
    }
  }
  const outgoing = new Map<string, string[]>();
  for (const [id, edge] of edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(id); else outgoing.set(edge.from, [id]);
  }
  const rings: Vertex[][] = [];
  while (edges.size) {
    let [id, edge] = edges.entries().next().value!;
    const start = edge.from, ring: Vertex[] = [];
    for (;;) {
      ring.push(edge.a); edges.delete(id);
      if (edge.to === start) break;
      const choices = (outgoing.get(edge.to) ?? []).filter((id) => edges.has(id));
      if (!choices.length) throw new Error('Open terrain step outline');
      // At a point where two pieces touch, follow the piece with the inside on
      // the same side, rather than making a figure-eight through both pieces.
      const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y;
      id = choices.reduce((best, next) => {
        const turn = (id: string) => {
          const q = edges.get(id)!, ex = q.b.x - q.a.x, ey = q.b.y - q.a.y;
          return sign * Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey);
        };
        return turn(next) > turn(best) ? next : best;
      });
      edge = edges.get(id)!;
    }
    simplify(ring);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function area(ring: Vertex[]) {
  let sum = 0;
  const origin = ring[0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    sum += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  }
  return sum / 2;
}

function inside(p: Vertex, ring: Vertex[]) {
  let on = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) on = !on;
  }
  return on;
}

export function cutTerrainSteps(pos: number[], idx: number[], extra: number[] | null,
  at: (x: number, y: number) => number, steps: TerrainStepIndex) {
  const vertices: Vertex[] = [];
  for (let i = 0; i < pos.length / 3; i++) vertices.push({ x: pos[i * 3], y: -pos[i * 3 + 2], alpha: extra?.[i] ?? 0, original: i });
  const position: number[] = [], index: number[] = [], side: number[] = [], alpha: number[] | null = extra ? [] : null;
  const ids = new Map<number | string, number>();
  const labelsAtVertices: number[] = [];
  const vertex = (p: Vertex, label: number) => {
    const key = p.original !== undefined ? p.original * 256 + label
      : `${Math.round(p.x / EPS)},${Math.round(p.y / EPS)}:${label}${extra ? `:${Math.fround(p.alpha)}` : ''}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = position.length / 3;
      position.push(p.x, 0, -p.y); side.push(label); alpha?.push(p.alpha);
      ids.set(key, id);
    }
    return id;
  };
  for (let k = 0; k < idx.length; k += 3) {
    const tri = [vertices[idx[k]], vertices[idx[k + 1]], vertices[idx[k + 2]]];
    const signed = (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y) - (tri[1].y - tri[0].y) * (tri[2].x - tri[0].x);
    if (Math.abs(signed) <= EPS * EPS) continue;
    const sign = Math.sign(signed);
    const [a, b, c] = tri;
    const nearby = steps.near(Math.min(a.x, b.x, c.x), Math.min(a.y, b.y, c.y), Math.max(a.x, b.x, c.x), Math.max(a.y, b.y, c.y));
    const segments = nearby.filter((s) => {
      const da = distance(s, a), db = distance(s, b), dc = distance(s, c);
      return Math.min(da, db, dc) < -EPS && Math.max(da, db, dc) > EPS && enters(s, tri);
    });
    if (!segments.length) {
      // With no outline touching even its box, any corner lies on the same side as
      // the interior. Reuse its label instead of a polygon query per plain triangle.
      const label = nearby.length ? at((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3)
        : (labelsAtVertices[a.original!] ??= at(a.x, a.y));
      index.push(vertex(a, label), vertex(b, label), vertex(c, label));
      continue;
    }
    let parts = [tri];
    for (const s of segments) parts = parts.flatMap((part) => split(part, s));
    const bySide = new Map<number, Vertex[][]>();
    for (const part of parts) {
      const label = at(part.reduce((sum, p) => sum + p.x, 0) / part.length, part.reduce((sum, p) => sum + p.y, 0) / part.length);
      const list = bySide.get(label);
      if (list) list.push(part); else bySide.set(label, [part]);
    }
    if (bySide.size === 1) {
      const label = bySide.keys().next().value!;
      index.push(vertex(a, label), vertex(b, label), vertex(c, label));
      continue;
    }
    for (const [label, cells] of bySide) {
      if (cells.length === 1) {
        const ring = simplify(cells[0].slice());
        for (let i = 1; i < ring.length - 1; i++) {
          const A = ring[0], B = ring[i], C = ring[i + 1];
          const signed = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
          if (Math.abs(signed) > EPS * EPS) index.push(vertex(A, label), vertex(B, label), vertex(C, label));
        }
        continue;
      }
      const rings = outline(cells, sign);
      const outer = rings.filter((r) => area(r) * sign > EPS * EPS), holes = rings.filter((r) => area(r) * sign < -EPS * EPS);
      const assigned = new Map<Vertex[], Vertex[][]>(outer.map((ring) => [ring, []]));
      for (const hole of holes) {
        const owner = outer.filter((r) => inside(hole[0], r)).sort((a, b) => Math.abs(area(a)) - Math.abs(area(b)))[0];
        if (!owner) throw new Error('Terrain step hole has no outer ring');
        assigned.get(owner)!.push(hole);
      }
      for (const ring of outer) {
        const inner = assigned.get(ring)!, flat = [ring, ...inner].flat();
        const vectors = (r: Vertex[]) => r.map((p) => new THREE.Vector2(p.x, p.y));
        const tris = THREE.ShapeUtils.triangulateShape(vectors(ring), inner.map(vectors));
        for (let [a, b, c] of tris) {
          const A = flat[a], B = flat[b], C = flat[c];
          const signed = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
          if (Math.abs(signed) <= EPS * EPS) continue;
          if (Math.sign(signed) !== sign) [b, c] = [c, b];
          index.push(vertex(flat[a], label), vertex(flat[b], label), vertex(flat[c], label));
        }
      }
    }
  }
  return { pos: position, idx: index, side, extra: alpha };
}
