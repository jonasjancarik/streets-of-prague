#!/usr/bin/env node
// Check the fixed ground order, surfaces, and the asphalt-grey pavement choice.
import assert from 'node:assert/strict';
import { COLORS, groundLayers, layerBuffers } from '../src/ground.ts';
import { PITCH_LOOKS } from '../src/map/pitches.ts';

const poly = [[[[1, 1], [9, 1], [9, 9], [1, 9]]]];
const data = (areas = {}, roads = {}) => ({ areas, roads, rails: [] });
const make = (areas, roads) => groundLayers(data(areas, roads), { box: [0, 0, 10, 10] }).layers;
const layer = (layers, color, pattern) => layers.find((item) => item.color === color && item.pattern === pattern);

const layers = make({ dtm_yard: poly, dtm_green: poly, cover_grass: poly,
  park: poly, square_setts: poly, square: poly, square_asphalt: poly,
  square_loose: poly }, { road: poly });
const base = layer(layers, COLORS.pavement, 'asphalt');
const yard = layer(layers, COLORS.dtmYard, 'concrete');
const dtmGreen = layer(layers, COLORS.park, 'lawn');
const cover = layer(layers, '#84a05a', 'grass');
const setts = layer(layers, COLORS.squareSetts, 'setts');
const slabs = layer(layers, COLORS.square, 'slabs');
const loose = layer(layers, COLORS.dirt, 'gravel');
const road = layers.findLast((item) => item.color === COLORS.asphalt && item.pattern === 'asphalt');
for (const item of [base, yard, dtmGreen, cover, setts, slabs, loose, road]) assert.ok(item);
assert.ok(base.order < yard.order && yard.order < dtmGreen.order);
assert.ok(dtmGreen.order < cover.order && cover.order < slabs.order);
assert.ok(slabs.order < setts.order && setts.order < loose.order && loose.order < road.order);
assert.equal(COLORS.pavement, '#92908c');
assert.notEqual(COLORS.dtmYard, COLORS.pavement);

// Surveyed pavements lie over the greenery and the footways' ribbons, under the
// carriageways; a tram's own bed lies over the carriageway beside it.
const paved = make({ park: poly }, { path: poly, pavement: poly, pavement_asphalt: poly, sett: poly, road: poly, trambed: poly });
const ribbon = paved.find((item) => item.color === COLORS.path && item.pattern === 'mosaic');
const mosaic = paved.findLast((item) => item.color === COLORS.path && item.pattern === 'pavement');
const plain = paved.findLast((item) => item.color === COLORS.pavement && item.pattern === 'asphalt');
const bed = layer(paved, COLORS.ballast, 'gravel');
const carriageway = paved.findLast((item) => item.color === COLORS.asphalt && item.pattern === 'asphalt');
for (const item of [ribbon, mosaic, plain, bed, carriageway]) assert.ok(item);
assert.ok(!plain.base && ribbon.order < plain.order && plain.order < mosaic.order, 'surveyed pavements over the ribbons');
assert.ok(layer(paved, COLORS.park, 'grass').order < plain.order, 'surveyed pavements over the greenery');
assert.ok(mosaic.order < layer(paved, COLORS.sett, 'setts').order && mosaic.order < carriageway.order, 'carriageways over the pavements');
assert.ok(carriageway.order < bed.order, 'a tram bed over the carriageway');
assert.equal(road.order, carriageway.order, 'the carriageway slot is stable across tiles');

const sparse = make({ square_setts: poly, dtm_pitch: poly }, {});
assert.equal(layer(sparse, COLORS.squareSetts, 'setts').order, setts.order,
  'square sett slot must be stable across tiles');
assert.ok(layer(sparse, COLORS.pitch, 'pitch'));
assert.ok(!sparse.some((item) => item.color === COLORS.paint), 'DTM pitch has no painted outline');
const courts = groundLayers({ ...data({ pitch_clay: poly, pitch_blue: poly, pitch: poly }), marks: [[[2, 2], [8, 2]]] }, { box: [0, 0, 10, 10] }).layers;
const clay = courts.find((item) => item.color === PITCH_LOOKS.find(([k]) => k === 'pitch_clay')[1]);
const blue = courts.find((item) => item.color === PITCH_LOOKS.find(([k]) => k === 'pitch_blue')[1]);
const grass = layer(courts, COLORS.pitch, 'pitch');
const paint = courts.find((item) => item.color === COLORS.paint);
assert.ok(clay && blue && grass && paint, 'each pitch look and the painted lines are drawn');
assert.ok(clay.order < grass.order && blue.order < grass.order && grass.order < paint.order, 'grass pitches over other looks, lines on top');
assert.ok(paint.geometry.hold && Math.abs(paint.geometry.hold[2] - .12) < 1e-6, 'sports lines keep their existing hold');

// All paint shares sports lines' pixel-width hold. It carries the physical width,
// not wider CPU geometry: dashes, their gaps and the road's layout stay unchanged.
const roadEdge = { u: 'a', v: 'b', hw: 'primary', width: 14, lanes: 4, pts: [[10, 50], [90, 50]] };
const roadPoly = [[[[10, 43], [90, 43], [90, 57], [10, 57]]]];
const parking = [[[[20, 15], [40, 15], [40, 20], [20, 20]]]];
const paintData = { areas: { parking }, roads: { road: roadPoly }, rails: [{ kind: 'tram', pts: [[10, 80], [90, 80]] }], crossings: [[[50, 40], [50, 60]]] };
const opts = { box: [0, 0, 100, 100], edges: [roadEdge], parkingZones: ['RES'] };
for (const height of [null, (x, y) => .002 * x * x + .01 * y]) {
  const result = groundLayers(paintData, { ...opts, height });
  const held = result.layers.filter(l => l.geometry.hold);
  assert.deepEqual([...new Set(held.map(l => Math.round(l.geometry.hold[2] * 100)))].sort((a, b) => a - b), [13, 15, 50], 'lane, bay and zebra widths');
  for (const { geometry: g } of held) {
    assert.equal(g.hold.length, g.position.length, 'terrain-added vertices also have hold offsets');
    assert.ok(g.hold.every(Number.isFinite));
    for (let i = 2; i < g.hold.length; i += 3) assert.ok(g.hold[i] > 0);
  }
  const rail = result.layers.find(l => l.color === COLORS.steel);
  assert.ok(rail && !rail.geometry.hold, 'rails keep their physical width');
  // The straight lane dividers really are 13 cm wide before the shader widens them.
  const lane = held.find(l => Math.abs(l.geometry.hold[2] - .13) < 1e-6);
  for (let i = 0; i < lane.geometry.hold.length; i += 3) assert.ok(Math.hypot(lane.geometry.hold[i], lane.geometry.hold[i + 1]) <= .06501);
  const buffers = layerBuffers(result);
  assert.ok(held.every(l => buffers.includes(l.geometry.hold.buffer)), 'worker transfers include paint attributes');
  const moved = structuredClone(result, { transfer: buffers });
  assert.ok(buffers.every(b => b.byteLength === 0), 'no copied or retained worker buffers');
  assert.ok(moved.layers.filter(l => l.geometry.hold).every(l => l.geometry.hold.length === l.geometry.position.length));
}

// Bridge/tunnel fixtures cover a whole rectangular mask; no canvas rasterisation
// is under test here. Their road paint follows the same rule as the ground's.
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() { return { beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
    getImageData: () => ({ data: new Uint8ClampedArray(this.w * this.h * 4).fill(255) }) }; }
};
try {
  const levelPoly = [[[[0, 0], [100, 0], [100, 100], [0, 100]]]];
  for (const kind of ['bridge', 'tunnel']) {
    const result = groundLayers(data(), { ...opts, edges: [{ ...roadEdge, [kind]: true, level: 1 }],
      levels: [{ kind, level: 1, polys: levelPoly, height: () => kind === 'bridge' ? 5 : -5 }] });
    const paint = result.layers.filter(l => l.color === COLORS.paint);
    assert.equal(paint.length, 2, `${kind} has dashed and solid paint`);
    assert.ok(paint.every(l => l.geometry.hold && Math.abs(l.geometry.hold[2] - .13) < 1e-6));
  }
} finally { delete globalThis.OffscreenCanvas; }
console.log('Ground layer order, fixed slots, patterns, and pavement palette passed');
console.log('Paint: ground/bay/zebra/bridge/tunnel hold widths, terrain vertices, physical rails and worker transfers passed');
