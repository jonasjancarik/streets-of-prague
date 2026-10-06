#!/usr/bin/env node
// Parked cars against the traffic for a whole built map, without a browser: every tile's
// cars are placed as the game places them (scripts/offline-city.mjs), then a pickup and a
// bus are swept along every lane and round every junction curve the way Route and
// Traffic.update pose them, and a fire engine down the middle of every street (the way
// police.route sends emergency vehicles). A parked car any of them would touch is a bay
// that parkingClearance should have refused.
// node scripts/check-parking-city.mjs [area] [--list n] [--tiles i0,j0,i1,j1]
import assert from 'node:assert/strict';
import { City, loadModels, network, carModule, geo } from './offline-city.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const area = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'centrum';
const list = Number(flag('--list') ?? 12), crop = flag('--tiles')?.split(',').map(Number);
await loadModels();
const city = new City(area);
const { Route, SpatialHash } = network, { Car } = carModule;
const started = Date.now();
let keys = city.keys();
if (crop) keys = keys.filter((k) => { const [i, j] = k.split('_').map(Number); return i >= crop[0] && j >= crop[1] && i <= crop[2] && j <= crop[3]; });

// The parked cars, each circle in a hash.
const hash = new SpatialHash(10), parked = [];
for (const k of keys) {
  const p = city.park(k);
  if (!p) continue;
  for (const c of p.cars) {
    parked.push(c);
    for (const [x, y] of c.circles()) hash.add({ x, y, r: c.r, car: c });
  }
}
const g = city.graph(crop ? keys : undefined);
const worst = new Map(); // parked car → { over, by, where }
const found = [];
function touch(x, y, r, by, where) {
  found.length = 0;
  for (const o of hash.near(x, y, r + 1.2, found)) {
    const over = o.r + r - Math.hypot(o.x - x, o.y - y);
    if (over > 0 && over > (worst.get(o.car)?.over ?? 0)) worst.set(o.car, { over, by, where });
  }
}

// Lane following, as Traffic.update poses a car: on the lane, facing along it; a bus
// with its back axle on the lane and its front one a wheelbase further on.
const probes = ['pickup', 'bus'].map((type) => new Car(type, geo.rng(1), 0, 0, 0));
let turns = 0;
for (const e of g.edges) {
  if (e.bridge || e.tunnel) continue;
  const all = g.out.get(e.v) || [], forward = all.filter((f) => f !== e.twin);
  for (const f of forward.length ? forward : all) {
    if (f.bridge || f.tunnel) continue;
    turns++;
    for (const car of probes) {
      const heavy = !!car.spec.heavy, wb = car.spec.wheelbase ?? 6;
      const route = new Route(g, e, 0, () => 0, heavy, (from) => (from === e ? f : null));
      let h = null;
      for (let guard = 0; guard < 4000; guard++) {
        const p = route.leg.path.at(route.s);
        let ang = p.ang, x = p.x, y = p.y;
        if (heavy) {
          const q = route.lookahead(wb).p;
          if (Math.hypot(q.x - p.x, q.y - p.y) > wb / 2) ang = Math.atan2(q.y - p.y, q.x - p.x);
          x += Math.cos(ang) * wb * 0.42;
          y += Math.sin(ang) * wb * 0.42;
        }
        // (The body turns to its new heading over a metre or so, as in the game at town speeds.)
        h = h === null ? ang : h + Math.atan2(Math.sin(ang - h), Math.cos(ang - h)) * 0.6;
        Object.assign(car, { x, y, h });
        for (const [cx, cy] of car.circles()) touch(cx, cy, car.r, car.type, e.name || e.id);
        if (route.leg.edge === f && route.s > Math.min(f.path.length - 0.5, route.leg.s0 + 14)) break;
        route.advance(0.5);
        if (route.ended) break;
      }
    }
  }
}
const lanes = new Map(worst);

// Emergency vehicles go down the middle of the street, either way.
worst.clear();
const engine = new Car('fire', geo.rng(1), 0, 0, 0), seen = new Set();
for (const e of g.edges) {
  if (e.bridge || e.tunnel || seen.has(e.twin)) continue;
  seen.add(e);
  const mid = new network.Polyline(e.pts);
  for (let s = 0; s <= mid.length; s += 0.75) {
    const p = mid.at(s);
    touch(p.x, p.y, engine.spec.W / 2, 'fire', e.name || e.id);
  }
}
const middle = new Map(worst);

const report = (title, map) => {
  const by = {};
  for (const { by: type } of map.values()) by[type] = (by[type] || 0) + 1;
  console.log(`${title}: ${map.size} of ${parked.length} parked cars (${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'})`);
  for (const [c, w] of [...map].sort((a, b) => b[1].over - a[1].over).slice(0, list)) {
    console.log(`  ${w.over.toFixed(2)} m into a ${w.by}'s way on ${w.where}: ${c.type} at ${c.x.toFixed(1)}, ${c.y.toFixed(1)} (tile ${city.keyAt(c.x, c.y)})`);
  }
};
console.log(`${area}: ${keys.length} tiles, ${g.edges.length} lanes, ${turns} turns, ${parked.length} parked cars, ${((Date.now() - started) / 1000).toFixed(0)} s`);
report('In a lane or a turning curve', lanes);
report('In the middle of a street (emergency vehicles)', middle);
if (!args.includes('--report')) {
  assert.equal(lanes.size, 0, 'parked cars stand clear of every lane and turning curve');
  assert.equal(middle.size, 0, 'parked cars leave the middle of every street to emergency vehicles');
  console.log('Citywide parking clearance passed');
}
