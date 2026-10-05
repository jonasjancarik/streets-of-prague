#!/usr/bin/env node
// Checks the roof rules for OSM-only buildings (src/map/roofRules.ts): the share of flat
// roofs and the colour classes on a made-up village, and the parapet inset on awkward rings.
import assert from 'node:assert/strict';
import { roofShapeFor, pitchedColour, cellOf, insetRings } from '../src/map/roofRules.ts';

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
console.log('roof rules ok, flat share of houses', share.toFixed(2));
