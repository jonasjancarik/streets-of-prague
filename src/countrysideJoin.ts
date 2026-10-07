// Where the countryside's generated streets (countryside.ts) meet the built map's (plan
// 021, step 2). The built map's streets don't stop at its edge: each runs on to its next
// junction, a hundred metres out or five kilometres. Out there the built street stands
// and the generated one over it goes; at the built street's outer end the generated
// junction takes the built one's id and place, so the two graphs are one and the road
// has no kink. No three.js and no DOM.
import type { Bounds, Point2 } from './map/geo.ts';
import type { RawStreetEdge } from './network.ts';

// On a map without leaving.json: how far from a vector tile the built map's rim is
// searched for streets that reach it. The longest in `praha` runs 5.4 km out
// (scripts/check-countryside.mjs checks it).
export const REACH = 7000;
const JOIN = 10; // metres from a built street's outer end to the generated junction that is the same one
const SPLIT = 4; // … or to a generated street passing it with no junction there
const SAME = 1.5; // metres within which any generated junction is the built one
const COVER = 3; // metres between a built street and the generated line of the same street
export const TAPER = 30; // metres over which a moved junction's streets bend and change width

// A built street that leaves the built map: the edge as its tile has it, the parts of
// it outside, and its ends out there.
export interface Stub {
  graph: 'drive' | 'walk'; edge: RawStreetEdge; outside: Point2[][]; box: Bounds;
  ends: { id: string; at: Point2 }[];
}
// A generated street. `drive` and `walk` say which graphs it is in; `widths` its width
// at each point where that isn't `width` all along.
export interface JoinEdge {
  u: string; v: string; hw: string; width: number; pts: Point2[]; box: Bounds;
  drive: boolean; walk: boolean; widths?: number[];
}

export const boxOf = (pts: Point2[]): Bounds => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
};
export const meet = (a: Bounds, b: Bounds, pad = 0) => a[0] <= b[2] + pad && a[2] >= b[0] - pad && a[1] <= b[3] + pad && a[3] >= b[1] - pad;

const r2 = (v: number) => Math.round(v * 100) / 100;
// The nearest point of a line to p: how far, in which stretch and how far along it.
function nearest(p: Point2, pts: Point2[]) {
  let best = { d: Infinity, i: 0, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]);
    if (d < best.d) best = { d, i, t };
  }
  return best;
}
// The distance along a line to each of its points.
function lengths(pts: Point2[]) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}
// A street's surface width: kerb to kerb where the built map measured or set it.
export const paved = (e: RawStreetEdge): [number, number] => [e.kerb?.[1] ?? e.width / 2, e.kerb?.[0] ?? e.width / 2]; // left, right

// The generated streets of one vector tile joined to the built streets near it: those a
// built street covers are taken out of that street's graph (and dropped when no graph is
// left), and the junction at a built street's outer end becomes the built junction.
// `others` are the streets of the vector tiles next to this one: a built end goes to
// the nearest junction or street whichever tile that is in (and is then that tile's to
// deal with), so the tiles either side of a shared edge rename a junction on it alike.
export function joinEdges<E extends JoinEdge>(edges: E[], stubs: Stub[], box: Bounds, others: JoinEdge[] = []): E[] {
  if (!stubs.length) return edges;
  const anchors = new Map<string, { id: string; at: Point2; stubs: Stub[] }>();
  for (const s of stubs) {
    for (const end of s.ends) {
      if (!meet([end.at[0], end.at[1], end.at[0], end.at[1]], box, JOIN * 2)) continue;
      const a = anchors.get(end.id) ?? { id: end.id, at: end.at, stubs: [] };
      a.stubs.push(s);
      anchors.set(end.id, a);
    }
  }

  // A built end on a generated street with no junction there, or none nearer than
  // `than` (a side street the vector tiles leave out; a junction rebuilt since the map
  // was made): the street gets a junction at that point.
  const moved = new Map<string, { id: string; at: Point2; d: number; stubs: Stub[] }>(); // by generated junction
  const done = new Set<string>();
  const split = (a: { id: string; at: Point2; stubs: Stub[] }, than: number) => {
    let best: { k: number; i: number; t: number; d: number } | null = null;
    const all = [...edges, ...others];
    for (let k = 0; k < all.length; k++) {
      if (!meet(all[k].box, [a.at[0], a.at[1], a.at[0], a.at[1]], SPLIT)) continue;
      const hit = nearest(a.at, all[k].pts);
      if (hit.d <= SPLIT && hit.d < than && (!best || hit.d < best.d)) best = { k, ...hit };
    }
    if (!best) return;
    if (best.k >= edges.length) { // the next vector tile's street
      const pts = all[best.k].pts, i = best.i, part = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if ((i > 0 || best.t * part >= 0.5) && (i < pts.length - 2 || (1 - best.t) * part >= 0.5)) done.add(a.id);
      return;
    }
    const e = edges[best.k], p = e.pts[best.i], q = e.pts[best.i + 1];
    const on: Point2 = [r2(p[0] + (q[0] - p[0]) * best.t), r2(p[1] + (q[1] - p[1]) * best.t)], id = `j${a.id}`;
    const first = [...e.pts.slice(0, best.i + 1), on], second = [on, ...e.pts.slice(best.i + 1)];
    if (lengths(first).at(-1)! < 0.5 || lengths(second).at(-1)! < 0.5) return; // at the street's own end: a junction already
    edges = [...edges.slice(0, best.k), { ...e, v: id, pts: first, box: boxOf(first) }, { ...e, u: id, pts: second, box: boxOf(second) }, ...edges.slice(best.k + 1)];
    moved.set(id, { ...a, d: best.d });
    done.add(a.id);
  };

  // Each built end and the generated junction nearest it, nearest pairs first. A street
  // cut at the built map's edge ("r…") ends there, not at a junction.
  const junctions = new Map<string, Point2>();
  for (const e of [...others, ...edges]) {
    for (const [id, p] of [[e.u, e.pts[0]], [e.v, e.pts[e.pts.length - 1]]] as [string, Point2][]) if (id[0] !== 'r') junctions.set(id, p);
  }
  const pairs: { a: string; j: string; d: number }[] = [];
  for (const a of anchors.values()) {
    let least = Infinity;
    for (const p of junctions.values()) least = Math.min(least, Math.hypot(p[0] - a.at[0], p[1] - a.at[1]));
    split(a, least - 2);
    if (done.has(a.id)) continue;
    for (const [j, p] of junctions) {
      const d = Math.hypot(p[0] - a.at[0], p[1] - a.at[1]);
      if (d <= JOIN) pairs.push({ a: a.id, j, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d || (p.a < q.a ? -1 : p.a > q.a ? 1 : 0) || (p.j < q.j ? -1 : 1));
  for (const { a, j, d } of pairs) {
    if (done.has(a) || moved.has(j)) continue;
    done.add(a);
    moved.set(j, { ...anchors.get(a)!, d });
  }
  for (const a of anchors.values()) if (!done.has(a.id)) split(a, Infinity);
  // A second generated junction right at a built end (the vector tiles cut a road at
  // their edge, a pace from its real junction) is the same junction too.
  for (const [j, p] of junctions) {
    if (moved.has(j)) continue;
    for (const a of anchors.values()) {
      const d = Math.hypot(p[0] - a.at[0], p[1] - a.at[1]);
      if (d <= SAME && done.has(a.id)) { moved.set(j, { ...a, d }); break; }
    }
  }

  // Covered: every few metres of the generated street lie on a built one of that graph
  // (or, at an end that is a built junction, within the distance the two were apart).
  const covered = (e: E, graph: Stub['graph']) => {
    const near = stubs.filter((s) => s.graph === graph && meet(s.box, e.box, COVER));
    if (!near.length) return false;
    const ends = [moved.get(e.u), moved.get(e.v)].filter((m) => m?.stubs.some((s) => near.includes(s)));
    const on = (p: Point2) => near.some((s) => nearest(p, s.edge.pts).d <= COVER)
      || ends.some((m) => Math.hypot(p[0] - m!.at[0], p[1] - m!.at[1]) <= m!.d + COVER);
    for (let i = 0; i < e.pts.length - 1; i++) {
      const a = e.pts[i], b = e.pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / COVER));
      for (let k = i ? 1 : 0; k <= n; k++) if (!on([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n])) return false;
    }
    return true;
  };

  const out: E[] = [];
  for (const edge of edges) {
    const e = { ...edge, drive: edge.drive && !covered(edge, 'drive'), walk: edge.walk && !covered(edge, 'walk') };
    if (!e.drive && !e.walk) continue;
    const from = moved.get(e.u), to = moved.get(e.v);
    if (from || to) {
      if (from && to && from.id === to.id) continue; // a stub of a street at the junction itself
      // The street bends to the built junction over its first metres, and starts as
      // wide as the built street it carries on from.
      const s = lengths(e.pts), L = s[s.length - 1], reach = Math.min(TAPER, L);
      const wide = (m: typeof from) => {
        const same = m?.stubs.find((b) => b.edge.hw === e.hw && (b.graph === 'drive') === e.drive);
        if (!same) return null;
        const [left, right] = paved(same.edge);
        return left + right;
      };
      const w0 = wide(from), w1 = wide(to);
      // Points where the bend and the widening end, so a long straight stretch keeps its line.
      let pts = e.pts, at = s;
      for (const cut of [...new Set([reach, L - reach])]) {
        if (cut <= 0.5 || cut >= L - 0.5) continue;
        const i = at.findIndex((v) => v >= cut);
        if (i < 1 || at[i] - cut < 0.5 || cut - at[i - 1] < 0.5) continue;
        const t = (cut - at[i - 1]) / (at[i] - at[i - 1]), a = pts[i - 1], b = pts[i];
        pts = [...pts.slice(0, i), [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ...pts.slice(i)];
        at = lengths(pts);
      }
      const widths: number[] = [];
      pts = pts.map(([x, y], i): Point2 => {
        const k0 = Math.max(0, 1 - at[i] / reach), k1 = Math.max(0, 1 - (L - at[i]) / reach);
        widths.push(r2(e.width + (w0 === null ? 0 : (w0 - e.width) * k0) + (w1 === null ? 0 : (w1 - e.width) * k1)));
        const dx = (from ? (from.at[0] - e.pts[0][0]) * k0 : 0) + (to ? (to.at[0] - e.pts[e.pts.length - 1][0]) * k1 : 0);
        const dy = (from ? (from.at[1] - e.pts[0][1]) * k0 : 0) + (to ? (to.at[1] - e.pts[e.pts.length - 1][1]) * k1 : 0);
        return [r2(x + dx), r2(y + dy)];
      });
      e.u = from?.id ?? e.u;
      e.v = to?.id ?? e.v;
      e.pts = pts;
      e.box = boxOf(pts);
      if (w0 !== null || w1 !== null) e.widths = widths;
    }
    out.push(e);
  }
  return out;
}

// The grid of ground heights for a tile (i, j) past the built map, from the built tile
// nearest it (`from`, n × n): flat outwards from the nearest point of the built map's
// edge, so the shared points of the two tiles are the same numbers and the ground has
// no step (the pipeline's outer ring does the same past IPR's terrain).
export function edgeGrid(from: Uint16Array, n: number, i: number, j: number, cols: number, rows: number): Uint16Array {
  const out = new Uint16Array(n * n);
  for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) out[b * n + a] = from[(j < 0 ? 0 : j >= rows ? n - 1 : b) * n + (i < 0 ? 0 : i >= cols ? n - 1 : a)];
  return out;
}

// Over how many metres past the built map's tiles the ground goes from the flat carried
// on from the map's edge to the hills.
export const HILLS_FROM = 500;
// The two put together for a tile (i, j) past the built map: at the map's edge the flat
// (the built tile's own numbers, so no step), HILLS_FROM metres out the hills, and an
// even swing between. A point's share depends only on where it is, so tiles agree on
// the points they share.
export function blendHeights(flat: Uint16Array, hills: Uint16Array, n: number, T: number, i: number, j: number, cols: number, rows: number): Uint16Array {
  const out = new Uint16Array(n * n);
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const x = (i + a / (n - 1)) * T, y = (j + b / (n - 1)) * T; // from the grid's south-west corner
      const d = Math.hypot(Math.max(0, -x, x - cols * T), Math.max(0, -y, y - rows * T));
      const k = Math.min(1, d / HILLS_FROM), w = k * k * (3 - 2 * k);
      out[b * n + a] = Math.round(flat[b * n + a] * (1 - w) + hills[b * n + a] * w);
    }
  }
  return out;
}
