#!/usr/bin/env node
// Real Traffic/Route decisions, without rendering, map files or a browser.
//   node scripts/check-traffic-queues.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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
const { Traffic } = await import('../src/traffic.ts');
const { DriveGraph, Route } = await import('../src/network.ts');

const raw = (id, u, v, pts, more = {}) => ({ id, u, v, pts, width: 6, oneway: true, hw: 'residential', ...more });
// Two actual generated countryside edges at the captured Zdibsko queue. Cars
// entering this outgoing lane make a 147.8-degree turn and face across its queue.
const ZDIBSKO = [
  raw('cn289970144_181652012>n289970352_181652348>0', 'n289970144_181652012', 'n289970352_181652348',
    [[-1818.9, 13700.17], [-1813.35, 13691.96], [-1808.95, 13684.12]], { width: 12, hw: 'secondary' }),
  raw('cn289970352_181652348>n289970372_181651940>0', 'n289970352_181652348', 'n289970372_181651940',
    [[-1808.95, 13684.12], [-1807.98, 13703.61]], { width: 12, hw: 'secondary' }),
];
function fixture(roads) {
  const graph = new DriveGraph(), edges = graph.add(roads);
  const traffic = new Traffic(graph, new THREE.Scene(), () => .5, 0), all = [];
  function add(edge, s, speed = 0, { type = 'sedan', L = 4.6, W = 1.82 } = {}) {
    const p = edge.path.at(s), r = W / 2 + .02;
    // Same complete circle chain as Car's constructor; mesh sync has no bearing on decisions.
    const n = Math.max(3, Math.ceil((L - 2 * r) / (2 * r)) + 1), end = L / 2 - r;
    const offsets = Array.from({ length: n }, (_, i) => -end + 2 * end * i / (n - 1));
    const car = { x: p.x, y: p.y, h: p.ang, vx: Math.cos(p.ang) * speed, vy: Math.sin(p.ang) * speed,
      w: 0, r, mode: 'traffic', gz: 0, type, spec: { L, W, vmax: 40 }, sync() {},
      circles() { return offsets.map(o => [this.x + Math.cos(this.h) * o, this.y + Math.sin(this.h) * o]); } };
    const a = { car, route: new Route(graph, edge, s, () => .5), speed, stuck: 0, jam: 0, off: 0, ignore: 0, cruise: 1 };
    traffic.agents.push(a); all.push(a); return a;
  }
  let minClearance = Infinity;
  const escapes = new Map();
  function step(seconds, { extra = [], clear = true, before = () => {} } = {}) {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      before(frame / 60);
      const obstacles = traffic.agents.flatMap(a => a.car.circles().map(([x, y]) => ({ x, y, z: 0, r: a.car.r,
        vx: a.car.vx, vy: a.car.vy, kind: 'car', car: a.car }))).concat(extra);
      traffic.update(1 / 60, () => obstacles);
      for (const a of all) if (a.ignore > 0 && !escapes.has(a)) escapes.set(a, { frame, speed: a.speed });
      if (!clear) continue; // Crossing/opposing controls preserve their existing squeeze-past behaviour.
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        if (all[i].gone || all[j].gone) continue;
        for (const [x, y] of all[i].car.circles()) for (const [u, v] of all[j].car.circles()) {
          const gap = Math.hypot(x - u, y - v) - all[i].car.r - all[j].car.r;
          minClearance = Math.min(minClearance, gap);
          assert.ok(gap >= -1e-6, `traffic circles overlap at frame ${frame}: ${gap.toFixed(3)} m`);
        }
      }
    }
  }
  return { graph, edges, traffic, add, step, escapes, get minClearance() { return minClearance; } };
}

// The actual map bend and a right-angle control start collision-free, with no
// manually seeded ignore state. A normal stopped queue triggers the escape timer.
const evidence = [];
for (const roads of [ZDIBSKO, [raw('in', 'a', 'b', [[0, 0], [30, 0]]), raw('out', 'b', 'c', [[30, 0], [30, 30]])]]) {
  for (const identity of roads === ZDIBSKO ? ['current', 'old leader', 'old follower'] : ['current']) {
    const f = fixture(roads); let [incoming, outgoing] = f.edges, leader, follower;
    if (identity === 'old follower') {
      follower = f.add(incoming, 0, 5, { type: 'taxi' }); follower.route.follow([outgoing]);
      f.graph.remove([incoming, outgoing]); [incoming, outgoing] = f.graph.add(roads);
      leader = f.add(outgoing, 7.45);
    } else {
      leader = f.add(outgoing, roads === ZDIBSKO ? 7.45 : 3.5);
      if (identity === 'old leader') { f.graph.remove([incoming, outgoing]); [incoming, outgoing] = f.graph.add(roads); }
      follower = f.add(incoming, 0, 5, { type: 'taxi' }); follower.route.follow([outgoing]);
    }
    leader.stop = { edge: leader.route.leg.edge, s: leader.route.s };
    if (identity !== 'current') {
      const follows = follower.route.legs.find(l => l.edge && l.edge !== follower.route.leg.edge).edge;
      assert.notEqual(leader.route.leg.edge, follows, 'tile reload produced a new edge object');
      assert.equal(leader.route.leg.edge.id, follows.id, 'the directed lane identity stayed the same');
    }
    f.step(20);
    assert.ok(f.escapes.has(follower), 'the ordinary stopped queue actually entered jam escape');
    assert.ok(f.escapes.get(follower).speed < .05, 'escape began from a stop');
    assert.equal(leader.jam, 0, 'the following taxi never blocks its leader');
    assert.equal(follower.speed < .05, true, 'the taxi still waits for the stopped leader');
    const clearance = f.minClearance;
    leader.stop = undefined;
    f.step(20);
    assert.ok(leader.gone && follower.gone, 'both cars finish their route when the leader sets off');
    evidence.push({ bend: roads === ZDIBSKO ? 'captured Zdibsko' : 'right angle', identity, minClearance: clearance });
  }
}

// Ordinary three-car following, including a taxi behind a van, still moves off
// when the stopped leader does. Every circle of all three bodies is checked.
{
  const f = fixture([raw('lane', 'a', 'b', [[0, 0], [300, 0]])]), [edge] = f.edges;
  const lead = f.add(edge, 60, 0, { type: 'van', L: 5.2, W: 2 }); lead.stop = { edge, s: 60 };
  const taxi = f.add(edge, 40, 4, { type: 'taxi' }), back = f.add(edge, 20, 4);
  f.step(20); assert.ok(f.escapes.has(taxi) && f.escapes.has(back));
  assert.equal(lead.jam, 0); lead.stop = undefined; f.step(20);
  assert.ok(taxi.car.x > 100 && back.car.x > 90, 'the three-car queue advances');
}

// A car crossing an unrelated directed edge, and a car facing the other way,
// keep the existing escape after a normal stop. Their edges are not future lanes.
for (const kind of ['crossing', 'opposing']) {
  const other = kind === 'crossing' ? [[30, -20], [30, 20]] : [[50, 0], [10, 0]];
  const f = fixture([raw('lane', 'a', 'b', [[0, 0], [100, 0]]), raw('other', 'x', 'y', other)]);
  const obstacle = f.add(f.edges[1], 20); obstacle.stop = { edge: f.edges[1], s: 20 };
  const follower = f.add(f.edges[0], 0, 5);
  f.step(30, { clear: false });
  assert.ok(f.escapes.has(follower), `${kind}: normal stopping still triggers escape`);
  assert.ok(follower.car.x > 50, `${kind}: unrelated traffic can still be passed`);
}
// Both crossing drivers can plan to use each other's lane much later. This is
// still crossing traffic now, rather than a queue on the immediate outgoing lane.
{
  const f = fixture([
    raw('lane', 'a', 'b', [[0, 0], [100, 0]]),
    raw('connector', 'b', 'x', [[100, 0], [100, -20], [30, -20]]),
    raw('crossing', 'x', 'y', [[30, -20], [30, 20]]),
    raw('return', 'y', 'a', [[30, 20], [0, 20], [0, 0]]),
  ]);
  const [lane, connector, crossing, back] = f.edges;
  const obstacle = f.add(crossing, 20); obstacle.stop = { edge: crossing, s: 20 };
  obstacle.route.follow([back, lane, connector]);
  const follower = f.add(lane, 0, 5); follower.route.follow([connector, crossing, back]);
  assert.ok(follower.route.legs.some(l => l.edge === crossing));
  assert.ok(obstacle.route.legs.some(l => l.edge === lane));
  f.step(30, { clear: false });
  assert.ok(f.escapes.has(follower), 'the crossing queue enters ordinary escape');
  assert.ok(follower.car.x > 50, 'distant shared preview edges do not prevent crossing escape');
}
for (const kind of ['person', 'player']) {
  const f = fixture([raw('lane', 'a', 'b', [[0, 0], [100, 0]])]);
  const car = f.add(f.edges[0], 0, 5);
  f.step(30, { extra: [{ kind, x: 30, y: 0, r: .4, vx: 0, vy: 0 }] });
  assert.ok(f.escapes.has(car));
  assert.ok(car.car.x < 27, `${kind}: escape never ignores a person`);
}
console.log('Traffic queue checks passed:', JSON.stringify(evidence));
