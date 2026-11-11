#!/usr/bin/env node
// Compare the incremental index with a fresh full rebuild after each transition.
import { createRequire } from 'node:module';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1]]);
  return a;
}, []));
const base = args.url || 'http://localhost:5191/';
const which = args.case || 'all';
if (!['index', 'simulation', 'all'].includes(which)) throw new Error(`Unknown case: ${which}`);
const require = createRequire(import.meta.url);
const pw = (() => {
  for (const path of [process.env.PLAYWRIGHT_PATH || 'playwright', `${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`]) {
    try { return require(path); } catch {}
  }
  throw new Error('Playwright not found; set PLAYWRIGHT_PATH');
})();
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL('src/restingCars.ts', base).href);
  const result = await page.evaluate(async (which) => {
    const { RestingCars } = await import('/src/restingCars.ts');
    const assert = (okay, message) => { if (!okay) throw new Error(message); };
    let next = 0;
    class Car {
      constructor(x, y, offsets = [0, 2]) {
        Object.assign(this, { id: ++next, x, y, h: 0, gz: 0, r: 1, vx: 0, vy: 0, w: 0, mode: 'loose', offsets, resting: false });
      }
      circles() {
        const c = Math.cos(this.h), s = Math.sin(this.h);
        return this.offsets.map((o) => [this.x + c * o, this.y + s * o]);
      }
    }
    const moving = (c) => c.mode === 'player' || c.vx * c.vx + c.vy * c.vy > 0.0025 || Math.abs(c.w) > 0.01;
    const index = new RestingCars(10), loose = [];
    const lookup = (x, y, r) => {
      const actual = index.near(x, y, r).map((o) => `${o.car.id}:${index.entries.get(o.car).shapes.indexOf(o)}:${o.x}:${o.y}:${o.z}:${o.r}:${o.vx}:${o.vy}:${o.kind}`);
      const buckets = new Map();
      for (const c of loose) if (!moving(c)) for (const [circle, [cx, cy]] of c.circles().entries()) {
        const key = Math.floor(cx / 10) * 131072 + Math.floor(cy / 10);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(`${c.id}:${circle}:${cx}:${cy}:${c.gz}:${c.r}:${c.vx}:${c.vy}:car`);
      }
      const expected = [];
      for (let i = Math.floor((x - r) / 10); i <= Math.floor((x + r) / 10); i++)
        for (let j = Math.floor((y - r) / 10); j <= Math.floor((y + r) / 10); j++) expected.push(...(buckets.get(i * 131072 + j) || []));
      assert(actual.join('|') === expected.join('|'), `ordered candidates differ at ${x},${y}: ${actual.join('|')} vs ${expected.join('|')}`);
    };
    const verify = (label) => {
      index.sync(loose, moving);
      for (const [x, y, r] of [[0, 0, 40], [-15, -15, 20], [35, 15, 25], [0, 0, 2], [100, 100, 5]]) lookup(x, y, r);
      assert([...index.entries.keys()].every((c) => c.resting), `${label}: retained resting flags`);
      assert(loose.filter(moving).every((c) => !c.resting), `${label}: moving flags`);
    };
    if (which === 'index' || which === 'all') {
      const a = new Car(-0.5, -10.5), b = new Car(3, 0), bus = new Car(5, 12, [-6,-4,-2,0,2,4,6]);
      loose.push(a, b, bus); verify('arrival');
      const aShapes = index.entries.get(a).shapes, bShapes = index.entries.get(b).shapes;
      const allocated = index.stats.allocatedCircles;
      verify('no-op');
      assert(index.entries.get(a).shapes === aShapes && index.stats.allocatedCircles === allocated, 'no-op reused all circles');
      a.x = 10.5; a.y = -0.1; verify('cross negative cell');
      assert(index.entries.get(b).shapes === bShapes && index.stats.allocatedCircles === allocated + a.offsets.length, 'one-car change did not allocate other circles');
      a.h = Math.PI / 2; a.gz = 5; a.r = 1.5; verify('heading height radius');
      bus.offsets = bus.offsets.map((o, i) => i === 3 ? 0.5 : o); verify('bus circle offset replacement');
      b.vx = 2; verify('rest to move'); assert(!index.entries.has(b), 'moving car removed');
      b.vx = 0; verify('move to rest'); assert(index.entries.has(b), 'car reinserted at original loose position');
      loose.splice(loose.indexOf(a), 1); verify('absent from loose'); assert(!index.entries.has(a), 'absent car swept');
      loose.push(new Car(-8, -8)); verify('tile arrival');
      loose.splice(2); verify('tile drop');
    }
    if (which === 'simulation' || which === 'all') {
      loose.length = 0;
      const parked = [new Car(0, 0), new Car(1, 0), new Car(0, 1)], approach = new Car(-15, 0);
      loose.push(...parked, approach); verify('parked pile-up');
      // A car approaching and then pushing another changes both entries; candidates
      // are compared in their collision traversal order after each substep.
      for (const x of [-9, -4, -1, 1]) { approach.x = x; verify('approach'); }
      parked[1].x += 3; parked[1].vx = 0.2; verify('knocked into motion');
      parked[1].vx = 0; verify('settled after push');
      const tramPushed = new Car(3, 2); loose.push(tramPushed); verify('tram approaches');
      tramPushed.x += 4; tramPushed.vx = 1; verify('tram pushes car');
      tramPushed.vx = 0; verify('tram pushed car settles');
      parked[2].y += 8; verify('adopted onto pavement');
      approach.mode = 'player'; verify('player enters');
      approach.mode = 'loose'; verify('player exits');
      const above = new Car(0, 0); above.gz = 10; loose.push(above); verify('bridge above street');
      const candidates = index.near(0, 0, 4);
      assert(candidates.some((o) => o.z === 0) && candidates.some((o) => o.z === 10), 'both height layers still indexed');
      loose.splice(0, 3); verify('tile removed');
      assert(!index.near(0, 0, 20).some((o) => parked.includes(o.car)), 'dropped tile has no ghosts');
    }
    return `${which} checks passed; ${index.stats.changedCars} changed, ${index.stats.allocatedCircles} circles allocated`;
  }, which);
  console.log(result);
  if (which === 'simulation' || which === 'all') {
    await page.goto(new URL('?go&time=14:00&weather=clear&renderer=webgl&resting=incremental', base).href);
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__drive, null, { timeout: 120000 });
    const live = await page.evaluate(async () => {
      const d = window.__drive, t = window.__test;
      await t.go('staromak');
      const moving = (c) => c.mode === 'player' || c.vx * c.vx + c.vy * c.vy > 0.0025 || Math.abs(c.w) > 0.01;
      const check = (label) => {
        d.resting.sync(d.loose, moving);
        const ids = new Map(d.loose.map((c, i) => [c, i]));
        const cells = new Map();
        for (const c of d.loose) if (!moving(c)) for (const [ci, [x, y]] of c.circles().entries()) {
          const key = Math.floor(x / 10) * 131072 + Math.floor(y / 10);
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(`${ids.get(c)}:${ci}:${x}:${y}:${c.gz}:${c.r}:${c.vx}:${c.vy}`);
        }
        for (const [x, y, r] of [[d.walker.x, d.walker.y, 40], [d.walker.x + 50, d.walker.y - 50, 25]]) {
          const actual = d.resting.near(x, y, r).map((o) => `${ids.get(o.car)}:${d.resting.entries.get(o.car).shapes.indexOf(o)}:${o.x}:${o.y}:${o.z}:${o.r}:${o.vx}:${o.vy}`);
          const expected = [];
          for (let i = Math.floor((x-r)/10); i <= Math.floor((x+r)/10); i++) for (let j = Math.floor((y-r)/10); j <= Math.floor((y+r)/10); j++) expected.push(...(cells.get(i*131072+j) || []));
          if (actual.join('|') !== expected.join('|')) throw new Error(`${label}: live collision candidates differ`);
        }
      };
      check('teleport');
      const parked = t.car('sedan'), bus = t.car('bus', { ahead: 15 });
      d.simulate(1/60); check('spawned car and bus');
      parked.x += 10; parked.h += .2; parked.gz = 8; d.simulate(1/60); check('moved and raised');
      parked.vx = 1; d.simulate(1/60); check('knocked into motion');
      parked.vx = 0; d.simulate(1/60); check('rested again');
      bus.mode = 'player'; d.simulate(1/60); check('player entry');
      bus.mode = 'loose'; d.simulate(1/60); check('player exit');
      d.loose.splice(d.loose.indexOf(parked), 1); d.simulate(1/60); check('removed without tile callback');
      const tile = d.world.tileAt(bus.x, bus.y);
      if (tile && d.world.loaded.has(tile.k)) { d.world.drop(tile.k); d.simulate(1/60); check('tile drop'); }
      return `live game oracle passed; ${d.resting.entries.size} resting cars remain`;
    });
    console.log(live);
  }
} finally { await browser.close(); }
