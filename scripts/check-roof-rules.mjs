#!/usr/bin/env node
// Checks the roof rules for OSM-only buildings (src/map/roofRules.ts): the share of flat
// roofs and the colour classes on a made-up village, and the parapet inset on awkward rings;
// and the things on flat roofs (src/map/roofDetails.ts): where they stand and how many.
import assert from 'node:assert/strict';
import { roofShapeFor, pitchedColour, cellOf, insetRings } from '../src/map/roofRules.ts';
import { ringSite, planDetails, partArrays } from '../src/map/roofDetails.ts';

const house = (i, w = 9, d = 11) => {
  const x = (i % 40) * 20, y = Math.floor(i / 40) * 20;
  return { id: 'w' + i, kind: 'yes', h: 7, minh: 0, rings: [[[x, y], [x + w, y], [x + w, y + d], [x, y + d]]] };
};
const village = Array.from({ length: 800 }, (_, i) => house(i));
let flat = 0;
const tally = {};
for (const b of village) {
  const cell = cellOf([0, 0], b.rings[0]);
  if (roofShapeFor(b, cell) === 'flat') flat++;
  else tally[pitchedColour(b, cell, 0.5)] = 1;
}
const share = flat / village.length;
assert(share > 0.05 && share < 0.45, 'flat share of houses ' + share);
assert(Object.keys(tally).length >= 4, 'pitched colours vary');

const big = { id: 'shop', kind: 'retail', h: 6, minh: 0, rings: [[[0, 0], [60, 0], [60, 30], [0, 30]]] };
assert.equal(roofShapeFor(big, '0,0'), 'flat');
assert.notEqual(roofShapeFor({ ...big, id: 'f', kind: 'farm', rings: [[[0, 0], [12, 0], [12, 9], [0, 9]]] }, '0,0'), 'flat');
assert.notEqual(roofShapeFor({ ...big, id: 'c', church: true, kind: 'yes' }, '0,0'), 'flat');

const square = insetRings([[[0, 0], [10, 0], [10, 10], [0, 10]]], 0.3);
assert.deepEqual(square[0].map((p) => p.map((v) => Math.round(v * 100) / 100)), [[0.3, 0.3], [9.7, 0.3], [9.7, 9.7], [0.3, 9.7]]);
const sliver = insetRings([[[0, 0], [10, 0], [10, 0.4], [0, 0.4]]], 0.3);
assert.equal(sliver, null, 'a ring thinner than twice the inset gets no parapet');

// Things on flat roofs.
const rect = (x, y, w, d) => [[x, y], [x + w, y], [x + w, y + d], [x, y + d]];
const corners = (p) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [p.x + p.c * u * p.a / 2 - p.s * v * p.b / 2, p.y + p.s * u * p.a / 2 + p.c * v * p.b / 2]);
const inside = (ring, [x, y]) => { let o = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) o = !o; } return o; };
const detailsOf = (id, kind, rings, height) => { const s = ringSite({ id, kind }, rings, 0, height); return s ? planDetails(s) : []; };
const tris = (parts) => partArrays(parts, 0, () => 0).position.length / 9;

assert.equal(ringSite({ id: 'shed', kind: 'yes' }, [rect(0, 0, 6, 8)], 0, 3), null, 'a small roof gets nothing');
const blockRing = [rect(0, 0, 60, 18), rect(24, 6, 10, 6).reverse()]; // a block with a courtyard
const keep = (parts, rings) => parts.every((p) => corners(p).every((c) => inside(rings[0], c) && !rings.slice(1).some((h) => inside(h, c))));
const lifts = [], vents = [];
let blockTris = 0, hallTris = 0, houseTris = 0, withSolar = 0;
for (let i = 0; i < 200; i++) {
  const block = detailsOf('blk' + i, 'apartments', blockRing, 21);
  assert(keep(block, blockRing), 'parts stay on the roof and off the courtyard');
  assert(block.some((p) => p.shape === 'box' && p.top === 5), 'a tall block has a lift house');
  lifts.push(block.filter((p) => p.top === 5).length);
  blockTris += tris(block);
  if (block.some((p) => p.shape === 'panel')) withSolar++;
  const hall = detailsOf('hall' + i, 'retail', [rect(0, 0, 80, 40)], 7);
  assert(hall.some((p) => p.shape === 'skylight'), 'a hall has skylights');
  assert(!hall.some((p) => p.top === 5), 'a hall has no lift house');
  hallTris += tris(hall);
  const flatHouse = detailsOf('fh' + i, 'house', [rect(0, 0, 9, 10)], 6);
  assert(flatHouse.length <= 3 && keep(flatHouse, [rect(0, 0, 9, 10)]), 'a small flat house gets a vent or two at most');
  houseTris += tris(flatHouse);
}
assert.deepEqual(detailsOf('same', 'school', [rect(0, 0, 50, 20)], 12), detailsOf('same', 'school', [rect(0, 0, 50, 20)], 12), 'the same roof gets the same things');
const solarShare = withSolar / 200;
assert(solarShare > 0.05 && solarShare < 0.3, 'solar on a share of blocks ' + solarShare);
const arrays = partArrays(detailsOf('x', 'school', [rect(0, 0, 50, 20)], 12), 10, () => 2);
assert(arrays.position.every(Number.isFinite) && arrays.facade.length / 12 === arrays.position.length / 9 && arrays.normal.length === arrays.position.length);
console.log('roof details ok: triangles per roof, block %d, hall %d, flat house %d; solar on %d %% of blocks', blockTris / 200, hallTris / 200, houseTris / 200, solarShare * 100);
console.log('roof rules ok, flat share of houses', share.toFixed(2));
