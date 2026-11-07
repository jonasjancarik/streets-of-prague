import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rasterSeamCoverage, refineRasterRoad, roadRasterGeometry } from '../src/roadRaster.ts';

test('road coverage retains the terrain triangle and its original heights, and drops unused vertices', () => {
  const position = new Float32Array([0, 1, 0, 1, 2, 0, 0, 3, -1, 20, 4, 0, 21, 5, 0, 20, 6, -1]);
  const normal = Float32Array.from({ length: position.length }, (_, i) => i % 3 === 1 ? 1 : 0);
  const base = { position, normal, index: new Uint32Array([0, 1, 2, 3, 4, 5]) };
  const mask = { box: [0, 1, 1, 0], w: 2, h: 2, cells: new Uint8Array([255, 0, 0, 0]) };
  const road = roadRasterGeometry(base, mask);
  assert.deepEqual(road.index, new Uint32Array([0, 1, 2]));
  assert.deepEqual(road.position, position.slice(0, 9));
  assert.deepEqual(road.normal, normal.slice(0, 9));
  assert.equal(roadRasterGeometry(base, { ...mask, cells: new Uint8Array(4) }).index.length, 0);
});

test('shared terrain refinement follows a curved grade and leaves discontinuities to step cutting', () => {
  const pos = [0, 0, -.5, 4, 0, -.5];
  const raster = { box: [0, 1, 4, 0], w: 8, h: 2, cells: new Uint8Array(16).fill(255) };
  const curve = (x) => x * x * .03;
  assert.equal(refineRasterRoad(pos, raster, curve, null)(0, 1, 16), true);
  assert.equal(refineRasterRoad(pos, raster, (x) => x * .15, null)(0, 1, 16), false);
  assert.equal(refineRasterRoad(pos, raster, curve, (x) => x > 2 ? 2 : 0)(0, 1, 16), false);
});

test('diagonal road outlines agree at the common tile edge', () => {
  const left = [[[[-1, 0], [0, .2], [0, 1.8], [-1, 1.4]]]];
  const right = [[[[0, .2], [1, .7], [1, 2], [0, 1.8]]]];
  const expected = new Uint8Array([153, 255, 255, 153]);
  assert.deepEqual(rasterSeamCoverage(left, 0, 0, 2, 4), expected);
  assert.deepEqual(rasterSeamCoverage(right, 0, 0, 2, 4), expected);
});
