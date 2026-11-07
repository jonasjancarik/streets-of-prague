// The ground by a step read through its step line (src/terrain.ts, heightSampler and
// stepLineIndex): the line's height on the point's side near it, and the lattice's where
// the line is far off the lattice and has a step the lattice doesn't (another place's
// ground with the same label).
//   node scripts/test-step-lines.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heightSampler, stepLineIndex, lineReach } from '../src/terrain.ts';

// A 16 m square of lattice, 4 m cells: plain ground (label 0) at 0 m west of x = 8, a
// terrace (label 2) at `top` (3 m) from x = 8 east. The step's line runs north along
// x = 8, the plain ground on its left.
const n = 5, step = 4;
const side = (x) => (x >= 8 ? 2 : 0);
const sampler = (left, right, unit, top = 3) => {
  const hm = new Float32Array(n * n), labels = new Uint8Array(n * n);
  for (let q = 0; q < n; q++) for (let p = 2; p < n; p++) { hm[q * n + p] = top; labels[q * n + p] = 2; }
  const pts = [];
  for (let y = 0; y <= 16; y += 2) pts.push([8, y, left, right]);
  return heightSampler(hm, [0, 0], n, step, labels, side, null, stepLineIndex([{ l: 0, r: 2, pts }], 0, lineReach(step), unit));
};

test('beside the step, the line\'s height on the point\'s side', () => {
  const at = sampler(0.4, 3.3);
  // (20 cm off the line it has most of the say, the lattice the rest.)
  assert.ok(Math.abs(at(7.8, 8) - 0.4) < 0.05);
  assert.ok(Math.abs(at(8.2, 8) - 3.3) < 0.05);
  assert.ok(at(7, 8) > 0.2);
});

test('a line far off the lattice with no step of its own is another place\'s ground: the lattice stays (K Vlásence)', () => {
  // The plain ground's height on the line came from a hillside past a small terrace by the
  // street; the street beside it is at the lattice's 0 m.
  const at = sampler(3.5, 3.3);
  assert.ok(Math.abs(at(7.8, 8)) < 0.1);
  assert.ok(Math.abs(at(7.5, 8)) < 0.01);
  assert.ok(Math.abs(at(7, 8)) < 0.01);
});

test('a wall the lattice has as well keeps its line however far off (Jelení příkop)', () => {
  // The wall is 6 m by the line; the lattice, with its 3 m, has half of it. The ground
  // is what the line gives with no check (as on a map in centimetres).
  const at = sampler(0.2, 6.2), free = sampler(0.2, 6.2, 0.01);
  assert.ok(at(8.2, 8) > 5.5);
  for (const x of [7.8, 8.2, 8.5, 8.8]) assert.ok(Math.abs(at(x, 8) - free(x, 8)) < 0.01);
});

test('a step the lattice doesn\'t have is another place\'s ground: the lattice stays (Prokopova)', () => {
  // The same line over a lattice with hardly a step (30 cm).
  const at = sampler(0.2, 6.2, 0.1, 0.3);
  assert.ok(Math.abs(at(8.2, 8) - 0.3) < 0.1);
  assert.ok(Math.abs(at(9, 8) - 0.3) < 0.01);
});

test('on a map whose ground is the scan, the line has its say however far off the lattice', () => {
  // (Its lattice blurs a wall into a ramp: the line, read from the scan, is the wall.)
  const at = sampler(3.5, 3.3, 0.01);
  assert.ok(Math.abs(at(7.8, 8) - 3.5) < 0.2);
  assert.ok(at(7, 8) > 2);
});
