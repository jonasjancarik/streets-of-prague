#!/usr/bin/env node
// Pure placement regressions; no browser, map rebuild or new dependency.
import assert from 'node:assert/strict';
import { furnitureSpots, PARK, GARDEN, YARD, FURNITURE_SIZE } from '../src/map/furniture.ts';
import { furnitureSurvey } from '../src/furnitureSurvey.ts';
const box = [-100, -100, 100, 100];
const context = { zone: () => PARK, clear: () => true, height: () => 0, path: (x, y) => ({ x, y: y + 4, distance: 4, halfWidth: 1 }) };
const spots = furnitureSpots(box, context);
assert(spots.length > 20 && spots.some(p => p.kind === 0) && spots.some(p => p.kind === 1));
assert.deepEqual(furnitureSpots(box, context), spots, 'repeated builds are identical');
assert.deepEqual(furnitureSpots(box, { ...context, zone: () => 0 }), [], 'unmapped gaps stay empty');
assert.deepEqual(furnitureSpots(box, { ...context, zone: () => 255 }), [], 'unknown/outside grid stays empty');
assert.deepEqual(furnitureSpots(box, { ...context, path: () => null }), [], 'park benches need mapped footways');
for (const distance of [0, 1, 9, 15]) assert.deepEqual(furnitureSpots(box, { ...context, path: (x, y) => ({ x, y, distance, halfWidth: 1 }) }), [], 'path clearance/useful distance');
assert.deepEqual(furnitureSpots(box, { ...context, clear: () => false }), [], 'obstacles exclude padded footprints');
assert.deepEqual(furnitureSpots(box, { ...context, height: () => NaN }), [], 'missing terrain is rejected');
assert.deepEqual(furnitureSpots(box, { ...context, height: x => x }), [], 'steep slopes are rejected');
const yard = furnitureSpots(box, { ...context, zone: () => YARD, path: () => null });
assert(yard.length > 5 && yard.every(p => p.kind === 2), 'closed courtyards only receive sparse planters');
assert(yard.length < spots.length, 'courtyard density is lower');
assert(furnitureSpots(box, { ...context, zone: () => GARDEN }).length > 5);
const beside = furnitureSpots(box, { ...context, path: (x, y) => ({ x, y: 0, distance: Math.abs(y), halfWidth: 1 }) });
assert(beside.length > 0, 'real path-edge candidates survive');
for (const p of beside) {
  const edge = Math.abs(p.y) - 1;
  assert(edge >= (p.kind === 0 ? 1.9 : 1.7) && edge <= (p.kind === 0 ? 2.2 : 2), 'objects stay at modest path edge setback');
  assert(Math.cos(p.angle) * -Math.sign(p.y) > 0.99, 'bench front faces the path');
}
const left = furnitureSpots([-100, -100, 3, 100], context), right = furnitureSpots([3, -100, 100, 100], context);
assert.deepEqual(furnitureSpots([3, -100, 100, 100], context), right, 'tile construction order does not matter');
const ids = p => `${p.x}/${p.y}`;
assert.equal(new Set([...left, ...right].map(ids)).size, left.length + right.length, 'no seam duplicates');
assert([...left, ...right].every(p => spots.some(q => ids(q) === ids(p))), 'map-fixed placement across shifted tile edges');
for (const p of [...left, ...right]) assert(Math.abs(p.x - 3) >= 12, 'inset protects footprint and neighbouring crowns at seams');
// An obstacle under the centre or a tiny interior strip must reject the whole item.
const target = spots[0];
const blocked = furnitureSpots(box, { ...context, clear: (x, y) => Math.hypot(x - target.x, y - target.y) > 0.35 });
assert(!blocked.some(p => ids(p) === ids(target)), 'footprint interiors checked');
const holes = furnitureSpots(box, { ...context, zone: (x, y) => Math.hypot(x - target.x, y - target.y) < 0.6 ? 0 : PARK });
assert(!holes.some(p => ids(p) === ids(target)), 'land-use holes rejected');
for (let a = 0; a < spots.length; a++) for (let b = a + 1; b < spots.length; b++) {
  const radius = p => Math.hypot(...FURNITURE_SIZE[p.kind]);
  assert(Math.hypot(spots[a].x - spots[b].x, spots[a].y - spots[b].y) > radius(spots[a]) + radius(spots[b]) + 1.6, 'lattice keeps furniture apart');
}
console.log(JSON.stringify({ assertions: 'passed', park: spots.length, yard: yard.length, seam: left.length + right.length }));
const bytes = new Uint8Array(13); new DataView(bytes.buffer).setUint32(0, 1, true); new Float32Array(bytes.buffer, 4, 2).set([5, 6]);
const okay = async () => new Response(bytes);
assert.deepEqual(Array.from(await furnitureSurvey('test', 100, okay)), [5, 6], 'survey parsing');
assert.equal(await furnitureSurvey('test', 100, async () => new Response(new Uint8Array(2))), null, 'malformed evidence disables furniture');
let signal, release;
const hanging = (_url, opts) => { signal = opts.signal; return new Promise(resolve => release = resolve); };
const pending = furnitureSurvey('test', 20, hanging);
assert.equal(await pending, null, 'hung evidence is bounded by deadline');
assert(signal.aborted, 'timeout aborts fetch');
release(new Response(bytes));
assert.equal(await pending, null, 'late evidence cannot change outcome for later tiles');
console.log('Survey parsing, deadline, abort and immutable unavailable outcome passed');
