import type { Point2 } from './geo.ts';

// The straight skeleton of a footprint, for its roof: every edge of the outline moves
// inwards at the same speed, and where two neighbouring edges meet as they go is a hip, a
// valley or a ridge. Each edge sweeps one slope of the roof; a point's height on it is the
// time the edge took to reach it.
//
// How it is found: the shrinking outline (the wavefront) is kept as rings of corners, each
// corner between two of the footprint's edges and moving along their bisector. Two things
// can happen to it. An edge shrinks to nothing, and its two corners become one. Or a
// re-entrant corner runs into an edge across the footprint, which cuts the ring in two (or
// joins a courtyard's ring to the outer one). The next of these is found by trying every
// edge and every pair of re-entrant corner and edge: footprints have a handful of corners,
// a few hundred at most, so that is quick. Right-angled houses make many of them happen at
// once (all four arms of a cross close at the same moment): after every step the rings are
// tidied at that same moment, see `tidy`, until nothing is left touching.
//
// Written for this game (no other library's code): plain floating point with a tolerance
// of a thousandth of a millimetre. A result that doesn't cover the footprint exactly is
// thrown away (null), and the building gets a flat roof.

/** Corners as [x, y, time] (the first ones are the footprint's own, at time 0) and one
    polygon per edge of the footprint, as indices into them, counter-clockwise. Ring by ring,
    the first polygon is the slope of the edge that ends at the ring's first point, and each
    starts at its edge's end: the order the library used before gave (straight-skeleton 3),
    which the roofs' shades and triangles go by. */
export interface Skeleton {
  vertices: [number, number, number][];
  polygons: number[][];
}

const EPS = 1e-6; // metres, and time: the wavefront moves a metre per unit of time
const RATE = 1e-9; // speeds below this count as standing still
const ANTI = 1e-14; // the square of the angle, in radians, under which two edges count as facing each other exactly
const JOIN = 1e-5; // corners of the skeleton closer than this are one
// The work grows with the cube of the corners: 350 of them (the most on one building in
// Prague) take 70 ms. Past this many the building gets a flat roof.
const MOST = 1200;

interface Corner {
  eL: number; eR: number; // the edges before and after it
  x: number; y: number; t: number; // where and when it began
  wx: number; wy: number; // its velocity
  prev: Corner; next: Corner;
  from: number; // the skeleton node it began at
  alive: boolean;
  reflex: boolean; // re-entrant
  fast: boolean; // between two edges that face each other: it has no speed, see `tidy`
}

/** `rings`: the outer ring counter-clockwise, then the holes clockwise, each without its
    first point repeated at the end. Null when no skeleton comes of it. */
export function straightSkeleton(rings: Point2[][]): Skeleton | null {
  if (!rings.length || !rings[0].length) return null;
  const ox = rings[0][0][0], oy = rings[0][0][1];
  const nodeX: number[] = [], nodeY: number[] = [], nodeT: number[] = [];
  const node = (x: number, y: number, t: number) => { nodeX.push(x); nodeY.push(y); nodeT.push(t); return nodeX.length - 1; };
  // The edges: a point on each, its direction, the normal pointing into the footprint, and
  // the normal's product with the point.
  const ex: number[] = [], ey: number[] = [], dx: number[] = [], dy: number[] = [], nx: number[] = [], ny: number[] = [], ec: number[] = [];
  const ends: [number, number][] = []; // each edge's two nodes
  const output: number[] = []; // the edges in the order of their polygons
  let live: Corner[] = [];
  let area = 0;

  const corner = (eL: number, eR: number, x: number, y: number, t: number, from: number): Corner => {
    // Its velocity takes it a metre from both edges in a unit of time: the sum of their
    // normals, scaled. (Over the sum's own length, which stays exact for edges that nearly
    // face each other, where 1 + the normals' product would not.)
    const sx = nx[eL] + nx[eR], sy = ny[eL] + ny[eR], s2 = sx * sx + sy * sy;
    const fast = s2 < ANTI;
    const c = {
      eL, eR, x, y, t, from, fast, alive: true,
      wx: fast ? 0 : 2 * sx / s2, wy: fast ? 0 : 2 * sy / s2,
      reflex: !fast && dx[eL] * dy[eR] - dy[eL] * dx[eR] < -RATE,
    } as Corner;
    live.push(c);
    return c;
  };
  const link = (a: Corner, b: Corner) => { a.next = b; b.prev = a; };

  for (let r = 0; r < rings.length; r++) {
    const pts: Point2[] = [];
    for (const [px, py] of rings[r]) {
      const x = px - ox, y = py - oy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (pts.length && Math.hypot(x - pts[pts.length - 1][0], y - pts[pts.length - 1][1]) <= EPS) continue;
      pts.push([x, y]);
    }
    while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) <= EPS) pts.pop();
    if (pts.length < 3) { if (r === 0) return null; continue; }
    const m = pts.length, e0 = ex.length, n0 = nodeX.length;
    for (let i = 0; i < m; i++) {
      const [x, y] = pts[i], [x2, y2] = pts[(i + 1) % m];
      const len = Math.hypot(x2 - x, y2 - y);
      ex.push(x); ey.push(y);
      dx.push((x2 - x) / len); dy.push((y2 - y) / len);
      nx.push(-(y2 - y) / len); ny.push((x2 - x) / len);
      ec.push((-(y2 - y) * x + (x2 - x) * y) / len);
      node(x, y, 0);
      ends.push([n0 + i, n0 + (i + 1) % m]);
      output.push(e0 + (i + m - 1) % m);
      area += (x * y2 - x2 * y) / 2;
    }
    const cs = pts.map(([x, y], i) => corner(e0 + (i + m - 1) % m, e0 + i, x, y, 0, n0 + i));
    cs.forEach((c, i) => link(c, cs[(i + 1) % m]));
  }
  const edges = ex.length, own = nodeX.length; // (the nodes before `own` are the footprint's corners)
  if (!(area > EPS) || edges > MOST) return null;

  // The skeleton's arcs: from one node to another, between the slopes of two edges.
  const arcs: [number, number, number, number][] = [];
  const arc = (a: number, b: number, eL: number, eR: number) => { if (a !== b) arcs.push([a, b, eL, eR]); };
  const end = (c: Corner, at: number) => { arc(c.from, at, c.eL, c.eR); c.alive = false; };
  const X = (c: Corner, t: number) => c.x + (t - c.t) * c.wx, Y = (c: Corner, t: number) => c.y + (t - c.t) * c.wy;

  // An edge of the wavefront, from u to the next corner, has shrunk to nothing.
  const collapse = (u: Corner, t: number) => {
    const w = u.next, x = (X(u, t) + X(w, t)) / 2, y = (Y(u, t) + Y(w, t)) / 2, at = node(x, y, t);
    end(u, at); end(w, at);
    const c = corner(u.eL, w.eR, x, y, t, at);
    link(u.prev, c); link(c, w.next);
  };

  // Everything that happens at the moment t without the wavefront moving on: rings of two
  // corners are finished, edges without length collapse, and a corner between two edges that
  // have met face to face runs along them to its nearer neighbour, closing them like a zip.
  const tidy = (t: number) => {
    for (let guard = 0; ; guard++) {
      if (guard > 20 * edges + 100) return false;
      let changed = false;
      for (const u of live) {
        if (!u.alive) continue;
        const w = u.next;
        if (w === u) { end(u, node(X(u, t), Y(u, t), t)); changed = true; continue; }
        if (w.next === u) {
          const a = node(X(u, t), Y(u, t), t), b = node(X(w, t), Y(w, t), t);
          end(u, a); end(w, b);
          arc(a, b, u.eL, u.eR);
          changed = true;
          continue;
        }
        if (Math.hypot(X(w, t) - X(u, t), Y(w, t) - Y(u, t)) <= EPS) { collapse(u, t); changed = true; }
      }
      if (changed) { live = live.filter((c) => c.alive); continue; }
      const m = live.find((c) => c.alive && c.fast);
      if (!m) return true;
      const p = m.prev, q = m.next;
      const px = X(p, t), py = Y(p, t), qx = X(q, t), qy = Y(q, t);
      if (Math.hypot(px - m.x, py - m.y) <= Math.hypot(qx - m.x, qy - m.y)) {
        const at = node(px, py, t);
        end(m, at); end(p, at);
        const c = corner(p.eL, m.eR, px, py, t, at);
        link(p.prev, c); link(c, q);
      } else {
        const at = node(qx, qy, t);
        end(m, at); end(q, at);
        const c = corner(m.eL, q.eR, qx, qy, t, at);
        link(c, q.next); link(p, c);
      }
      live = live.filter((c) => c.alive);
    }
  };

  let t = 0;
  if (!tidy(t)) return null;
  for (let steps = 0; live.length; steps++) {
    if (steps > 20 * edges + 100) return null;
    // The next edge to shrink to nothing…
    let best = Infinity, hit: Corner | null = null, onto: Corner | null = null;
    for (const u of live) {
      const w = u.next, e = u.eR;
      const rate = dx[e] * (w.wx - u.wx) + dy[e] * (w.wy - u.wy);
      if (rate > -RATE) continue;
      const len = dx[e] * (X(w, t) - X(u, t)) + dy[e] * (Y(w, t) - Y(u, t));
      const at = t + Math.max(len, 0) / -rate;
      if (at < best) { best = at; hit = u; }
    }
    // …or the next re-entrant corner to reach an edge of the wavefront (from a to a.next),
    // if that comes sooner.
    for (const v of live) {
      if (!v.reflex) continue;
      const vx = X(v, t), vy = Y(v, t);
      for (const a of live) {
        const e = a.eR, b = a.next;
        if (a === v || b === v || e === v.eL || e === v.eR) continue;
        const rate = nx[e] * v.wx + ny[e] * v.wy - 1;
        if (rate > -RATE) continue;
        const gap = nx[e] * vx + ny[e] * vy - ec[e] - t;
        if (gap < -EPS) continue; // behind it
        const at = t + Math.max(gap, 0) / -rate;
        if (at >= best) continue;
        const ax = X(a, at), ay = Y(a, at);
        const s = dx[e] * (X(v, at) - ax) + dy[e] * (Y(v, at) - ay), len = dx[e] * (X(b, at) - ax) + dy[e] * (Y(b, at) - ay);
        if (s < -EPS || s > len + EPS) continue;
        // Reaching the very end of the edge is running into the corner there. Two corners
        // that have just come out of the same place are not running into each other (the
        // footprint's own corners came out of nowhere: a ring may touch itself at one).
        const there = s <= EPS ? a : s >= len - EPS ? b : null;
        if (there && v.t >= at - EPS && there.t >= at - EPS && v.from >= own && there.from >= own) continue;
        best = at; hit = v; onto = a;
      }
    }
    if (!hit) return null;
    t = Math.max(t, best);
    if (onto) {
      const v = hit, a = onto, b = a.next, x = X(v, t), y = Y(v, t), at = node(x, y, t);
      end(v, at);
      const c1 = corner(v.eL, a.eR, x, y, t, at), c2 = corner(a.eR, v.eR, x, y, t, at);
      link(v.prev, c1); link(c1, b);
      link(a, c2); link(c2, v.next);
    } else {
      collapse(hit, t);
    }
    live = live.filter((c) => c.alive);
    if (!tidy(t)) return null;
  }

  // Nodes at the same place are one.
  const count = nodeX.length, same = Array.from({ length: count }, (_, i) => i);
  const find = (i: number) => { while (same[i] !== i) i = same[i] = same[same[i]]; return i; };
  const order = same.slice().sort((a, b) => nodeX[a] - nodeX[b]);
  for (let i = 0; i < count; i++) {
    const a = order[i];
    for (let j = i + 1; j < count && nodeX[order[j]] - nodeX[a] <= JOIN; j++) {
      const b = order[j];
      if (Math.abs(nodeY[b] - nodeY[a]) <= JOIN && Math.abs(nodeT[b] - nodeT[a]) <= 1e-3) same[find(b)] = find(a);
    }
  }

  // Each edge's slope: from the edge's end along the arcs beside it back to its start.
  const beside: [number, number][][] = Array.from({ length: edges }, () => []);
  for (const [a, b, eL, eR] of arcs) {
    const fa = find(a), fb = find(b);
    if (fa === fb) continue;
    beside[eL].push([fa, fb]);
    if (eR !== eL) beside[eR].push([fa, fb]);
  }
  const index = new Map<number, number>();
  const vertices: [number, number, number][] = [], polygons: number[][] = [];
  const vertex = (n: number) => {
    let i = index.get(n);
    if (i === undefined) { i = vertices.length; index.set(n, i); vertices.push([nodeX[n] + ox, nodeY[n] + oy, nodeT[n]]); }
    return i;
  };
  // (The footprint's own corners come first, in their order.)
  for (const [a] of ends) vertex(find(a));
  let covered = 0;
  for (const e of output) {
    const start = find(ends[e][0]), finish = find(ends[e][1]);
    const sides = beside[e], used = new Array<boolean>(sides.length).fill(false);
    const ring = [finish];
    let at = finish, before = start;
    while (at !== start) {
      // Where several arcs leave a node (a slope that touches itself), take the one that
      // turns furthest to the left.
      let pick = -1, to = -1, turn = -Infinity;
      for (let i = 0; i < sides.length; i++) {
        if (used[i] || (sides[i][0] !== at && sides[i][1] !== at)) continue;
        const other = sides[i][0] === at ? sides[i][1] : sides[i][0];
        const ux = nodeX[at] - nodeX[before], uy = nodeY[at] - nodeY[before], vx = nodeX[other] - nodeX[at], vy = nodeY[other] - nodeY[at];
        const angle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
        if (angle > turn) { turn = angle; pick = i; to = other; }
      }
      if (pick < 0) return null;
      used[pick] = true;
      before = at; at = to;
      ring.push(at);
    }
    if (ring.length < 3) return null;
    let a2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      a2 += nodeX[p] * nodeY[q] - nodeX[q] * nodeY[p];
    }
    if (a2 < -EPS) return null;
    covered += a2 / 2;
    polygons.push(ring.map(vertex));
  }
  // The slopes together cover the footprint, no more and no less.
  if (Math.abs(covered - area) > 1e-6 * area + 1e-6) return null;
  return { vertices, polygons };
}
