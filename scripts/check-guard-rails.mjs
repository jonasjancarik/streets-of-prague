#!/usr/bin/env node
// Crash barriers against the real car and fence code; no browser, GPU or map.
// node scripts/check-guard-rails.mjs
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
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true });
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const THREE = await import('three');
const { Car, loadCars } = await import('../src/car.ts');
const { fenceArrays, RAIL_H, SECTION_STRIDE, VERTS } = await import('../src/map/fences.ts');
const { fences } = await import('../src/fences.ts');
const { rng } = await import('../src/map/geo.ts');
await loadCars('data:model/gltf-binary;base64,' + readFileSync(new URL('../public/cars.glb', import.meta.url)).toString('base64'));

// A barrier along y = 0 from x = 0 to 60, and a garden fence beside it for comparison.
const buffers = fenceArrays({ fences: [{ kind: 'guard_rail', pts: [[0, 0], [60, 0]] }, { kind: 'fence', pts: [[0, 30], [60, 30]] }] });
const rows = buffers.sections.length / SECTION_STRIDE;
assert.equal(rows, 40, 'two 60 m lines in 3 m sections');
const kinds = Array.from({ length: rows }, (_, i) => buffers.sections[i * SECTION_STRIDE + 6]);
assert.deepEqual([...new Set(kinds)].sort(), [0, 2], 'a barrier is its own kind of section');
assert.equal(buffers.sections[5], RAIL_H, 'a barrier is bumper high whatever the map says');
assert.equal(buffers.rail.position.length / 3, 20 * VERTS.rail);
const mesh = (a) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a.position, 3)); return new THREE.Mesh(g); };
const sections = fences.sections('test', buffers.sections, { fence: mesh(buffers.fence), hedge: mesh(buffers.hedge), rail: mesh(buffers.rail) });
fences.add(sections);
const rails = sections.filter((s) => s.rail);
assert.equal(rails.length, 20);

// Drive a car at the barrier: `speed` m/s, `angle` radians from the barrier's line.
const run = (x, speed, angle, y0 = 3) => {
  const car = new Car('hatch', rng(1), x, y0, -angle);
  car.vx = Math.cos(angle) * speed; car.vy = -Math.sin(angle) * speed;
  let impact = 0;
  for (let i = 0; i < 240; i++) {
    car.x += car.vx / 120; car.y += car.vy / 120;
    impact = Math.max(impact, fences.collide(car));
  }
  return { car, impact };
};
const standing = () => rails.filter((s) => !s.broken).length;

// Drifting into it on a motorway (130 km/h, 10 degrees): turned back, nothing broken.
const glance = run(5, 36, 10 * Math.PI / 180);
assert.ok(glance.impact > 0, 'the car touched the barrier');
assert.ok(glance.car.y > 0 && glance.car.vy >= 0, 'a glancing car stays on its side of the barrier');
assert.equal(standing(), 20, 'a glancing hit leaves the barrier standing');

// Square into it at 40 km/h: stopped.
const slow = run(20, 11, Math.PI / 2);
assert.ok(slow.car.y > 0, 'a slow car does not get through');
assert.equal(standing(), 20);

// Square into it at 90 km/h: through, a section down, and it cost most of the speed.
const fast = run(40, 25, Math.PI / 2);
assert.ok(fast.car.y < 0, 'a fast car square on goes through');
assert.ok(standing() < 20, 'and takes a section down');
assert.ok(Math.hypot(fast.car.vx, fast.car.vy) < 15, 'losing much of its speed');

// The garden fence goes down at a crawl, as before.
const fence = run(20, 4, Math.PI / 2, 33);
assert.ok(fence.car.y < 30 && sections.some((s) => !s.rail && s.broken), 'a garden fence still gives way');

// On foot: it stops a walker, and a jump clears it.
assert.ok(fences.blocks(50, 0.05, 0.15, 0), 'a barrier stops someone walking');
assert.ok(!fences.blocks(50, 0.05, 0.15, 0.4), 'a jump clears it');
console.log('Crash barriers: sections and mesh, glancing and slow cars turned back, fast square hit goes through, fences unchanged, walkers stopped');
