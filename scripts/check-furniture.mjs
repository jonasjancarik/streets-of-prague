#!/usr/bin/env node
// Pure placement regressions; no browser, map rebuild or new dependency.
import assert from 'node:assert/strict';
import { furnitureSpots, PARK, GARDEN, YARD, FURNITURE_SIZE, KIND } from '../src/map/furniture.ts';
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

// OSM's street furniture (mappedSpots): a post box mapped by a wall hangs on it facing out,
// one out on the pavement stands on its post; nothing stands inside a building or on the road.
{
  const { mappedSpots } = await import('../src/map/furniture.ts');
  const { mappedFurniture } = await import('../src/mappedFurniture.ts');
  const house = [{ rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }];
  const road = (x, y) => y < -6;
  const m = Float32Array.of(KIND.postBox, 5, -0.5, 0, KIND.postBox, 5, -3, 0, KIND.bin, 5, 5, 0, KIND.bollard, 2, -8, 0, KIND.bikeStand, 2, -2, 0.3);
  const spots = mappedSpots(m, house, road, () => 0);
  assert.deepEqual(spots.map(s => s.kind), [KIND.wallPostBox, KIND.postBox, KIND.bikeStand], 'wall box, box on its post, bike stand; nothing in the house or on the road');
  const wall = spots[0];
  assert(Math.abs(wall.y + 0.13) < 1e-6 && Math.abs(Math.sin(wall.angle) * 0 - Math.cos(wall.angle) - -1) < 1e-6,
    `the wall box stands just off the wall with its front (+z) facing out of the house: ${wall.y}, ${wall.angle}`);
  assert.equal(FURNITURE_SIZE.length, Object.keys(KIND).length, 'every kind has a footprint');
  const file = { kinds: ['bin', 'bollard', 'nonsense'], points: [[1, 2, 0, 90], [3, 4, 1, 0], [5, 6, 2, 0]] };
  const read = await mappedFurniture('x', 1000, async () => new Response(JSON.stringify(file)));
  assert.deepEqual([...read].map(v => Math.round(v * 100) / 100), [KIND.bin, 1, 2, 1.57, KIND.bollard, 3, 4, 0], 'kinds by name, unknown ones left out, degrees to radians');
  assert.equal(await mappedFurniture('x', 1000, async () => new Response('', { status: 404 })), null, 'no file, no mapped furniture');
  console.log('Mapped street furniture: wall post boxes, buildings and roads, the file passed');
}

// A street tree in paving gets a grate round its foot; one on a lawn or out in the open doesn't.
{
  const { treeGrates } = await import('../src/map/furniture.ts');
  const lawn = [[[[20, -5], [40, -5], [40, 5], [20, 5], [20, -5]]]];
  const road = (x, y) => y < -3;
  const g = treeGrates([[0, 0], [30, 0], [0, 40], [-200, 0]], { lawn }, road, [-100, -100, 100, 100], () => 0);
  assert.deepEqual(g.map(s => [s.x, s.y, s.kind]), [[0, 0, KIND.treeGrate]], 'only the tree in the paving by the road: ' + JSON.stringify(g));
  assert(Math.sin(g[0].angle) < 0, 'turned towards the road it found');
  console.log('Tree grates: paving by a road, not lawns, not far from roads, not outside the tile');
}

// A one-way street that runs from one junction to another: a one-way sign where it starts,
// facing the traffic turning in, and a no-entry sign where it ends, facing those who would
// turn in against it, each on the right of whoever comes up to it.
{
  const { oneWaySigns } = await import('../src/map/furniture.ts');
  const e = (u, v, pts, oneway = false) => ({ u, v, hw: 'residential', oneway, pts, width: 6 });
  const drive = [e('A', 'B', [[0, 0], [100, 0]], true),
    e('A', 'C', [[0, 0], [0, 50]]), e('C', 'A', [[0, 50], [0, 0]]), e('A', 'D', [[0, 0], [0, -50]]), e('D', 'A', [[0, -50], [0, 0]]),
    e('B', 'E', [[100, 0], [100, 50]]), e('E', 'B', [[100, 50], [100, 0]]), e('B', 'F', [[100, 0], [100, -50]]), e('F', 'B', [[100, -50], [100, 0]])];
  const s = oneWaySigns(drive), signs = [];
  for (let i = 0; i < s.length; i += 4) signs.push({ kind: s[i], x: s[i + 1], y: s[i + 2], a: s[i + 3] });
  const one = signs.find(q => q.kind === KIND.oneWay), stop = signs.find(q => q.kind === KIND.noEntry);
  assert(one && stop && signs.length === 2, 'a sign at each end: ' + JSON.stringify(signs));
  // Traffic runs east: turning in at A it drives east, its right is south; the sign faces west.
  assert(one.x === 3 && one.y === -4 && Math.abs(Math.sin(one.a) + 1) < 1e-9, 'one-way sign at the start: ' + JSON.stringify(one));
  // Against it at B one would drive west, the right is north; the sign faces east.
  assert(stop.x === 97 && stop.y === 4 && Math.abs(Math.sin(stop.a) - 1) < 1e-9, 'no-entry sign at the end: ' + JSON.stringify(stop));
  console.log('One-way signs: at each end, facing the right way, on the right');
}
