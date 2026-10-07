#!/usr/bin/env node
// The lit and dark streets' file (pipeline/build_lamps.py writes it, src/lamps.ts reads it):
// the packing read back, and what a point on, beside and away from a street is told. No browser or map.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '' };
globalThis.self = globalThis;
const { litStreets, litAt } = await import('../src/lamps.ts');

// Two streets in the file's quarter metres: a lit one east along y = 10 m with a bend north
// at x = 120 m, and a dark one parallel to it 30 m south, across the grid's cells and x = 0.
const ways = [[1, [[-200, 10], [120, 10], [120, 90]]], [0, [[-200, -20], [300, -20]]],
  // (and three streets lit by the pipeline's rules: a lamp nearby, buildings, the way to the next lit street)
  [2, [[-200, 200], [0, 200]]], [3, [[0, 200], [200, 200]]], [4, [[200, 200], [200, 400]]]];
const bytes = [];
const put = (size, write) => { const b = new DataView(new ArrayBuffer(size)); write(b); bytes.push(...new Uint8Array(b.buffer)); };
put(4, (b) => b.setUint32(0, ways.length, true));
for (const [lit, pts] of ways) {
  const q = pts.map(([x, y]) => [Math.round(x * 4), Math.round(y * 4)]);
  put(11, (b) => { b.setUint8(0, lit); b.setUint16(1, q.length, true); b.setInt32(3, q[0][0], true); b.setInt32(7, q[0][1], true); });
  for (let i = 1; i < q.length; i++) put(4, (b) => { b.setInt16(0, q[i][0] - q[i - 1][0], true); b.setInt16(2, q[i][1] - q[i - 1][1], true); });
}
const grid = litStreets(new Uint8Array(bytes).buffer);
assert.equal(litAt(grid, 0, 10), 1, 'on the lit street');
assert.equal(litAt(grid, -150, 12.5), 1, 'a lane\'s width beside it, west of the origin');
assert.equal(litAt(grid, 120, 60), 1, 'round its bend');
assert.equal(litAt(grid, 49.9, -20), 0, 'on the dark street, at a cell\'s edge');
assert.equal(litAt(grid, 250, -21), 0, 'further along the dark street');
assert.equal(litAt(grid, 0, -5), -1, 'between the two, a street the file says nothing of');
assert.equal(litAt(grid, 200, 10), -1, 'past the lit street\'s bend');
assert.equal(litAt(grid, 0, 13), 1, 'the nearer of two streets wins');
assert.deepEqual([litAt(grid, -100, 201), litAt(grid, 100, 199), litAt(grid, 201, 300)], [2, 3, 4], 'streets lit by the rules keep their reason');
assert.ok([2, 3, 4].every((f) => f >= 1), 'and count as lit for a game that only knows lit from dark');
assert.equal(litStreets(new Uint32Array([0]).buffer).size, 0, 'an empty file');
console.log('Lit streets: the file reads back, points on and beside a street match it, the nearer street wins, others are unknown.');
