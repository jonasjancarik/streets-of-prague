#!/usr/bin/env node
// Garden fences, hedges and sheds as the tile workers build them; no browser, GPU or map.
// node scripts/check-garden-plots.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}});
const { fenceArrays, SECTION_STRIDE, VERTS, HEDGE_W } = await import('../src/map/fences.ts');
const { shedArrays, shedCorners } = await import('../src/map/sheds.ts');

// A fence shows the same from both sides: two faces a section, both leaning to the sky.
const fence = fenceArrays({ fences: [{ kind: 'fence', h: 1.2, pts: [[0, 0], [6, 0]] }] }).fence;
assert.equal(fence.position.length / 3, 2 * VERTS.fence, 'two sections of twelve vertices');
const ny = (i) => fence.normal[i * 3 + 1], nz = (i) => fence.normal[i * 3 + 2];
for (let i = 0; i < 24; i++) assert.ok(ny(i) > 0, 'every fence normal points up');
assert.ok(nz(0) * nz(6) < 0, 'the two faces lean apart');

// A hedge across a slope (the ground falls 0.5 m per metre to the north) stands on the
// ground on both sides, with a level top.
const slope = (x, y) => 10 - 0.5 * y;
const hedge = fenceArrays({ fences: [{ kind: 'hedge', h: 1.5, pts: [[0, 0], [3, 0]] }] }, slope);
assert.equal(hedge.hedge.position.length / 3, VERTS.hedge);
const P = hedge.hedge.position;
let floating = 0, top = -Infinity;
for (let i = 0; i < P.length; i += 3) {
  const ground = slope(P[i], -P[i + 2]);
  top = Math.max(top, P[i + 1]);
  if (P[i + 1] < 11 && P[i + 1] > ground + 0.01) floating++; // a bottom vertex above its ground
}
assert.equal(floating, 0, 'no side of the hedge hangs over the slope');
assert.ok(Math.abs(top - 11.5) < 1e-6, 'the top is the middle line plus the height');
assert.equal(hedge.sections[4], 10, 'the section records the ground under its middle line');

// At a right-angled bend the two stretches' sides meet in one corner point on each side.
const bend = fenceArrays({ fences: [{ kind: 'hedge', h: 1.5, pts: [[0, 0], [3, 0], [3, 3]] }] }).hedge.position;
const xz = (i) => [bend[i * 3], -bend[i * 3 + 2]];
const first = Array.from({ length: VERTS.hedge }, (_, i) => xz(i)), second = Array.from({ length: VERTS.hedge }, (_, i) => xz(VERTS.hedge + i));
const has = (list, x, y) => list.some(([a, b]) => Math.hypot(a - x, b - y) < 1e-4);
const w = HEDGE_W / 2;
for (const [x, y] of [[3 + w, -w], [3 - w, w]]) {
  assert.ok(has(first, x, y) && has(second, x, y), `both stretches reach the corner ${x}, ${y}`);
}

// Sheds: one box and roof each, on the ground, and nothing for a tile without any.
assert.equal(shedArrays(undefined).position.length, 0);
const shed = [10, 20, Math.PI / 2, 3, 2, 2.2];
const corners = shedCorners(shed);
assert.deepEqual(corners.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]).sort(), [[9, 18.5], [9, 21.5], [11, 18.5], [11, 21.5]].sort());
const built = shedArrays([shed], () => 5);
assert.equal(built.position.length / 9, 14, 'four walls, two gables, two roof slopes');
assert.equal(built.color.length, built.position.length);
let lo = Infinity, hi = -Infinity;
for (let i = 1; i < built.position.length; i += 3) { lo = Math.min(lo, built.position[i]); hi = Math.max(hi, built.position[i]); }
assert.ok(lo < 5 && lo > 4.8 && hi > 7.2 && hi < 8, `a shed stands from just under the ground to its ridge (${lo} to ${hi})`);
for (let i = 0; i < built.normal.length; i += 3) assert.ok(Math.abs(Math.hypot(built.normal[i], built.normal[i + 1], built.normal[i + 2]) - 1) < 1e-5);
console.log('garden plots: fences, hedges and sheds OK');
