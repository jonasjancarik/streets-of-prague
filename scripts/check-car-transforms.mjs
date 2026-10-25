#!/usr/bin/env node
// Browser checks of the parked cars' kept matrices (CarPool.render with a terrain
// revision, plan 032): every matrix must equal the one worked out from scratch, an
// unchanged parked four-wheeler must not sample the ground again, and anything that
// moves it, turns it, re-tracks it or changes the ground must work it out again.
//   node scripts/check-car-transforms.mjs --url http://localhost:5191/
// --baseline runs the same cases on code without the cache (or ignoring the revision)
// and only reports the counts.
import { spawnSync } from 'node:child_process';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const url = option('--url', 'http://localhost:5191/');
const baseline = process.argv.includes('--baseline');

const checks = `(async () => {
  const d = window.__drive, pool = d.carPool, world = d.world;
  const loadedModule = (path) => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === path).at(-1)?.name || path;
  const { Car } = await import(loadedModule('/src/car.ts'));
  const THREE = await import(loadedModule('/node_modules/.vite/deps/three.js'));
  const baseline = ${baseline};
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const report = [];
  const cap = pool.constructor.pageCapacity;

  // The calculation as it was before the cache, on its own Object3D.
  const o = new THREE.Object3D();
  const oracle = (c, height) => {
    if (height) {
      const fx = Math.cos(c.h), fy = Math.sin(c.h), L = c.spec.L / 2, W = c.spec.W / 2;
      const hf = height(c.x + fx * L, c.y + fy * L, c), hb = height(c.x - fx * L, c.y - fy * L, c);
      const hl = height(c.x - fy * W, c.y + fx * W, c), hr = height(c.x + fy * W, c.y - fx * W, c);
      o.position.set(c.x, (hf + hb + hl + hr) / 4, -c.y);
      o.rotation.set(Math.atan2(hl - hr, 2 * W) - c.lean, c.h, Math.atan2(hf - hb, 2 * L), 'YZX');
    } else {
      o.position.set(c.x, 0, -c.y);
      o.rotation.set(-c.lean, c.h, 0, 'YZX');
    }
    o.updateMatrix();
    return o.matrix.elements.slice();
  };
  // Where each car of a render call landed: its page and slot, as render packs them.
  const slotOf = (cars, c) => {
    const same = cars.filter(x => x.key === c.key), i = same.indexOf(c);
    return { m: pool.meshes.get(c.key)[Math.floor(i / cap)], slot: i % cap };
  };
  let worst = 0;
  const matches = (cars, height, label) => {
    for (const c of cars) {
      const { m, slot } = slotOf(cars, c);
      // The oracle samples the plain slope (no counting, no tracking side effects).
      const want = oracle(c, height && plain), got = m.instanceMatrix.array.slice(slot * 16, slot * 16 + 16);
      for (let k = 0; k < 16; k++) {
        const e = Math.abs(want[k] - got[k]);
        worst = Math.max(worst, e);
        assert(e < 1e-5 * Math.max(1, Math.abs(want[k])), label + ': matrix element ' + k + ' of ' + c.type + ' differs by ' + e);
      }
    }
  };

  // A slope with a bump, so pitch and roll aren't zero, and a counted copy of it.
  let slope = 0.07;
  const plain = (x, y) => 200 + slope * x - 0.04 * y + Math.sin(x * 0.3) * 0.2;
  let calls = 0;
  const counted = (x, y, c) => { calls++; return plain(x, y); };
  let revision = 1;
  const step = (cars, height = counted, rev = revision) => { calls = 0; pool.render(cars, height, 0, rev === 'none' ? undefined : rev); return calls; };

  const car = new Car('hatch', () => .3, 1000.5, -2000.25, 0.7, '#336699');
  const other = new Car('sedan', () => .4, 1010, -2004, 1.9, '#996633');
  const mover = new Car('hatch', () => .5, 1020, -2010, 0.1, '#669933'); mover.mode = 'traffic';
  const bike = new Car('bike', () => .5, 1030, -2010, 0.1);
  const cars = [car, other, mover, bike];

  // Priming, then unchanged frames.
  const first = step(cars);
  assert(first === 16, 'first render samples four wheels for each four-wheeled car, got ' + first);
  matches(cars, true, 'first');
  let unchanged = 0;
  for (let f = 0; f < 60; f++) { unchanged += step(cars); matches(cars, true, 'unchanged ' + f); }
  report.push('unchanged 60 frames: ' + unchanged + ' height calls (' + (unchanged / 60) + ' a frame; uncached ' + first + ')');
  if (!baseline) assert(unchanged === 60 * 8, 'only the traffic car and the bike sample the ground on unchanged frames, got ' + unchanged / 60 + ' a frame');
  else assert(unchanged === 60 * 16, 'baseline samples every car every frame');

  // Each invalidation makes the parked car sample again, once.
  const cases = [
    ['move x', () => { car.x += 1e-9; }],
    ['move y', () => { car.y -= 0.5; }],
    ['turn', () => { car.h += 0.01; }],
    ['lean', () => { car.lean = 0.02; }],
    ['lean back', () => { car.lean = 0; }],
    ['level', () => { car.level = 1; }],
    ['level back', () => { car.level = 0; }],
    ['gz', () => { car.gz = (car.gz ?? 0) + 0.25; }],
    ['hint', () => { car.hint = 'bridge'; }],
    ['grounded', () => { car.grounded = !car.grounded; }],
    ['tracked at', () => { car._tx = 1; }],
    ['street', () => { car.e = { bridge: true }; }],
    ['dimensions', () => { car.spec = { ...car.spec, L: car.spec.L + 0.1 }; }],
  ];
  const parked = [car, other];
  step(parked);
  for (const [name, change] of cases) {
    change();
    const n = step(parked);
    if (!baseline) assert(n === 4, name + ': expected one car re-sampled (4 calls), got ' + n);
    matches(parked, true, name);
    const again = step(parked);
    if (!baseline) assert(again === 0, name + ': settled again, got ' + again);
  }
  report.push('invalidation: ' + cases.length + ' changes each re-sampled the changed car only');

  // A new height function, a terrain revision, the ground itself changing with it.
  const replaced = (x, y, c) => counted(x, y, c);
  let n = step(parked, replaced);
  if (!baseline) assert(n === 8, 'replaced height function re-samples, got ' + n);
  n = step(parked, replaced);
  if (!baseline) assert(n === 0, 'settled on the replaced function, got ' + n);
  slope = 0.11; revision++;
  n = step(parked, replaced);
  if (!baseline) assert(n === 8, 'terrain revision re-samples, got ' + n);
  matches(parked, true, 'new terrain');
  // Without a revision there's nothing to keep by: the old way every frame.
  n = step(parked, counted, 'none'); n += step(parked, counted, 'none');
  assert(n === 16, 'no revision: sampled every frame, got ' + n);
  // No height at all: flat, as before.
  pool.render(parked, null, 0, revision); matches(parked, false, 'flat');
  report.push('height function, terrain revision and no revision: recomputed as required');

  // Visible order and pages change; empty groups; the car leaves and comes back.
  step(parked);
  step([other, car]); matches([other, car], true, 'reordered');
  const crowd = Array.from({ length: cap + 5 }, (_, i) => new Car('hatch', () => .2, 900 + i * 3, -1900 - i, i * .1, '#123456'));
  step([...crowd, car]); matches([...crowd, car], true, 'second page');
  n = step([car, ...crowd]); matches([car, ...crowd], true, 'first page again');
  if (!baseline) assert(n === 0, 'slot and page changes keep matrices, got ' + n);
  step([]);
  assert([...pool.meshes.values()].every(g => g.every(m => m.count === 0 && !m.visible)), 'empty frame hides every page');
  n = step([car]); matches([car], true, 're-entry');
  if (!baseline) assert(n === 0, 're-entry after leaving view keeps the matrix, got ' + n);
  report.push('order, pages, empty frame and re-entry: matrices in the right slots');

  // Paint, lamps and doors still follow the car every frame.
  const paintOf = (c) => { const { m, slot } = slotOf([c], c); const p = m.geometry.getAttribute('paint'); return [p.getX(slot), p.getY(slot), p.getZ(slot), p.getW(slot)]; };
  step([car]);
  const lampsBefore = paintOf(car)[3];
  car.broken = 3; step([car]);
  assert(paintOf(car)[3] === lampsBefore + 3, 'broken lamps shown on a kept matrix');
  car.broken = 0; car.burn?.(); step([car]);
  const burntPaint = paintOf(car);
  assert(burntPaint.every(Number.isFinite), 'burnt car painted');
  const door = new Car('sedan', () => .6, 1100, -2100, 0.3, '#aa0000');
  step([door]); door.open(0);
  for (let f = 0; f < 120; f++) { calls = 0; pool.render([door], counted, 1 / 30, revision); matches([door], true, 'door ' + f); }
  const page = pool.meshes.get(door.key)[0], doors = page.geometry.getAttribute('doors');
  door.open(0, false);
  for (let f = 0; f < 240; f++) pool.render([door], counted, 1 / 30, revision);
  assert(!door.door || [0, 1, 2, 3].every(k => Math.abs(doors.array[k]) < 1e-6), 'door shut on the page');
  report.push('lamps, burnt paint and doors still written on kept matrices');

  // The real ground: the game's height function and the tiles' revision, then a tile's
  // removal, a failed insertion and its rebuild.
  if (!baseline) {
    const ground = (x, y, who) => world.groundFor(who, x, y);
    const at = d.walker;
    const real = new Car('hatch', () => .3, at.x + 3, at.y + 3, 0.4, '#224466');
    calls = 0;
    const live = (x, y, c) => { calls++; return ground(x, y, c); };
    pool.render([real], live, 0, world.terrainRevision);
    const sampled = calls;
    calls = 0; pool.render([real], live, 0, world.terrainRevision);
    assert(sampled === 4 && calls === 0, 'real ground: sampled once, then kept (' + sampled + ', ' + calls + ')');
    // Streaming stands still meanwhile, so only these calls move the revision.
    const update = world.update;
    world.update = () => {};
    try {
    const r0 = world.terrainRevision;
    const keys = [...world.loaded.keys()];
    const far = keys.map(k => [k, world.loaded.get(k)]).sort((a, b) => Math.hypot(b[1].box[0] - at.x, b[1].box[1] - at.y) - Math.hypot(a[1].box[0] - at.x, a[1].box[1] - at.y))[0][0];
    const files = await (world.pending.get(far) ?? world.fetchTile(far));
    world.drop(far);
    assert(world.terrainRevision === r0 + 1, 'drop advances the terrain revision');
    calls = 0; pool.render([real], live, 0, world.terrainRevision);
    assert(calls === 4, 'a dropped tile re-samples kept cars');
    const onCars = world.onCars;
    world.onCars = () => { throw new Error('test: insertion fails'); };
    let failed = false;
    try { await world.make(far, files); } catch { failed = true; }
    world.onCars = onCars;
    const r1 = world.terrainRevision;
    assert(failed && !world.loaded.has(far) && r1 > r0 + 1, 'failed insertion rolls back and advances the revision (' + [failed, world.loaded.has(far), world.terrainRevision - r0] + ')');
    await world.build(far, files);
    assert(world.loaded.has(far) && world.terrainRevision > r1, 'rebuilt tile advances the revision (' + (world.terrainRevision - r0) + ')');
    } finally { world.update = update; }
    report.push('real ground: kept after priming; drop, failed insertion and rebuild each advanced the revision');
  }
  pool.render([]);
  report.push('worst matrix difference from the uncached calculation: ' + worst.toExponential(2) + (baseline ? ' (baseline)' : ''));
  return report.join('\\n');
})()`;

for (const extra of ['', '&renderer=webgl&dev']) {
  const args = ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1', '--graphics', 'high', '--time', '14:00', '--weather', 'clear', '--fresh-browser', '--loading-frames', '--extra', extra, '--eval', checks, '--stack'];
  if (!extra) args.push('--require-webgpu');
  const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
}
