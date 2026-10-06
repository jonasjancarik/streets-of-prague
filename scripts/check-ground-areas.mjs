#!/usr/bin/env node
// Check the fixed ground order, surfaces, and the asphalt-grey pavement choice.
import assert from 'node:assert/strict';
import { COLORS, groundLayers } from '../src/ground.ts';
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
const cover = layer(layers, '#8fa860', 'grass');
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
const mosaic = paved.findLast((item) => item.color === COLORS.path && item.pattern === 'mosaic');
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
console.log('Ground layer order, fixed slots, patterns, and pavement palette passed');
