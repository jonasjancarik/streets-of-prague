#!/usr/bin/env node
// Deterministic pickup/one-way routing checks with real taxis, traffic and street graphs.
//   node scripts/check-taxi-routing.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '?lang=en' }; globalThis.self = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], documentElement: { lang: 'en' } };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { Taxis } = await import('../src/taxi.ts');
const { Traffic } = await import('../src/traffic.ts');
const { DriveGraph, Route } = await import('../src/network.ts');
const { Car, loadCars } = await import('../src/car.ts');
await loadCars('data:model/gltf-binary;base64,' + readFileSync(new URL('../public/cars.glb', import.meta.url)).toString('base64'));
const app = { name: 'Zipp', app: true, start: 45, perKm: 24 };
const street = { name: 'street taxi', app: false, start: 60, perKm: 36 };
const raw = (id, u, v, pts, more = {}) => ({ id, u, v, pts, hw: 'residential', width: 6, lanes: 1, oneway: true, ...more });
function graph({ loop = false, spawn = false, islandY = 15, islandFlags = {} } = {}) {
  const g = new DriveGraph();
  const [pickup, island, approach] = g.add([
    raw('pickup', 'a', 'b', [[0, 0], [100, 0]]),
    raw('island', 'i', 'j', spawn ? [[200, islandY], [400, islandY]] : [[10, islandY], [110, islandY]], islandFlags),
    raw('approach', 'c', 'a', spawn ? [[-300, 0], [0, 0]] : [[-60, 15], [0, 0]]),
  ]);
  if (loop) g.add([raw('return', 'b', 'a', [[100, 0], [100, -20], [0, -20], [0, 0]])]);
  return { g, pickup, island, approach };
}
function fixture(map, random = () => .5, destination = [0, 0]) {
  const scene = new THREE.Scene(), traffic = new Traffic(map.g, scene, random, 0), payments = [];
  const walker = { x: 20, y: 1, h: 0, vx: 0, vy: 0, gz: 0, mesh: { visible: true }, sync() {} };
  const taxi = new Taxis({ scene, traffic, drive: map.g, walker,
    world: { keyAt: () => '', hasAt: () => true, loaded: new Set(['']) },
    el: { addEventListener() {}, hidden: true }, edgesNear: () => map.g.edges, offscreen: () => true,
    toLocal: () => destination, standAt: (x, y) => [x, y], banner() {},
    wallet: { has: () => true, balance: 10000, take: (n) => { payments.push(n); return n; } },
  });
  const add = (edge, s, speed = 0) => {
    const p = edge.path.at(s), car = new Car('taxi', () => .5, p.x, p.y, p.ang);
    car.mode = 'traffic'; car.gz = 0;
    car.vx = Math.cos(p.ang) * speed; car.vy = Math.sin(p.ang) * speed;
    const a = { car, route: new Route(map.g, edge, s, () => .5), speed, stuck: 0, jam: 0, off: 0, ignore: 0, cruise: 1 };
    traffic.agents.push(a); return a;
  };
  const arrive = () => {
    for (let n = 0; n < 3600 && taxi.state === 'coming'; n++) { traffic.update(1 / 60, () => []); taxi.update(1 / 60); }
    assert.equal(taxi.state, 'waiting', 'the selected taxi physically reaches its pickup on the legal route');
    assert.ok(taxi.near()); assert.deepEqual(payments, [], 'booking and arriving do not charge a fare');
  };
  return { taxi, traffic, walker, payments, add, arrive };
}

// A closer car on a disconnected lane must not hide a farther one with a way through.
{
  const m = graph(), f = fixture(m), stranded = f.add(m.island, 10), reachable = f.add(m.approach, 20);
  f.taxi.call(app);
  assert.equal(f.taxi.agent, reachable); assert.ok(!stranded.hired);
  f.arrive();
}

// Stopped cars already within the existing boarding distance can wait where they
// stand. This includes an adjacent directed lane; moving taxis cannot use that rule.
for (const s of [18, 20, 26]) {
  const m = graph(), f = fixture(m), a = f.add(m.pickup, s);
  f.taxi.call(street);
  assert.equal(f.taxi.agent, a); assert.equal(a.stop.s, s);
  f.arrive();
}
{
  const m = graph({ islandY: 5 }), f = fixture(m), a = f.add(m.island, 10);
  f.taxi.call(street);
  assert.equal(f.taxi.agent, a); assert.equal(a.stop.edge, m.island);
  f.arrive();
}
for (const unsafe of ['moving', 'height', 'bridge', 'tunnel']) {
  const m = graph({ islandY: 5, islandFlags: unsafe === 'bridge' ? { bridge: true } : unsafe === 'tunnel' ? { tunnel: true } : {} });
  const f = fixture(m), a = f.add(m.island, 10, unsafe === 'moving' ? 2 : 0);
  if (unsafe === 'height') a.car.gz = 10;
  f.taxi.call(street);
  assert.equal(f.taxi.agent, null, `${unsafe}: nearby is insufficient for an unreachable or unsafe pickup`);
  assert.ok(!a.hired);
}

// A taxi that has passed the stop needs a legal directed loop. A random future
// preview of that same edge must not be mistaken for a stop on the current pass.
{
  const m = graph(), f = fixture(m), a = f.add(m.pickup, 30, 3);
  f.taxi.call(street); assert.equal(f.taxi.agent, null); assert.ok(!a.hired);
}
{
  const m = graph({ loop: true }), f = fixture(m), a = f.add(m.pickup, 30, 3);
  f.taxi.call(street);
  assert.equal(f.taxi.agent, a); assert.ok(a.route.legs.some((leg) => leg.edge?.id === 'return'));
  f.arrive();
}
{
  const m = graph(), f = fixture(m), a = f.add(m.approach, 0);
  a.route.advance(a.route.leg.s1 + .1);
  const p = a.route.leg.path.at(a.route.s); Object.assign(a.car, { x: p.x, y: p.y, h: p.ang });
  assert.equal(a.route.leg.edge, null, 'fixture is crossing into the pickup edge');
  f.taxi.call(app); assert.equal(f.taxi.agent, a);
  assert.equal(a.route.leg.edge, null, 'planning preserves the junction currently being crossed');
  f.arrive();
}
{
  const m = graph(), f = fixture(m, () => .5, [1000, 0]), a = f.add(m.pickup, 20);
  f.taxi.call(app); f.arrive(); assert.ok(f.taxi.enter());
  f.taxi.key('Digit1', false);
  assert.equal(f.taxi.state, 'riding'); assert.equal(f.taxi.dest, 0);
  assert.equal(f.taxi.final, false, 'a distant ride still plans to the nearest loaded street end');
  assert.equal(a.stop.edge, m.pickup); assert.equal(a.stop.s, m.pickup.path.length - 2);
  assert.deepEqual(f.payments, [], 'partial ride planning does not collect a fare early');
}

// Spawn filtering sees the actual edge/progress before Car allocation. An invalid
// car type would throw if the rejected candidate reached the constructor.
{
  const m = graph(), f = fixture(m); let rejected = 0;
  assert.equal(f.traffic.spawn((x, y, edge, s) => {
    rejected++; assert.equal(edge, m.pickup); assert.equal(x, edge.path.at(s).x); assert.equal(y, edge.path.at(s).y); return false;
  }, [m.pickup], '__invalid_car_type__'), null);
  assert.equal(rejected, 40); assert.equal(f.traffic.agents.length, 0);
  assert.throws(() => f.traffic.spawn(() => true, [m.pickup], '__invalid_car_type__'));
}
{
  const m = graph(), f = fixture(m);
  const ordinary = f.traffic.spawn((x, y) => x >= 0 && y === 0, [m.pickup]);
  assert.ok(ordinary, 'existing two-argument placement predicates still spawn ordinary traffic');
  assert.equal(ordinary.route.head, m.pickup);
}
{
  const m = graph({ spawn: true }), values = [.3, .5, .9, .5], f = fixture(m, () => values.shift() ?? .5), attempts = [];
  const spawn = f.traffic.spawn.bind(f.traffic);
  f.traffic.spawn = (allow, ...args) => spawn((x, y, edge, s) => {
    const accepted = allow(x, y, edge, s); attempts.push({ edge: edge.id, accepted }); return accepted;
  }, ...args);
  f.taxi.call(app);
  assert.deepEqual(attempts, [{ edge: 'island', accepted: false }, { edge: 'approach', accepted: true }]);
  assert.equal(f.traffic.agents.length, 1); assert.equal(f.taxi.agent.route.head, m.approach);
}
{
  const m = graph({ spawn: true }), f = fixture(m, () => .3);
  f.taxi.call(app);
  assert.equal(f.taxi.state, 'off'); assert.equal(f.taxi.agent, null);
  assert.equal(f.traffic.agents.length, 0); assert.deepEqual(f.payments, []);
}
console.log('Taxi routing passed: disconnected candidates, stopped nearby/at/past pickup, moving/unsafe exclusions, legal loops, junction progress, partial destination routes, spawn validation before allocation and unavailable service without a fare.');
