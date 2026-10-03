// CPU checks of the real scenario runner and normal-action preparation contract.
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
globalThis.location = { search: '?go' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
globalThis.requestAnimationFrame = done => { queueMicrotask(() => done(performance.now())); return 0; };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { setupTestkit } = await import('../src/testkit.ts');
const { loadCars } = await import('../src/car.ts');
await loadCars('data:model/gltf-binary;base64,' + readFileSync(new URL('../public/cars.glb', import.meta.url)).toString('base64'));

function fixture({ clear = true, lands = true } = {}) {
  let mode = 'foot', car = null, heli = null, air = 0, descents = 0, exits = 0, teleports = 0, zoom = .5;
  const walker = { x: 0, y: 0, h: 0, vx: 0, vy: 0 }, loose = [];
  const me = () => car || heli || walker;
  const g = {
    me, car: () => car, heli: () => heli, mode: () => mode, street: () => 'fixture',
    toLocal: (lon, lat) => [(lon - 14) * 10000, (lat - 50) * 10000],
    toLonLat: (x, y) => [x / 10000 + 14, y / 10000 + 50],
    async teleport(x, y) { teleports++; Object.assign(me(), { x, y }); if (heli) air = Math.max(air, 60); },
    async loaded() {}, grid: { at: () => clear ? 0 : 255 },
    loose, addCar: c => loose.push(c), carsNear: () => loose, tramsNear: () => [], rng: () => .5,
    enterOrExit() {
      if (heli) {
        if (!heli.landed) return; // The production exit restriction is preserved.
        Object.assign(walker, { x: heli.x + 3, y: heli.y, h: heli.h });
        heli = null; mode = 'foot'; exits++; return;
      }
      if (car) { Object.assign(walker, { x: car.x, y: car.y + 3 }); car.mode = 'loose'; loose.push(car); car = null; mode = 'foot'; exits++; return; }
      car = loose.filter(c => c.gap(walker.x, walker.y) < 1.8).sort((a, b) => a.gap(walker.x, walker.y) - b.gap(walker.x, walker.y))[0] || null;
      if (car) { loose.splice(loose.indexOf(car), 1); car.mode = 'player'; mode = 'car'; }
    },
    simulate(dt, controls) { if (heli && controls.run) { descents++; if (lands) air = Math.max(0, air - 7.2 * dt); } },
    view: value => { zoom = value; }, view0: () => ({ x: me().x, y: me().y, height: 100 }),
    canvas: { addEventListener() {} }, fov: 38,
  };
  const loaders = {
    '../scenarios/fixture-flight.ts': async () => ({ default: {
      title: 'A fixture ends in flight', async run(t) {
        await t.go('karlak'); mode = 'helicopter'; air = 20;
        heli = { ...walker, get landed() { return air < .5; } };
        t.check('fixture remains airborne', !heli.landed);
      },
    } }),
    '../scenarios/fixture-drive.ts': async () => ({ default: {
      title: 'A fixture takes a car', async run(t) {
        t.check('starts on foot', t.where().mode === 'foot');
        await t.go('vodickova'); await t.drive('hatch');
        t.check('ordinary entry succeeds', t.where().mode === 'car');
      },
    } }),
  };
  const t = setupTestkit(g, loaders);
  return { t, stats: () => ({ mode, descents, exits, teleports, zoom }) };
}

const ordered = fixture();
assert.equal((await ordered.t.run('fixture-flight')).pass, true);
ordered.t.exit(); assert.equal(ordered.stats().mode, 'helicopter', 'exit alone must not bypass airborne restrictions');
ordered.t.cam = { x: 1, y: 2, height: 500, tilt: 70, heading: 0 };
const following = await ordered.t.run('fixture-drive');
assert.equal(following.pass, true, JSON.stringify(following));
assert.ok(ordered.stats().descents > 0, 'reset uses simulated descent controls');
assert.equal(ordered.stats().exits, 1, 'normal helicopter exit follows landing');
assert.equal(ordered.stats().zoom, 1); assert.equal(ordered.t.cam, null);
const standalone = fixture();
assert.equal((await standalone.t.run('fixture-drive')).pass, true);
assert.equal(standalone.stats().descents, 0, 'standalone foot start needs no flight steps');
for (const options of [{ clear: false }, { lands: false }]) {
  const f = fixture(options); await f.t.run('fixture-flight');
  const before = f.stats().teleports, result = await f.t.run('fixture-drive');
  assert.equal(result.pass, false); assert.equal(f.stats().mode, 'helicopter');
  assert.equal(f.stats().exits, 0, 'failed preparation must not force an exit');
  if (!options.clear && options.clear !== undefined) assert.equal(f.stats().teleports, before, 'no landing site means no placement');
}
console.log('Scenario starts: ordered airborne-to-car entry, standalone entry, camera reset and failed preparation checks passed.');
