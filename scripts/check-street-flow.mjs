#!/usr/bin/env node
// A car alone on a street lined with parked cars gets down it without stopping for
// them, through the real Traffic.update. First a fixture (a narrow one-way street that
// bends, cars at the kerb on both sides: the taxis that used to stall there), then,
// with an area's name, every street of that built map with its real parked cars.
// node scripts/check-street-flow.mjs [area] [--type taxi] [--list n]
import assert from 'node:assert/strict';
import { City, loadModels, network, trafficModule, carModule, geo, three, obstacleIndex } from './offline-city.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const area = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
await loadModels();
const { Traffic } = trafficModule, { Route, DriveGraph } = network, { Car } = carModule;
const scene = new three.Scene();

// Drives `type` from the start of `e` to its end among `obs`. How long it took against
// an empty street, how long it stood, and whether it touched anything.
function drive(g, e, type, obs) {
  const traffic = new Traffic(g, scene, geo.rng(1), 0);
  const route = new Route(g, e, 2, geo.rng(2));
  route.follow([]);
  const p = route.leg.path.at(route.s), car = new Car(type, geo.rng(3), p.x, p.y, p.ang);
  car.mode = 'traffic';
  const a = { car, route, speed: 0, stuck: 0, jam: 0, ignore: 0, cruise: 1, off: 0, hired: true, stop: { edge: e, s: e.path.length - 2 } };
  traffic.agents.push(a);
  const free = (e.path.length - 4) / Math.min(e.speed, car.spec.vmax * 0.75) + 4;
  let t = 0, stood = 0, over = 0;
  while (t < Math.max(60, free * 4) && route.s < e.path.length - 3 && traffic.agents.length) {
    traffic.update(1 / 30, obs.near);
    t += 1 / 30;
    if (a.speed < 0.3) stood += 1 / 30;
    for (const [x, y] of car.circles()) for (const o of obs.near(x, y, 3)) over = Math.max(over, o.r + car.r - Math.hypot(o.x - x, o.y - y));
  }
  return { done: route.s >= e.path.length - 3, t, free, stood, over, x: car.x, y: car.y };
}

// The fixture: 60 m, a bend of 40° to the left, 50 m more; 3.75 m wide, one way, cars
// parked along both kerbs 2.35 m from the lane (2.85 m outside the bend), the first of them right after the bend.
{
  const bend = 0.7, c = Math.cos(bend), s = Math.sin(bend);
  const g = new DriveGraph();
  const [e] = g.add([{ id: 'bent', u: 'a', v: 'b', hw: 'residential', width: 3.75, oneway: true, lanes: 1, pts: [[0, 0], [60, 0], [60 + 50 * c, 50 * s]] }]);
  const parked = [];
  // (Outside the bend a little further off: a car's nose swings out there as it turns.)
  for (const side of [1, -1]) {
    const out = side > 0 ? 2.85 : 2.35;
    for (let x = 6; x < 56; x += 6) parked.push(new Car('sedan', geo.rng(x), x, -side * 2.35, 0));
    for (let d = 4; d < 48; d += 6) parked.push(new Car('sedan', geo.rng(d), 60 + d * c + side * out * s, d * s - side * out * c, bend));
  }
  // (As parkingClearance would have it: none nearer the lane than that, also across the bend.)
  const fromLane = (car) => Math.min(...car.circles().map(([x, y]) => Math.min(network.segDist(x, y, e.pts[0], e.pts[1]), network.segDist(x, y, e.pts[1], e.pts[2]))));
  for (let i = parked.length - 1; i >= 0; i--) if (fromLane(parked[i]) < 2.3) parked.splice(i, 1);
  assert.ok(parked.length > 20 && parked.some((car) => car.x > 60 && car.x < 72 && car.y < 6), 'the fixture keeps the car outside the bend');
  for (const car of parked) car.mode = 'loose';
  const obs = obstacleIndex(parked);
  obs.rebuild();
  for (const type of ['taxi', 'pickup']) {
    const r = drive(g, e, type, obs);
    assert.ok(r.done, `a ${type} gets round a bend between parked cars (stood ${r.stood.toFixed(0)} s at ${r.x.toFixed(0)}, ${r.y.toFixed(0)})`);
    assert.ok(r.stood < 2 && r.t < r.free * 1.6, `without stopping for them: ${r.t.toFixed(0)} s against ${r.free.toFixed(0)} s, stood ${r.stood.toFixed(1)} s`);
    assert.ok(r.over <= 0.02, `and without touching one (${r.over.toFixed(2)} m)`);
  }
  // A car left across the lane is still stopped for, or gone round where there's room.
  const across = new Car('sedan', geo.rng(5), 30, 0.2, Math.PI / 2);
  across.mode = 'loose';
  const blocked = obstacleIndex([...parked, across]);
  blocked.rebuild();
  const r = drive(g, e, 'taxi', blocked);
  assert.ok(!r.done && r.x < 30 && r.over <= 0.02, `a car across the lane still stops the taxi (at ${r.x.toFixed(1)}, ${r.over.toFixed(2)} m into it)`);
  console.log('Street flow fixture passed: taxi and pickup round a bend between parked cars; a car across the lane still stops them');
}

if (area) {
  const type = flag('--type') || 'taxi', list = Number(flag('--list') ?? 15);
  const city = new City(area), g = city.graph(), parked = [];
  for (const k of city.keys()) parked.push(...(city.park(k)?.cars ?? []));
  const obs = obstacleIndex(parked);
  obs.rebuild();
  const rows = [];
  for (const e of g.edges) {
    if (e.bridge || e.tunnel || e.path.length < 25) continue;
    rows.push({ e, ...drive(g, e, type, obs) });
  }
  const bad = rows.filter((r) => !r.done || r.stood > 3 || r.t > r.free * 2.5 + 3);
  const ratio = rows.filter((r) => r.done).map((r) => r.t / r.free).sort((a, b) => a - b);
  console.log(`${area}: a ${type} down each of ${rows.length} streets among ${parked.length} parked cars: ${bad.length} stalled or crawling, ${rows.filter((r) => r.over > 0.05).length} touched a parked car; time against an empty street, median ${ratio[ratio.length >> 1].toFixed(2)}, worst ${ratio[ratio.length - 1].toFixed(2)}`);
  for (const r of bad.sort((a, b) => b.stood - a.stood).slice(0, list)) {
    console.log(`  ${r.e.name || r.e.id} (${r.e.hw}, ${r.e.width} m): ${r.done ? 'slow' : 'never got through'}, stood ${r.stood.toFixed(0)} s at ${r.x.toFixed(1)}, ${r.y.toFixed(1)}`);
  }
  assert.equal(bad.length, 0, `no ${type} stalls behind parked cars`);
}
