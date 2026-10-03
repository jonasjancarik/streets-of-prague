#!/usr/bin/env node
// Node's TS loader runs the actual service; only Vite's environment macro is replaced.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, next) {
  const r = next(url, context);
  return url.includes('/src/') ? { ...r, source: String(r.source).replaceAll('import.meta.env', '({})') } : r;
} });
globalThis.location = { search: '' };
const { Ambulances } = await import('../src/ambulance.ts');
const { Car, TYPES } = await import('../src/car.ts');
const { Anim } = await import('../src/figures.ts');
const THREE = await import('three');
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/ambulance-parked-row.json', import.meta.url)));
const kit = { clips: Object.fromEntries(['idle', 'walk', 'jog', 'run', 'fall', 'getup'].map(name => [name, { duration: 1, loop: true }])) };
function fixture(obstacles = captured.obstacles, wall = () => false) {
  const patient = { ...captured.patient };
  const makeCar = c => {
    assert.equal(c.L, TYPES[c.type].L, 'captured car length');
    assert.equal(c.W, TYPES[c.type].W, 'captured car width');
    const car = Object.assign(Object.create(Car.prototype), c, { spec: TYPES[c.type], vx: 0, vy: 0, damage: 0 });
    car.r = c.W / 2 + 0.02;
    const n = Math.max(3, Math.ceil((c.L - 2 * car.r) / (2 * car.r)) + 1), end = c.L / 2 - car.r;
    car.offsets = Array.from({ length: n }, (_, i) => -end + 2 * end * i / (n - 1));
    return car;
  };
  const cars = obstacles.map(makeCar);
  const car = makeCar({ ...captured.rig, type: 'ambulance', ...TYPES.ambulance });
  car.update = () => {}; // parked during treatment; walking, animation and treatment are real
  const grid = { at: wall };
  let revived = 0, taken = 0;
  const a = new Ambulances({ scene: new THREE.Scene(), kit, grid, rng: () => 0.5,
    police: { traffic: {} }, height: () => 0, edgesNear: () => [], offscreen: () => false, viewRadius: () => 100,
    bodyAt: (x, y, r, skip) => [...cars, car].some(c => c !== skip && c.circles().some(([cx, cy]) => Math.hypot(cx - x, cy - y) < c.r + r)),
    people: () => [patient], revive: p => { p.hurt = undefined; p.state = 'walk'; revived++; },
    take: () => { taken++; } });
  const rig = { car, patient, phase: 'work', t: 0, wrecked: false, crew: false, goal: patient, mark: car,
    path: null, s: 0, replan: 3, stuck: 0, reverse: 0, treated: 0, done: 0, load: 0, carried: false };
  a.rigs.push(rig);
  a.crew = captured.crew.map(m => ({ ...m, spot: { ...m.spot }, rig, fig: { mesh: new THREE.Group() }, anim: new Anim(kit), down: 0, back: false }));
  // Same stationary-car capsule push as main.ts, after Ambulances.update.
  const step = (seconds) => {
    for (let i = 0; i < seconds * 60; i++) {
      a.update(1 / 60, patient);
      for (const m of a.crew) for (const c of [...cars, car]) {
        const fx = Math.cos(c.h), fy = Math.sin(c.h), end = c.spec.L / 2 - c.r, min = c.r + 0.3;
        const along = Math.max(-end, Math.min(end, (m.x - c.x) * fx + (m.y - c.y) * fy));
        const cx = c.x + fx * along, cy = c.y + fy * along, d = Math.hypot(m.x - cx, m.y - cy);
        if (d >= min) continue;
        const nx = d > 1e-6 ? (m.x - cx) / d : -fy, ny = d > 1e-6 ? (m.y - cy) / d : fx;
        if (!grid.at(cx + nx * min, cy + ny * min)) { m.x = cx + nx * min; m.y = cy + ny * min; }
      }
    }
  };
  return { a, rig, patient, cars, step, results: () => ({ revived, taken }) };
}
const row = fixture();
row.step(90);
assert.equal(row.results().revived, 1, `parked row stalled: treated ${row.rig.treated}, crew ${JSON.stringify(row.a.crew.map(m => [m.x, m.y]))}`);
assert.equal(row.rig.phase, 'leave', 'crew returned and ambulance left');
console.log('Captured parked-car row: treatment and return passed');

assert.ok(row.rig.done < 20, 'crew returned without the 20-second dismissal fallback');
const clear = fixture([]);
let routes = 0;
const clearRoute = clear.a.footRoute.bind(clear.a);
clear.a.footRoute = (...args) => { routes++; return clearRoute(...args); };
clear.step(30);
assert.equal(clear.results().revived, 1);
assert.equal(routes, 0, 'clear approach keeps ordinary steering');
const grave = fixture();
grave.patient.grave = true;
let maxLoad = 0;
for (let i = 0; i < 90; i++) { grave.step(1); maxLoad = Math.max(maxLoad, grave.rig.load); }
assert.equal(grave.results().taken, 1, 'stretcher reached the ambulance');
assert.ok(maxLoad < 50, 'stretcher returned without the loading timeout');
assert.equal(grave.rig.phase, 'leave');
const wall = fixture([], (x, y) => y > -102.8 && y < -102.2);
wall.step(30);
assert.equal(wall.results().revived, 0, 'unreachable patient remains untreated');
assert.equal(wall.rig.treated, 0);
// A newly parked car must invalidate the next segment instead of being walked through.
const changed = fixture([]), medic = changed.a.crew[0];
medic.footGoal = { ...medic.spot };
medic.footPath = [{ x: medic.x, y: medic.y + 1 }];
changed.a.o.bodyAt = (x, y) => y > medic.y + 0.2 && y < medic.y + 1.2;
changed.a.walkTo(medic, medic.spot, 3, 1 / 60);
assert.equal(medic.footPath, undefined);
console.log(JSON.stringify({ clearApproach: 'pass', distantWall: 'pass', changedObstacle: 'pass', stretcher: 'pass', rowReturnSeconds: row.rig.done, maxLoadSeconds: maxLoad }));

const knocked = fixture(), knockedMedic = knocked.a.crew[0];
knockedMedic.footPath = [{ x: knockedMedic.x + 1, y: knockedMedic.y }];
knocked.a.knock(knockedMedic, 2, 0);
assert.equal(knockedMedic.footPath, undefined, 'knock invalidates the old route');
// Unreachable local search has a fixed queue budget; it does not scan the town.
const trapped = fixture([], (x, y) => y > -102 && y < -101);
let segments = 0;
const footClear = trapped.a.footClear.bind(trapped.a);
trapped.a.footClear = (...args) => { segments++; return footClear(...args); };
assert.equal(trapped.a.footRoute(trapped.a.crew[0], trapped.a.crew[0].spot), undefined);
assert.ok(segments <= 1600 * 9, 'local search respects its queue budget');
console.log('Knock invalidation and capped unreachable search passed (' + segments + ' segment checks)');

const end = fixture([]);
end.patient.hurt = undefined;
for (const m of end.a.crew) {
  m.x = end.rig.car.x + Math.cos(end.rig.car.h) * 5;
  m.y = end.rig.car.y + Math.sin(end.rig.car.h) * 5;
}
end.step(20);
assert.equal(end.rig.phase, 'leave', 'crew approaching the vehicle end found a boarding point');
assert.ok(end.rig.done < 20, 'vehicle-end return did not use the dismissal timeout');
console.log('Vehicle-end boarding passed (' + end.rig.done + ' seconds)');
