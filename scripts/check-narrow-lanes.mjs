#!/usr/bin/env node
// CPU regression for plan 031: two cars meeting head-on on a street under SINGLE_LANE
// wide pass each other slowly inside the street, through the real Traffic.update.
// node scripts/check-narrow-lanes.mjs
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
const { DriveGraph, Route, SINGLE_LANE } = await import('../src/network.ts');
const { Traffic } = await import('../src/traffic.ts');
const { Car, loadCars, useKit } = await import('../src/car.ts');
const { loadKit } = await import('../src/figures.ts');
const { rng } = await import('../src/map/geo.ts');
const { Scene } = await import('three');
const model = (file) => 'data:model/gltf-binary;base64,' + readFileSync(new URL('../public/' + file, import.meta.url)).toString('base64');
await loadCars(model('cars.glb'));
useKit(await loadKit(model('figures.glb')));

const LENGTH = 120;
function meet(width, type) {
  const g = new DriveGraph();
  const pts = [[0, 0], [LENGTH, 0]];
  const [fwd, back] = g.add([
    { id: 'f', u: 'a', v: 'b', pts, hw: 'residential', width, oneway: false, lanes: null },
    { id: 'b', u: 'b', v: 'a', pts: [...pts].reverse(), hw: 'residential', width, oneway: false, lanes: null },
  ]);
  const traffic = new Traffic(g, new Scene(), rng(4), 0);
  const cars = [fwd, back].map((edge) => {
    const route = new Route(g, edge, 4, () => 0, false);
    const p = route.leg.path.at(route.s), car = new Car(type, rng(4), p.x, p.y, p.ang);
    car.mode = 'traffic';
    traffic.agents.push({ car, route, speed: edge.speed * 0.6, stuck: 0, jam: 0, ignore: 0, cruise: 0.9, off: 0 });
    return car;
  });
  const obstacles = () => cars.flatMap((c) => c.circles().map(([x, y]) => ({ x, y, z: c.gz, r: c.r, vx: c.vx, vy: c.vy, kind: 'car', car: c })));
  let worstOut = -Infinity, closest = Infinity, frames = 0, crossed = false;
  while (frames++ < 60 * 60 && !crossed) {
    traffic.update(1 / 60, (x, y, r) => obstacles().filter((o) => Math.hypot(o.x - x, o.y - y) < r + o.r));
    for (const c of cars) for (const [, y] of c.circles()) worstOut = Math.max(worstOut, Math.abs(y) + c.r - width / 2);
    for (const [x1, y1] of cars[0].circles()) for (const [x2, y2] of cars[1].circles()) closest = Math.min(closest, Math.hypot(x1 - x2, y1 - y2) - cars[0].r - cars[1].r);
    crossed = cars[0].x > cars[1].x + 6;
  }
  return { crossed, frames, worstOut, closest, offset: fwd.laneOffset, speed: fwd.speed };
}

const reports = [];
assert.equal(SINGLE_LANE, 4.6);
for (const width of [3.75, 4.0, 4.5]) {
  const r = meet(width, 'hatch');
  assert.ok(r.crossed, `two hatchbacks pass on a ${width} m street (${r.frames} frames)`);
  assert.ok(r.worstOut <= 0.05, `a car stays inside a ${width} m street: ${r.worstOut.toFixed(2)} m past its edge`);
  assert.ok(r.closest >= -0.01, `cars do not touch on a ${width} m street: ${r.closest.toFixed(2)} m`);
  assert.ok(r.speed <= 5, 'single-lane streets are slow');
  reports.push(`${width} m: lane offset ${r.offset.toFixed(2)}, passed in ${(r.frames / 60).toFixed(1)} s, ${r.worstOut.toFixed(2)} m past the edge, ${r.closest.toFixed(2)} m between bodies`);
}
const wide = meet(8, 'hatch');
assert.ok(wide.crossed && wide.offset >= 1.6, 'ordinary two-lane streets keep their lane offset');
console.log(`Narrow lane checks passed:\n  ${reports.join('\n  ')}\n  8 m: lane offset ${wide.offset.toFixed(2)}, passed in ${(wide.frames / 60).toFixed(1)} s`);
