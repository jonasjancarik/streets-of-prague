import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundLayers, COLORS } from '../src/ground.ts';
import { readRoadSurfaces, withRoadSurfaces } from '../src/roadSurfaces.ts';

const weights = Array.from({ length: 21 * 21 }, (_, i) => {
  const x = i % 21, y = Math.floor(i / 21);
  return x && y && x < 20 && y < 20 ? 255 : 0;
});
const patch = { id: 'junction', box: [0, 0, 20, 20], n: [21, 21], weights,
  z: [101, .2, -.1, .15, .1, -.1], tiles: ['0_0', '1_0'] };
const file = { version: 1, area: 'praha', built: 'new', patches: [patch] };
const rect = (x0, y0, x1, y1) => [[[x0,y0], [x1,y0], [x1,y1], [x0,y1]]];

test('a trial is tied to its map and must feather out at the edge of its grid', () => {
  assert.equal(readRoadSurfaces(file, 'praha', 'old'), null);
  assert.deepEqual(readRoadSurfaces(file, 'praha', 'new').get('1_0'), [patch]);
  assert.equal(readRoadSurfaces({ ...file, patches: [{ ...patch, weights: [255, ...weights.slice(1)] }] }, 'praha', 'new'), null);
});

test('a height grid blends into the junction below it and respects terrain steps', () => {
  const grid = { ...patch, id: 'corridor', z: undefined,
    heights: weights.map((_, i) => 103 + (i % 21) * .1),
    weights: weights.map((w, i) => i % 21 < 11 ? Math.min(w, 128) : w) };
  const layers = readRoadSurfaces({ ...file, patches: [grid, patch] }, 'praha', 'new');
  const baseline = () => 0;
  const side = (_x, y) => y < 4 ? 2 : 0;
  const prior = withRoadSurfaces(baseline, [patch], 100, side);
  const h = withRoadSurfaces(baseline, layers.get('0_0'), 100, side);
  assert.ok(Math.abs(h(10, 10) - (4 * 128 + prior(10, 10) * 127) / 255) < 1e-10);
  assert.ok(Math.abs(h(11.5, 10) - 4.15) < 1e-10);
  assert.equal(h(10, 3), 0);
  assert.equal(h(0, 10), prior(0, 10));
  assert.equal(readRoadSurfaces({ ...file, patches: [{ ...grid, heights: [103] }] }, 'praha', 'new'), null);
});

test('a lowering-only grid preserves lower heights already supplied by a junction', () => {
  const grid = { ...patch, id: 'cutting', z: undefined, heights: weights.map(() => 103), lowerOnly: true };
  const data = readRoadSurfaces({ ...file, patches: [grid, patch] }, 'praha', 'new');
  const sampled = withRoadSurfaces(() => 10, data.get('0_0'), 100, null);
  assert.equal(sampled(10, 10), withRoadSurfaces(() => 10, [patch], 100, null)(10, 10));
  assert.equal(withRoadSurfaces(() => 10, [grid], 100, null)(10, 10), 3);
});

test('an intersection surface keeps the retaining wall and water on separate levels', () => {
  const side = (x, y) => y < 4 ? 2 : 0;
  const base = (x, y, s = false) => s === true ? -2 : (s === false ? side(x,y) : s) === 2 ? -1 : 0;
  const h = withRoadSurfaces(base, [patch], 100, side);
  assert.ok(Math.abs(h(10, 10) - 1) < 1e-9);
  assert.equal(h(10, 3), -1);
  assert.equal(h(10, 3, 2), -1);
  assert.equal(h(10, 3, true), -2);
  assert.ok(h(10, 4, 0) > .8);
  assert.equal(h(0, 10), 0);
  const steps = [{ label: 2, polys: [rect(0, 0, 20, 4)] }];
  const layers = groundLayers({ roads: { road: [rect(3, 2, 17, 15)] }, areas: {}, rails: [] },
    { box: [0, 0, 20, 20], steps, height: h, roadSurfaceBoxes: [patch.box] }).layers;
  const mesh = layers.find((l) => l.color === COLORS.asphalt).geometry.position;
  const lower = [], upper = [];
  for (let i = 0; i < mesh.length; i += 3) {
    if (mesh[i + 2] > -3.9) lower.push(mesh[i + 1]);
    if (mesh[i + 2] < -4.1) upper.push(mesh[i + 1]);
  }
  assert.ok(lower.length > 0 && upper.length > 0);
  assert.ok(lower.every((z) => z === -1));
  assert.ok(upper.every((z) => z > .7));
});

test('a patch may carry its grids packed as base64', () => {
  const heights = weights.map((_, i) => 103 + (i % 21) * .1);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  // Each row as the change from the node before it, wrapping round at 16 bits.
  const steps = heights.map((h) => Math.round((h - 104) / 0.001));
  const q = new Int16Array(steps.map((v, i) => i % 21 ? v - steps[i - 1] : v));
  const packed = { ...patch, id: 'packed', z: undefined, weights: b64(Uint8Array.from(weights)),
    heights: { base: 104, step: 0.001, data: b64(new Uint8Array(q.buffer)) } };
  const [got] = readRoadSurfaces({ ...file, patches: [packed] }, 'praha', 'new').get('0_0');
  assert.deepEqual(got.weights, weights);
  assert.ok(got.heights.every((h, i) => Math.abs(h - heights[i]) < 6e-4));
  assert.equal(readRoadSurfaces({ ...file, patches: [{ ...packed, weights: b64(Uint8Array.from(weights.slice(1))) }] }, 'praha', 'new'), null);
  assert.equal(readRoadSurfaces({ ...file, patches: [{ ...packed, heights: { ...packed.heights, step: 0 } }] }, 'praha', 'new'), null);
});

test('a node the patch does not cover adds nothing to the height beside it', () => {
  // Street nodes at 240 m up to x = 10; past them a wall's top at 244 m, weight 0.
  const n = 21;
  const w = weights.map((v, i) => (i % n) <= 10 ? v : 0);
  const heights = weights.map((_, i) => (i % n) <= 10 ? 240 : 244);
  const h = withRoadSurfaces(() => 0, [{ ...patch, z: undefined, weights: w, heights }], 0, null);
  // Half a metre short of the wall: half the strength, and the street's own height.
  assert.ok(Math.abs(h(10.5, 10) - 0.5 * 240) < 1e-9);
});
