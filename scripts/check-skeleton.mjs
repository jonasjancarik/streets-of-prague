#!/usr/bin/env node
// Checks the straight skeleton the pitched roofs are built on (src/map/skeleton.ts): the
// known skeletons of simple footprints, footprints a mapper's slips make awkward, and a few
// thousand made-up ones, each checked for being a roof at all: one slope per wall, every
// slope rising a metre per metre from its wall, the slopes together covering the footprint.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { straightSkeleton } from '../src/map/skeleton.ts';

const area = (ring) => ring.reduce((s, p, i) => s + p[0] * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * p[1], 0) / 2;

// What every skeleton must be, whatever the footprint. `walls`: how many slopes to expect
// (the footprint's edges, less any the skeleton drops as repeated points).
function sound(sk, rings, name, walls = rings.reduce((s, r) => s + r.length, 0)) {
  assert(sk, `${name}: no skeleton`);
  assert.equal(sk.polygons.length, walls, `${name}: one slope per wall`);
  let covered = 0;
  for (const face of sk.polygons) {
    const ring = face.map((i) => sk.vertices[i]);
    assert(ring.length >= 3, `${name}: a slope of ${ring.length} corners`);
    assert(ring.every((v) => v.every(Number.isFinite)), `${name}: a corner that is not a number`);
    const a = area(ring);
    assert(a > -1e-9, `${name}: a slope turned inside out`);
    covered += a;
    // The slope's wall runs from its last corner to its first, both on the ground…
    const p = ring[ring.length - 1], q = ring[0], len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    assert(p[2] === 0 && q[2] === 0 && len > 0, `${name}: a slope without its wall`);
    // …and every corner is as high as it is far from that wall.
    for (const v of ring) {
      const far = ((q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0])) / len;
      assert(Math.abs(far - v[2]) < 1e-5 * (1 + v[2]), `${name}: a corner ${v[2]} high, ${far} from its wall`);
    }
  }
  const foot = rings.reduce((s, r) => s + area(r), 0);
  assert(Math.abs(covered - foot) < 1e-6 * (1 + foot), `${name}: slopes cover ${covered} of ${foot}`);
  return sk;
}
// The skeleton's own corners (above the ground), as sorted text.
const tops = (sk) => sk.vertices.filter((v) => v[2] > 0).map((v) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0).join(' ')).sort();
const expect = (name, rings, corners) => {
  const sk = sound(straightSkeleton(rings), rings, name);
  assert.deepEqual(tops(sk), corners.map((v) => v.join(' ')).sort(), name);
  return sk;
};

// A rectangle: a ridge between two hips. The first slope belongs to the wall that ends at the
// first point, and each slope starts at its wall's end: the roof builder's gable ends and
// shades go by that order.
{
  const sk = expect('rectangle', [[[0, 0], [10, 0], [10, 6], [0, 6]]], [[3, 3, 3], [7, 3, 3]]);
  assert.deepEqual(sk.polygons.map((p) => p.length), [3, 4, 3, 4]);
  assert.deepEqual(sk.polygons.map((p) => sk.vertices[p[0]].slice(0, 2)), [[0, 0], [10, 0], [10, 6], [0, 6]]);
  assert.deepEqual(sk.vertices.slice(0, 4), [[0, 0, 0], [10, 0, 0], [10, 6, 0], [0, 6, 0]]);
}
expect('square', [[[0, 0], [6, 0], [6, 6], [0, 6]]], [[3, 3, 3]]);
expect('triangle', [[[0, 0], [6, 0], [0, 8]]], [[2, 2, 2]]);
expect('L', [[[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]], [[2, 2, 2], [8, 2, 2], [2, 8, 2]]);
expect('U', [[[0, 0], [12, 0], [12, 10], [8, 10], [8, 4], [4, 4], [4, 10], [0, 10]]], [[2, 2, 2], [10, 2, 2], [2, 8, 2], [10, 8, 2]]);
expect('T', [[[4, 0], [8, 0], [8, 6], [12, 6], [12, 10], [0, 10], [0, 6], [4, 6]]], [[6, 2, 2], [6, 8, 2], [2, 8, 2], [10, 8, 2]]);
// A cross: its four arms close and its four inner corners meet in the middle, all at once.
const cross = [[1, -3], [1, -1], [3, -1], [3, 1], [1, 1], [1, 3], [-1, 3], [-1, 1], [-3, 1], [-3, -1], [-1, -1], [-1, -3]];
expect('cross', [cross], [[0, 0, 1], [2, 0, 1], [-2, 0, 1], [0, 2, 1], [0, -2, 1]]);
// An H: the bar's two walls meet along their whole length, between the legs' ridges.
expect('H', [[[0, 0], [2, 0], [2, 4], [6, 4], [6, 0], [8, 0], [8, 10], [6, 10], [6, 6], [2, 6], [2, 10], [0, 10]]],
  [[1, 1, 1], [1, 5, 1], [1, 9, 1], [7, 1, 1], [7, 5, 1], [7, 9, 1]]);
// A block round a courtyard: a ridge all the way round, halfway between street and yard.
{
  const sk = expect('courtyard', [[[0, 0], [20, 0], [20, 20], [0, 20]], [[8, 8], [8, 12], [12, 12], [12, 8]]], [[4, 4, 4], [16, 4, 4], [16, 16, 4], [4, 16, 4]]);
  assert.equal(sk.polygons.length, 8);
}
// Two courtyards, and a courtyard off-centre: the ring's ridge splits and joins.
sound(straightSkeleton([[[0, 0], [40, 0], [40, 20], [0, 20]], [[6, 6], [6, 14], [14, 14], [14, 6]], [[24, 5], [24, 15], [35, 15], [35, 5]]]), [[[0, 0], [40, 0], [40, 20], [0, 20]], [[6, 6], [6, 14], [14, 14], [14, 6]], [[24, 5], [24, 15], [35, 15], [35, 5]]], 'two courtyards');
sound(straightSkeleton([[[0, 0], [30, 0], [30, 20], [0, 20]], [[3, 3], [3, 9], [8, 9], [8, 3]]]), [[[0, 0], [30, 0], [30, 20], [0, 20]], [[3, 3], [3, 9], [8, 9], [8, 3]]], 'a courtyard in a corner');

// The same shapes turned and moved far from the origin, as footprints are: what happened at
// once now happens a hair apart, and the roof must be the same roof.
for (const [name, ring, top, count] of [['cross', cross, 1, 5], ['H', [[0, 0], [2, 0], [2, 4], [6, 4], [6, 0], [8, 0], [8, 10], [6, 10], [6, 6], [2, 6], [2, 10], [0, 10]], 1, 6]]) {
  for (let k = 1; k <= 60; k++) {
    const a = k * 0.1047, c = Math.cos(a), s = Math.sin(a), scale = 1 + (k % 7) * 0.613;
    const turned = [ring.map(([x, y]) => [1234.5 + scale * (x * c - y * s), -987.25 + scale * (x * s + y * c)])];
    const sk = sound(straightSkeleton(turned), turned, `${name} turned ${k}`);
    assert(Math.abs(Math.max(...sk.vertices.map((v) => v[2])) - top * scale) < 1e-6, `${name} turned ${k}: its top`);
    // (Corners a hair apart may come out as two; none may be anywhere new.)
    const far = new Set(sk.vertices.filter((v) => v[2] > 0).map((v) => `${Math.round(v[0] * 1e4)} ${Math.round(v[1] * 1e4)}`));
    assert.equal(far.size, count, `${name} turned ${k}: ${far.size} corners`);
  }
}

// What mappers' slips leave behind.
{
  // Points in the middle of a straight wall: the same roof, the seams between the wall's two
  // slopes running straight up to the ridge.
  const sk = sound(straightSkeleton([[[0, 0], [5, 0], [10, 0], [10, 6], [4, 6], [0, 6], [0, 3]]]), [[[0, 0], [5, 0], [10, 0], [10, 6], [4, 6], [0, 6], [0, 3]]], 'points along the walls');
  assert.deepEqual(tops(sk), ['3 3 3', '4 3 3', '5 3 3', '7 3 3']);
  // A point repeated, and the first point repeated at the end: dropped.
  const twice = [[[0, 0], [10, 0], [10, 0], [10, 6], [0, 6], [0, 0]]];
  assert.deepEqual(tops(sound(straightSkeleton(twice), [[[0, 0], [10, 0], [10, 6], [0, 6]]], 'a point twice', 4)), ['3 3 3', '7 3 3']);
  // A wall a millimetre long, and a step of a millimetre in a wall.
  const tiny = [[[0, 0], [10, 0], [10, 6], [0.001, 6], [0, 5.999]]];
  sound(straightSkeleton(tiny), tiny, 'a wall of a millimetre');
  const step = [[[0, 0], [10, 0], [10, 3], [10.001, 3], [10.001, 6], [0, 6]]];
  sound(straightSkeleton(step), step, 'a step of a millimetre');
  // Walls not quite parallel, by a hundredth of a millimetre and by a centimetre.
  for (const off of [1e-9, 1e-7, 1e-5, 1e-2]) {
    const ring = [[[0, 0], [30, 0], [30, 6 + off], [0, 6]]];
    const sk2 = sound(straightSkeleton(ring), ring, `walls ${off} off parallel`);
    assert(Math.abs(Math.max(...sk2.vertices.map((v) => v[2])) - 3) < 0.01);
  }
  // A ring that touches itself at a point: two squares joined at a corner.
  const pinched = [[[0, 0], [4, 0], [4, 4], [8, 4], [8, 8], [4, 8], [4, 4], [0, 4]]];
  assert.deepEqual(tops(sound(straightSkeleton(pinched), pinched, 'a ring touching itself')), ['2 2 2', '6 6 2']);
  // A spike without width sticking out of a wall, and a slit cut into the roof: either a
  // sound skeleton or none.
  for (const [name, ring] of [['a spike', [[0, 0], [10, 0], [10, 3], [13, 3], [10, 3], [10, 6], [0, 6]]], ['a slit', [[0, 0], [10, 0], [10, 3], [6, 3], [10, 3], [10, 6], [0, 6]]]]) {
    const sk3 = straightSkeleton([ring]);
    if (sk3) assert(sk3.vertices.every((v) => v.every(Number.isFinite)), name);
  }
}

// No footprint at all: nothing, and no crash.
assert.equal(straightSkeleton([]), null);
assert.equal(straightSkeleton([[]]), null);
assert.equal(straightSkeleton([[[0, 0], [1, 1]]]), null, 'two points');
assert.equal(straightSkeleton([[[0, 0], [5, 0], [10, 0]]]), null, 'three points in a line');
assert.equal(straightSkeleton([[[0, 0], [1, 0], [1, 0], [0, 0]]]), null, 'a line there and back');
assert.equal(straightSkeleton([[[0, 0], [0, 6], [10, 6], [10, 0]]]), null, 'the outer ring clockwise');
assert.equal(straightSkeleton([[[0, 0], [NaN, 0], [10, 6]]]), null, 'not a number');
// A ring crossing itself, or a hole reaching outside: no roof can be right, so none, or at
// least a sound one; and it comes back.
for (const rings of [[[[0, 0], [10, 6], [10, 0], [0, 6]]], [[[0, 0], [10, 0], [10, 10], [0, 10]], [[5, 5], [5, 15], [15, 15], [15, 5]]], [[[0, 0], [10, 0], [10, 10], [0, 10]], [[2, 2], [8, 2], [8, 8], [2, 8]]]]) {
  const sk = straightSkeleton(rings);
  if (sk) assert(sk.vertices.every((v) => v.every(Number.isFinite)));
}

// Made-up footprints: houses of grid squares (many things at once) and stars (nothing at
// once), some with a courtyard, turned, stretched and rounded to the centimetre as the map's are.
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
function gridHouse(N) {
  for (;;) {
    const g = Array.from({ length: N }, () => new Array(N).fill(false));
    for (let k = 0, n = 2 + Math.floor(rnd() * 4); k < n; k++) {
      const x0 = Math.floor(rnd() * N), y0 = Math.floor(rnd() * N), x1 = x0 + 1 + Math.floor(rnd() * (N - x0)), y1 = y0 + 1 + Math.floor(rnd() * (N - y0));
      for (let i = x0; i < x1; i++) for (let j = y0; j < y1; j++) g[i][j] = true;
    }
    if (rnd() < 0.5) g[1 + Math.floor(rnd() * (N - 2))][1 + Math.floor(rnd() * (N - 2))] = false;
    const at = (i, j) => i >= 0 && j >= 0 && i < N && j < N && g[i][j];
    let pinch = false, count = 0, first = null;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const a = at(i - 1, j - 1), b = at(i, j - 1), c = at(i - 1, j), d = at(i, j);
      if ((a && d && !b && !c) || (b && c && !a && !d)) pinch = true;
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (g[i][j]) { count++; first ??= [i, j]; }
    if (pinch || count < 2) continue;
    const seen = new Set([first.join()]), stack = [first];
    while (stack.length) { const [i, j] = stack.pop(); for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) if (at(a, b) && !seen.has(a + ',' + b)) { seen.add(a + ',' + b); stack.push([a, b]); } }
    if (seen.size !== count) continue;
    // The outline: each square's sides that face the outside, footprint on the left, joined up.
    const next = new Map();
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (g[i][j]) {
      if (!at(i, j - 1)) next.set(`${i},${j}`, [i + 1, j]);
      if (!at(i + 1, j)) next.set(`${i + 1},${j}`, [i + 1, j + 1]);
      if (!at(i, j + 1)) next.set(`${i + 1},${j + 1}`, [i, j + 1]);
      if (!at(i - 1, j)) next.set(`${i},${j + 1}`, [i, j]);
    }
    const rings = [];
    while (next.size) {
      const start = next.keys().next().value, ring = [];
      let k = start;
      do { ring.push(k.split(',').map(Number)); const q = next.get(k); next.delete(k); k = q.join(); } while (k !== start);
      const keep = rnd() < 0.3; // some keep points in the middle of their walls
      rings.push(ring.filter((p, i) => { const a = ring[(i + ring.length - 1) % ring.length], b = ring[(i + 1) % ring.length]; return (b[0] - p[0]) * (p[1] - a[1]) !== (b[1] - p[1]) * (p[0] - a[0]) || (keep && rnd() < 0.5); }));
    }
    return rings.sort((a, b) => area(b) - area(a));
  }
}
function star() {
  const n = 3 + Math.floor(rnd() * 25), rings = [[]];
  for (let i = 0; i < n; i++) { const a = (i + rnd() * 0.8) / n * Math.PI * 2, r = 6 + rnd() * 14; rings[0].push([Math.cos(a) * r, Math.sin(a) * r]); }
  if (n >= 10 && rnd() < 0.5) { rings.push([]); for (let i = 0, m = 3 + Math.floor(rnd() * 6); i < m; i++) { const a = -(i + rnd() * 0.8) / m * Math.PI * 2, r = 0.5 + rnd() * 2; rings[1].push([Math.cos(a) * r, Math.sin(a) * r]); } }
  return rings;
}
let made = 0, slowest = 0;
for (let k = 0; k < 4000; k++) {
  const grid = rnd() < 0.7, mode = rnd(), sx = mode < 0.3 ? 1 : 1 + rnd() * 5, sy = mode < 0.6 ? sx : 1 + rnd() * 5;
  const turn = rnd() < 0.4 ? 0 : rnd() * Math.PI, c = Math.cos(turn), s = Math.sin(turn), ox = (rnd() - 0.5) * 2000, oy = (rnd() - 0.5) * 2000, round = rnd() < 0.5;
  const rings = (grid ? gridHouse(3 + Math.floor(rnd() * 5)) : star()).map((r) => r.map(([x, y]) => {
    const px = ox + x * sx * c - y * sy * s, py = oy + x * sx * s + y * sy * c;
    return round ? [Math.round(px * 100) / 100, Math.round(py * 100) / 100] : [px, py];
  }));
  const t0 = performance.now();
  const sk = straightSkeleton(rings);
  slowest = Math.max(slowest, performance.now() - t0);
  sound(sk, rings, `made-up footprint ${k} ${JSON.stringify(rings)}`);
  made++;
}

// A round tower of 300 walls, and one of 1500 (too many: no roof, and quickly).
{
  const round = (n) => [Array.from({ length: n }, (_, i) => [Math.cos(i / n * Math.PI * 2) * 20, Math.sin(i / n * Math.PI * 2) * 15])];
  const t0 = performance.now();
  sound(straightSkeleton(round(300)), round(300), 'a round tower');
  const took = performance.now() - t0;
  assert(took < 2000, `a round tower took ${took} ms`);
  assert.equal(straightSkeleton(round(1500)), null);
}

console.log(`skeletons OK: the known shapes, the awkward ones and ${made} made-up footprints (slowest ${slowest.toFixed(1)} ms)`);
