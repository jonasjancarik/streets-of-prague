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
