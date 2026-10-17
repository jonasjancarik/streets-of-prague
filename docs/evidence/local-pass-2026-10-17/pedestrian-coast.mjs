import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const r = next(url, context);
  return url.includes('/src/') ? { ...r, source: String(r.source).replaceAll('import.meta.env', '({})') } : r;
} });
globalThis.location = { search: '' };
globalThis.self = globalThis;
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
globalThis.requestAnimationFrame = cb => { cb(0); return 0; };
const base = fileURLToPath(new URL('../../../', import.meta.url));
const { Car, loadCars } = await import(base + 'src/car.ts');
await loadCars('data:model/gltf-binary;base64,' + fs.readFileSync(base + 'public/cars.glb').toString('base64'));
const { posts } = await import(base + 'src/posts.ts');
const { setupTestkit } = await import(base + 'src/testkit.ts');
const cases = [];
// A controlled renderer frame uses main.ts's exact pause guard and its 50 ms dt cap.
// It establishes scheduling sensitivity, not the unrecorded latest browser timings.
let live = null;
globalThis.requestAnimationFrame = cb => {
  if (live && !live.t.paused) live.g.simulate(0.05);
  cb(0);
  return 0;
};
for (const [name, postSpec, wall, beyond = 14] of [
  ['flat-empty', null, Infinity],
  ['lamp', { r: 0.15, tough: 5, give: 0.2 }, Infinity],
  ['tram-wire-pole', { r: 0.18, tough: 9, give: 0.5 }, Infinity],
  ['lamp-then-wall-at-35m', { r: 0.15, tough: 5, give: 0.2 }, 35],
  ['corrected-corridor-wall-at-35m', { r: 0.15, tough: 5, give: 0.2 }, 35, 30],
]) {
  const c = new Car('hatch', () => 0.5, 0, 0, 0);
  c.mode = 'player';
  const p = postSpec && { x: 18, y: 0, z: NaN, ...postSpec, down: null };
  if (p) posts.add(p);
  let steps = 0, impacts = [];
  const grid = { at: x => x >= wall ? 1 : 0, height: () => 0 };
  const g = { car: () => c, me: () => c, grid,
    carsNear: () => [], tramsNear: () => [], canvas: { addEventListener() {} },
    simulate(dt, ctl = {}) {
      const full = { move: 0, turn: 0, run: false, brake: false, jump: false, aim: null, ...ctl };
      const hit = c.update(dt, { throttle: full.move, steer: full.turn, handbrake: full.brake, cap: null }, grid);
      if (hit) impacts.push({ step: steps, speed: c.speed * 3.6, impact: hit });
      steps++;
    },
  };
  const t = setupTestkit(g, {});
  const setupClear = p ? !!t.post(80, 18, beyond) : true;
  assert.equal(setupClear, true);
  const start = { x: c.x, y: c.y, h: c.h };
  t.push(50);
  for (let i = 0; i < 30; i++) await t.wait(0.1);
  assert.equal(steps, 180);
  if (beyond === 30) {
    assert.notEqual(start.h, 0, 'corrected corridor rejects the unsafe straight direction');
    assert.equal(impacts.length, 1, 'only the intended post is hit');
    assert.equal(c.worldOutline().some(([x]) => x >= wall), false, 'chosen alternate direction remains clear of the wall');
    assert.ok(c.speed * 3.6 > 10, 'original speed assertion remains satisfied');
  }
  cases.push({ name, setupClear, beyond, start, steps, speed: c.speed * 3.6, distance: c.x, postDown: !!p?.down, impacts });
  if (p) posts.remove(p);
}
for (const holdPaused of [false, true]) {
  const c = new Car('hatch', () => 0.5, 0, 0, 0);
  c.mode = 'player';
  let steps = 0, seconds = 0;
  const g = { car: () => c, me: () => c, canvas: { addEventListener() {} }, simulate(dt) {
    c.update(dt, { throttle: 0, steer: 0, handbrake: false }, { at: () => 0, height: () => 0 });
    steps++; seconds += dt;
  } };
  const t = setupTestkit(g, {});
  t.paused = holdPaused;
  live = { t, g };
  t.push(50);
  for (let i = 0; i < 30; i++) await t.wait(0.1);
  live = null;
  cases.push({ name: 'controlled-live-frame-' + (holdPaused ? 'paused' : 'unpaused'), steps, seconds, speed: c.speed * 3.6, distance: c.x });
}
console.log(JSON.stringify(cases, null, 2));
