#!/usr/bin/env node
// Bus lines against the street network of a built map, without a browser: a bus joins
// each line wherever it can (as busStart does) and BusRun picks its way from junction
// to junction. A place inside the map where the run ends and the line can only be
// joined again further on is a break: the game's bus there leaves its line and is
// taken off the road. First two fixtures: a short side street beside the line, and a
// stretch of line with no street for cars.
// node scripts/check-bus-lines.mjs [area] [--list n] [--most n]
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { City, network } from './offline-city.mjs';
const buses = await import('../src/buses.ts');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const area = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'centrum';
const { DriveGraph, Polyline } = network;

// Follows `line` from `edge` as a bus's route does; returns the run and the streets taken.
function follow(g, line, edge, along) {
  const run = new buses.BusRun(line, along, (n) => g.out.get(n) || []);
  const taken = [edge];
  for (let e = edge, n = 0; n < 5000; n++) {
    const opts = (g.out.get(e.v) || []).filter((o) => o !== e.twin);
    // (Out of a dead end a route turns back, and the bus is asked again at the next junction.)
    const f = run.pick(e, opts) ?? (!run.lost && !opts.length ? e.twin : null);
    if (!f) break;
    taken.push(e = f);
  }
  return { run, taken };
}

{
  const street = (id, u, v, pts, extra = {}) => ({ id, u, v, pts, hw: 'tertiary', width: 7, oneway: true, lanes: 1, ...extra });
  // The line runs east along y = 0. At `b` a 7 m stub leads off before the street the
  // line takes; between `c` and `d` the line's own street is missing, and the way
  // round is a block to the south.
  const g = new DriveGraph();
  g.add([
    street('ab', 'a', 'b', [[0, 0], [100, 0]]),
    street('stub', 'b', 's', [[100, 0], [104, 6]]), street('stub2', 's', 't', [[104, 6], [104, 80]]),
    street('bc', 'b', 'c', [[100, 0], [200, 0]]),
    street('down', 'c', 'e', [[200, 0], [200, -80]]), street('along', 'e', 'f', [[200, -80], [320, -80]]), street('up', 'f', 'd', [[320, -80], [320, 0]]),
    street('dz', 'd', 'z', [[320, 0], [500, 0]]),
  ]);
  const line = { ref: 'T', to: 'East', path: new Polyline([[0, 0], [500, 0]]), stops: [[250, 'In the gap'], [400, 'After']] };
  const { run, taken } = follow(g, line, g.byId.get('ab'), 10);
  assert.deepEqual(taken.map((e) => e.id), ['ab', 'bc', 'down', 'along', 'up', 'dz'], 'past the stub, round the gap and back onto the line');
  assert.ok(!run.lost || run.ahead > 480, 'the line is kept to its end');
  // The bus itself: off the line on the way round it makes for no stop, and back on
  // the line the stop it could not reach is behind it.
  const bus = new buses.BusRun(line, 10, (n) => g.out.get(n) || []);
  for (let e = g.byId.get('ab'), n = 0; n < 4; n++) e = bus.pick(e, (g.out.get(e.v) || []).filter((o) => o !== e.twin));
  bus.track(150, 0);
  assert.equal(bus.away, false);
  bus.track(200, -40);
  assert.equal(bus.away, true, 'off the line on the way round');
  bus.track(330, 0);
  assert.ok(!bus.away && bus.along > 300 && bus.stop === 1, `back on the line past the gap (along ${bus.along.toFixed(0)}, next stop ${bus.stop})`);
  console.log('Bus line fixtures passed: a short side street beside the line, a way round a missing street, stops skipped on the way round');
}

const city = new City(area);
if (!existsSync(new URL('buses.json', city.dir))) { console.log(`${area} has no bus lines`); process.exit(0); }
const g = city.graph();
const lines = buses.parseBusLines(JSON.parse(readFileSync(new URL('buses.json', city.dir), 'utf8')));
const cell = 60, index = new Map();
for (const e of g.edges) {
  if (e.bridge || e.tunnel || e.path.length < 16) continue;
  const keys = new Set(e.path.pts.map(([x, y]) => Math.floor(x / cell) * 131072 + Math.floor(y / cell)));
  for (const k of keys) { let l = index.get(k); if (!l) index.set(k, l = []); l.push(e); }
}
// Where a bus can join the line `along` it (busStart's rule).
function join(line, along) {
  const p = line.path.at(along);
  let best = null, bestD = 8;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const e of index.get((Math.floor(p.x / cell) + i) * 131072 + Math.floor(p.y / cell) + j) || []) {
    const [s, d] = buses.project(e.path, p.x, p.y);
    if (d >= bestD || s < 6 || s > e.path.length - 8 || Math.cos(e.path.at(s).ang - p.ang) < 0.8) continue;
    best = e;
    bestD = d;
  }
  return best;
}
// (Lines run past the map's edge; a break there is the map ending.)
const [w, h] = city.index.size, inner = (x, y) => x > -city.ox + 150 && x < w - city.ox - 150 && y > -city.oy + 150 && y < h - city.oy - 150;
let total = 0, driven = 0;
const breaks = [];
for (const line of lines) {
  const L = line.path.length;
  total += L;
  // (Before the first street a bus can join, the line hasn't begun for a bus: at a
  // terminus in a knot of short streets, as at Florenc, it starts a little further on.)
  let open = null, joined = false;
  for (let along = 0; along < L - 10;) {
    const edge = join(line, along);
    const reach = edge ? Math.max(follow(g, line, edge, along).run.ahead, along) : along;
    if (reach - along < 30) { if (joined) open ??= along; along += 10; continue; }
    joined = true;
    if (open !== null) {
      const p = line.path.at(open), q = line.path.at(along);
      if (inner(p.x, p.y) && inner(q.x, q.y)) breaks.push({ line, from: open, len: along - open, p });
      open = null;
    }
    driven += reach - along;
    if (reach < L - 30) open = reach;
    along = reach + 10;
  }
}
const long = breaks.filter((b) => b.len > 30);
console.log(`${area}: ${lines.length} lines, ${(total / 1000).toFixed(0)} km (${Math.round((100 * driven) / total)} % on the map's streets); ${breaks.length} breaks inside the map, ${long.length} of them longer than 30 m`);
for (const b of breaks.sort((a, c) => c.len - a.len).slice(0, Number(flag('--list') ?? 12))) {
  console.log(`  ${b.line.ref} to ${b.line.to}: ${b.len.toFixed(0)} m from ${b.p.x.toFixed(0)}, ${b.p.y.toFixed(0)}`);
}
assert.ok(long.length <= Number(flag('--most') ?? 0), `no line breaks for more than 30 m inside the map (${long.length})`);
