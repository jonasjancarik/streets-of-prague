#!/usr/bin/env node
// Step-by-step traces of real Traffic decisions round parked cars, to show that a
// change to how the lane ahead is prepared (Route.ahead in Traffic.update) changes
// nothing: no browser, map files or network requests.
//   node scripts/check-traffic-lanes.mjs                    (just run, print the counts)
//   node scripts/check-traffic-lanes.mjs --record FILE      (save the traces as a baseline)
//   node scripts/check-traffic-lanes.mjs --compare FILE     (fail on any difference from it)
// The traces (pose, velocity, speed, route, offsets, timers, braking and every random
// draw) must match exactly; the counters (lane builds, pieces, Math.hypot calls) are
// reported side by side and only the "at most one lane build per car per step" rule is
// enforced. With --compare, fixtures with no parked car in reach must build no lane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import * as THREE from 'three';
import ts from 'typescript';
const root = new URL('../', import.meta.url);
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '?lang=en' }; globalThis.self = globalThis;
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], documentElement: { lang: 'en' } };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { Car, loadCars, useKit } = await import(new URL('src/car.ts', root));
const { loadKit } = await import(new URL('src/figures.ts', root));
const model = (file) => 'data:model/gltf-binary;base64,' + readFileSync(new URL('public/' + file, root)).toString('base64');
await loadCars(model('cars.glb'));
useKit(await loadKit(model('figures.glb')));
const { Traffic } = await import(new URL('src/traffic.ts', root));
const { DriveGraph, Route } = await import(new URL('src/network.ts', root));

const args = process.argv.slice(2), flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const recordFile = flag('--record'), compareFile = flag('--compare');

// Counters: lane builds and their pieces, and Math.hypot calls inside Traffic.update
// (each piece's length was one of them, once per parked-car circle).
const count = { ahead: 0, pieces: 0, hypot: 0, updating: false };
const ahead = Route.prototype.ahead;
Route.prototype.ahead = function (...a) { const n = ahead.apply(this, a); count.ahead++; count.pieces += n; return n; };
const hypot = Math.hypot;
Math.hypot = function (...a) { if (count.updating) count.hypot++; return hypot.apply(Math, a); };

// A seeded generator that keeps every value it hands out for the trace.
function seeded(seed) {
  let t = seed >>> 0;
  const r = () => { t = (t + 0x6D2B79F5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); const v = ((x ^ (x >>> 14)) >>> 0) / 4294967296; r.draws.push(v); return v; };
  r.draws = [];
  return r;
}
const raw = (id, u, v, pts, more = {}) => ({ id, u, v, pts, width: 7, lanes: 1, oneway: true, hw: 'residential', ...more });
// Both directions of a two-way street.
const both = (id, u, v, pts, more = {}) => [raw(id, u, v, pts, { oneway: false, ...more }), raw(id + '~', v, u, [...pts].reverse(), { oneway: false, ...more })];

function fixture(name, roads, seed, { ineligible = false } = {}) {
  const rng = seeded(seed), graph = new DriveGraph(), edges = graph.add(roads);
  const traffic = new Traffic(graph, new THREE.Scene(), rng, 0), parked = [], extra = [];
  // A car driven by traffic, `s` along `edge`, then along `plan`.
  function drive(edge, s, speed, type = 'sedan', plan = [], { gz = 0 } = {}) {
    const route = new Route(graph, edge, s, rng, type === 'bus' || type === 'minibus');
    if (plan.length) route.follow(plan);
    const p = route.leg.path.at(route.s), car = new Car(type, rng, p.x, p.y, p.ang);
    Object.assign(car, { mode: 'traffic', gz, vx: Math.cos(p.ang) * speed, vy: Math.sin(p.ang) * speed });
    const a = { car, route, speed, stuck: 0, jam: 0, ignore: 0, cruise: 0.95 + rng() * 0.25, off: 0 };
    traffic.agents.push(a); return a;
  }
  // A car left standing `lat` metres right of `edge`'s lane at `s`, turned by `turn`.
  function park(edge, s, lat, { type = 'sedan', turn = 0, z = 0 } = {}) {
    const p = edge.path.at(s), car = new Car(type, rng, p.x + Math.sin(p.ang) * lat, p.y - Math.cos(p.ang) * lat, p.ang + turn);
    car.gz = z; parked.push(car); return car;
  }
  function step(seconds, { before = () => {} } = {}) {
    const rows = [], counts = { steps: 0, agentSteps: 0, ahead: 0, pieces: 0, hypot: 0, maxAheadPerStep: 0 };
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      before(frame / 60);
      const obstacles = traffic.agents.flatMap((a) => a.car.circles().map(([x, y]) => ({ x, y, z: a.car.gz, r: a.car.r, vx: a.car.vx, vy: a.car.vy, kind: 'car', car: a.car })))
        .concat(parked.flatMap((c) => c.circles().map(([x, y]) => ({ x, y, z: c.gz, r: c.r, vx: 0, vy: 0, kind: 'car', car: c }))), extra);
      const agents = traffic.agents.length, a0 = count.ahead, p0 = count.pieces, h0 = count.hypot;
      rng.draws.length = 0;
      count.updating = true;
      traffic.update(1 / 60, () => obstacles);
      count.updating = false;
      const calls = count.ahead - a0;
      assert.ok(calls <= agents, `${name}: ${calls} lane builds for ${agents} cars in one step`);
      counts.steps++; counts.agentSteps += agents; counts.ahead += calls; counts.pieces += count.pieces - p0; counts.hypot += count.hypot - h0;
      counts.maxAheadPerStep = Math.max(counts.maxAheadPerStep, calls);
      rows.push([traffic.agents.map((a) => [a.car.x, a.car.y, a.car.h, a.car.vx, a.car.vy, a.speed, a.off, a.stuck, a.jam, a.ignore,
        a.route.s, a.route.legs.map((l) => [l.edge?.id ?? null, l.s0, l.s1]), a.kerb ? [a.kerb.off, a.kerb.left, a.kerb.merge] : null,
        a.car.braking, a.car.grounded ?? null, a.wait ?? null]), [...rng.draws]]);
    }
    return { name, ineligible, rows, counts };
  }
  return { edges, traffic, drive, park, parked, extra, step };
}

const fixtures = [];
const zigzag = (n, len, amp, y = 0) => Array.from({ length: n + 1 }, (_, i) => [i * len, y + (i % 2 ? amp : 0)]);

// No obstacles at all.
fixtures.push(() => { const f = fixture('empty lane', [raw('a', 'p', 'q', zigzag(8, 25, 4))], 1, { ineligible: true });
  f.drive(f.edges[0], 5, 6); return f.step(20); });
// Moving traffic only: a queue whose leader stops and goes again, on a bent street.
fixtures.push(() => { const f = fixture('moving traffic', [raw('a', 'p', 'q', zigzag(12, 30, 3))], 2, { ineligible: true });
  const [e] = f.edges, lead = f.drive(e, 60, 0, 'van'); lead.stop = { edge: e, s: 60 }; f.drive(e, 40, 5, 'taxi'); f.drive(e, 20, 5);
  return f.step(25, { before: (t) => { if (t > 12) lead.stop = undefined; } }); });
// People, the player and a tram in the way, and nothing parked.
fixtures.push(() => { const f = fixture('people and trams', [raw('a', 'p', 'q', zigzag(6, 30, 5))], 3, { ineligible: true });
  f.drive(f.edges[0], 2, 7); const p = f.edges[0].path.at(70);
  f.extra.push({ x: p.x, y: p.y, z: 0, r: 0.35, vx: 0, vy: 0, kind: 'person' }, { x: p.x + 1, y: p.y + 6, z: 0, r: 1.3, vx: 0, vy: 0, kind: 'tram' });
  return f.step(20, { before: (t) => { if (t > 8) f.extra.length = 0; } }); });
// Parked cars beside a straight one-piece lane, one jutting into it.
fixtures.push(() => { const f = fixture('parked straight', [raw('a', 'p', 'q', [[0, 0], [300, 0]], { width: 9 })], 4);
  const [e] = f.edges; for (let s = 30; s < 280; s += 6) f.park(e, s, 2.6); f.park(e, 120, 1.4, { type: 'van' });
  f.drive(e, 5, 8); f.drive(e, 15, 6, 'suv'); return f.step(40); });
// Parked cars on both sides of a bent two-way street, with traffic both ways.
fixtures.push(() => { const f = fixture('parked bends', both('a', 'p', 'q', zigzag(10, 22, 6), { width: 11 }), 5);
  const [e, back] = f.edges; for (let s = 15; s < e.path.length - 10; s += 7) { f.park(e, s, 2.4 + (s % 3) * 0.3, { turn: (s % 5) * 0.05 }); f.park(back, s + 3, 2.5); }
  f.park(e, 101, 1.2, { type: 'truck' }); f.drive(e, 2, 7); f.drive(e, 12, 6, 'bus'); f.drive(back, 20, 7, 'moto'); f.drive(back, 4, 6, 'suv'); return f.step(40); });
// A right turn through a junction connector, with cars parked round the corner and beyond it.
fixtures.push(() => { const f = fixture('junction', [raw('in', 'w', 'j', [[0, 0], [60, 0]]), raw('out', 'j', 'n', [[60, 0], [60, -80]]), raw('on', 'n', 'z', [[60, -80], [140, -90]])], 6);
  const [inc, out, on] = f.edges; f.park(inc, 52, 2.2); f.park(out, 4, 2.3, { turn: 0.4 }); f.park(out, 9, 1.6); for (let s = 20; s < 75; s += 6) f.park(out, s, 2.5);
  f.park(on, 6, 2.4); f.drive(inc, 10, 6, 'sedan', [out, on]); f.drive(inc, 30, 4, 'taxi', [out, on]); return f.step(40); });
// The end of the loaded street, with cars parked up to and past its end.
fixtures.push(() => { const f = fixture('endpoint', [raw('a', 'p', 'q', [[0, 0], [40, 5], [70, 0], [90, 8]])], 7);
  const [e] = f.edges; for (let s = 50; s < e.path.length; s += 5) f.park(e, s, 2.4); const p = e.path.at(e.path.length);
  const past = new Car('sedan', () => .5, p.x + 6, p.y + 1, 0); past.gz = 0; f.parked.push(past); f.drive(e, 5, 7); f.drive(e, 25, 7, 'van'); return f.step(30); });
// A bridge over a street of parked cars, with one car left standing on the bridge.
fixtures.push(() => { const f = fixture('bridge', [raw('b', 'p', 'q', [[0, 0], [60, 4], [140, 0]], { bridge: true, width: 9 }), raw('u', 'x', 'y', [[70, -30], [70, 40]])], 8);
  const [bridge, under] = f.edges; for (let s = 10; s < 70; s += 5) f.park(under, s, 0, { z: 0 }); f.park(bridge, 100, 2.5, { z: 8 });
  f.drive(bridge, 4, 9, 'sedan', [], { gz: 8 }); return f.step(25); });
// A parked car pulling off the pavement into a bent street, past other parked cars.
fixtures.push(() => { const f = fixture('pavement', [raw('a', 'p', 'q', zigzag(8, 20, 3), { width: 9 })], 9);
  const [e] = f.edges; for (let s = 10; s < 150; s += 6) if (s !== 40) f.park(e, s, 2.6);
  const leaving = new Car('sedan', () => .5, 0, 0, 0), p = e.path.at(40); Object.assign(leaving, { x: p.x + Math.sin(p.ang) * 2.6, y: p.y - Math.cos(p.ang) * 2.6, h: p.ang, gz: 0 });
  f.traffic.adopt(leaving, e, 40, 6); f.drive(e, 5, 5); return f.step(30); });
// Tiny and repeated points in the street's line, so lane pieces are short or skipped.
fixtures.push(() => { const f = fixture('short pieces', [raw('a', 'p', 'q', [[0, 0], [20, 0], [20, 1e-8], [20.05, 0.05], [20.1, 0.08], [40, 3], [40.0001, 3], [60, 0], [60.2, 0.3], [90, 4], [120, 0]])], 10);
  const [e] = f.edges; for (let s = 12; s < 110; s += 4.5) f.park(e, s, s % 9 < 4.5 ? 2.3 : -2.6); f.drive(e, 3, 6); f.drive(e, 14, 6, 'minibus'); return f.step(30); });
// A car parked squarely in a bent lane: queue, wait, then squeeze past.
fixtures.push(() => { const f = fixture('same lane', [raw('a', 'p', 'q', zigzag(8, 20, 4), { width: 6 })], 11);
  const [e] = f.edges; f.park(e, 70, 0, { type: 'van' }); f.park(e, 72, 2.2); f.park(e, 45, 2.4); f.drive(e, 30, 6); f.drive(e, 10, 6, 'suv'); return f.step(40); });
// A small grid of two-way streets, its cars placed by Traffic.spawn and turning at
// random, past cars parked on every street: many cars sharing the lane scratch.
fixtures.push(() => {
  const roads = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    roads.push(...both(`h${i}_${j}`, `n${i}_${j}`, `n${i}_${j + 1}`, [[j * 80, i * 80], [j * 80 + 40, i * 80 + (j % 2 ? 6 : -6)], [(j + 1) * 80, i * 80]], { width: 10 }));
    roads.push(...both(`v${j}_${i}`, `n${j}_${i}`, `n${j + 1}_${i}`, [[i * 80, j * 80], [i * 80 + (i % 2 ? 5 : -5), j * 80 + 40], [i * 80, (j + 1) * 80]], { width: 10 }));
  }
  const f = fixture('grid', roads, 12);
  let k = 0;
  for (const e of f.edges) for (let s = 12; s < e.path.length - 12; s += 9) if (++k % 3) f.park(e, s, 2.6, { turn: (k % 4) * 0.04 });
  for (let n = 0; n < 14; n++) f.traffic.spawn(null);
  for (const a of f.traffic.agents) a.car.gz = 0;
  return f.step(60);
});

// Cars left standing anywhere round bent two-way streets (in the lane, beside it, well
// off it, turned every way, now and then a dustcart at work) and a few cars driving
// both ways: the cars Traffic.update rules out before measuring them against every
// piece of the lane (laneBox) sit at every distance from where it draws the line.
for (let seed = 100; seed < 112; seed++) fixtures.push(() => {
  let t = seed * 7919; const fr = () => { t = (t * 16807) % 2147483647; return t / 2147483647; };
  const amp = fr() * 10, seg = 6 + fr() * 30;
  const f = fixture('scattered ' + seed, both('a', 'p', 'q', zigzag(12, seg, amp), { width: 6 + fr() * 8 }), seed);
  const [e, back] = f.edges;
  for (let i = 0, n = 30 + Math.floor(fr() * 80); i < n; i++) {
    const ed = fr() < 0.5 ? e : back, s = fr() * ed.path.length, lat = (fr() - 0.5) * (fr() < 0.3 ? 30 : 10);
    const car = f.park(ed, s, lat, { type: fr() < 0.2 ? 'van' : fr() < 0.1 ? 'truck' : 'sedan', turn: (fr() - 0.5) * 2 });
    if (fr() < 0.05) { car.mode = 'traffic'; car.working = true; }
  }
  for (let i = 0; i < 4; i++) { const ed = i % 2 ? back : e; f.drive(ed, 2 + fr() * ed.path.length * 0.5, fr() * 9, ['sedan', 'bus', 'moto', 'suv', 'van'][Math.floor(fr() * 5)]); }
  return f.step(20);
});

const named = {};
for (const make of fixtures) {
  const { name, ineligible, rows, counts } = make();
  // A short hash of each step, to find where a trace first differs, and some whole rows.
  const steps = rows.map((row) => createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 16));
  named[name] = { ineligible, steps, counts, sample: rows.filter((_, i) => i % 120 === 0) };
}

let revision = 'unknown';
try { revision = execSync('git rev-parse HEAD', { cwd: new URL('.', root) }).toString().trim() + (execSync('git status --porcelain src', { cwd: new URL('.', root) }).toString().trim() ? '+dirty' : ''); } catch {}
const table = (base) => Object.entries(named).map(([n, r]) => {
  const b = base?.fixtures[n]?.counts, c = r.counts;
  return `  ${n.padEnd(17)} steps ${String(c.agentSteps).padStart(6)}  lane builds ${b ? `${b.ahead} -> ` : ''}${c.ahead}  pieces ${b ? `${b.pieces} -> ` : ''}${c.pieces}  hypot ${b ? `${b.hypot} -> ` : ''}${c.hypot}`;
}).join('\n');

if (recordFile) {
  writeFileSync(recordFile, JSON.stringify({ revision, fixtures: named }));
  console.log(`Recorded traffic lane traces from ${revision} to ${recordFile}:\n${table()}`);
} else if (compareFile) {
  const base = JSON.parse(readFileSync(compareFile, 'utf8'));
  for (const [n, r] of Object.entries(named)) {
    const b = base.fixtures[n];
    assert.ok(b, `${n}: missing from the baseline`);
    assert.equal(r.steps.length, b.steps.length, `${n}: ${r.steps.length} steps, baseline ${b.steps.length}`);
    const at = r.steps.findIndex((h, i) => h !== b.steps[i]);
    assert.equal(at, -1, `${n}: trace differs from step ${at} on (baseline ${base.revision})`);
    assert.deepEqual(r.sample, b.sample, `${n}: sampled rows differ`);
    if (r.ineligible) assert.equal(r.counts.ahead, 0, `${n}: built the lane ahead with nothing parked in reach`);
  }
  console.log(`Traffic lane traces match ${base.revision} exactly (${revision}):\n${table(base)}`);
} else console.log(`Traffic lane checks ran (${revision}):\n${table()}`);
