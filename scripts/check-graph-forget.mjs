#!/usr/bin/env node
// The street graphs forget tiles far behind you (DriveGraph.remove, WalkGraph.remove,
// StreetNames.remove, Crowd.forget, Police.forget, driven by TileWorld.forget). Offline,
// over the real map: a trip across the city joining and forgetting tiles as the game
// does, against a graph that keeps everything (as the game did before).
//   node --expose-gc scripts/check-graph-forget.mjs [--area praha] [--km 8]
// Checks that the sizes level off, that what is left is exactly what a new game standing
// at the same spot would have, and that the police find the same way through streets
// that were forgotten and came back. Prints the sizes and the heap with and without.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}});
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true });
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { DriveGraph, WalkGraph, StreetNames } = await import('../src/network.ts');
const { Crowd } = await import('../src/people.ts');
const { Police } = await import('../src/police.ts');
const { Scene } = await import('three');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const AREA = arg('area', 'praha'), KM = Number(arg('km', 8));
const dir = new URL(`../public/data/${AREA}_now/`, import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const T = index.tile, [ox, oy] = index.origin;
const available = new Set(index.tiles.map(([i, j]) => `${i}_${j}`));
const tile = (k) => JSON.parse(readFileSync(new URL(`tiles/${k}.json`, dir), 'utf8'));
// TileWorld.around.
const around = (x, y, r) => {
  const out = [];
  for (let i = Math.floor((x - r + ox) / T); i <= Math.floor((x + r + ox) / T); i++) {
    for (let j = Math.floor((y - r + oy) / T); j <= Math.floor((y + r + oy) / T); j++) {
      const k = `${i}_${j}`;
      if (!available.has(k)) continue;
      const d = Math.max(0, Math.hypot((i + 0.5) * T - ox - x, (j + 0.5) * T - oy - y) - T * 0.71);
      if (d <= r) out.push([d, k]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
};
// As in the game on foot: tiles load within 300 m, and the graphs keep 500 m more.
const LOAD = 300, BEYOND = 500;

// One game's worth of what is built from the street graphs.
function game(forgets) {
  const drive = new DriveGraph(), walk = new WalkGraph(), names = new StreetNames();
  const crowd = Object.assign(Object.create(Crowd.prototype), { cell: 16, segs: new Map() });
  const driveBy = new Map(), walkBy = new Map();
  const edgesNear = (x, y, r) => around(x, y, r).flatMap((k) => driveBy.get(k) || []);
  const walkNear = (x, y, r) => around(x, y, r).flatMap((k) => walkBy.get(k) || []);
  const police = new Police({ scene: new Scene(), drive, traffic: null, grid: null, height: () => 0, rng: Math.random, edgesNear, walk, walkNear, offscreen: () => true, onBusted() {}, kit: null });
  return {
    drive, walk, names, crowd, police, driveBy,
    at(x, y) {
      for (const k of around(x, y, LOAD)) {
        if (driveBy.has(k)) continue;
        const t = tile(k);
        driveBy.set(k, drive.add(t.drive));
        walkBy.set(k, walk.add(t.walk ?? []));
        names.add(driveBy.get(k));
        names.add(walk.fresh);
        crowd.index(walk.fresh);
      }
      if (!forgets) return;
      const keep = new Set(around(x, y, LOAD + BEYOND)), d = [], w = [];
      for (const k of [...driveBy.keys()]) {
        if (keep.has(k)) continue;
        d.push(...driveBy.get(k));
        w.push(...walkBy.get(k));
        driveBy.delete(k);
        walkBy.delete(k);
      }
      if (!d.length && !w.length) return;
      const dg = drive.remove(d), wg = walk.remove(w);
      names.remove(dg);
      names.remove(wg);
      crowd.forget(wg);
      police.forget(dg);
      police.forget(wg);
    },
    sizes() {
      const count = (m) => { let n = 0; for (const l of m.values()) n += l.length; return n; };
      return {
        tiles: driveBy.size, drive: drive.edges.length, driveNodes: drive.out.size, walk: walk.edges.length, walkNodes: walk.adj.size,
        nameCells: names.map.size, nameSegments: count(names.map), crowdCells: crowd.segs.size, crowdSegments: count(crowd.segs),
        policeNodes: police.nodes.size, policeLinks: count(police.links),
      };
    },
  };
}

// What a game holds, in a form that doesn't depend on the order things arrived in.
function picture(g) {
  const ids = (list) => list.map((e) => e.id).sort().join(' ');
  const map = (m, f) => [...m].map(([k, l]) => `${k}: ${f(l)}`).sort();
  return {
    drive: ids(g.drive.edges), driveById: [...g.drive.byId.keys()].sort().join(' '),
    out: map(g.drive.out, ids),
    twins: g.drive.edges.map((e) => `${e.id}>${e.twin ? `${e.twin.u}-${e.twin.v}` : ''}`).sort(),
    walk: ids(g.walk.edges), walkById: [...g.walk.byId.keys()].sort().join(' '),
    adj: map(g.walk.adj, (l) => l.map((o) => `${o.e.id}${o.fwd ? '+' : '-'}`).sort().join(' ')),
    names: map(g.names.map, (l) => l.map((s) => `${s.name}|${s.a}|${s.b}|${s.rank}`).sort().join(' ')),
    seen: g.names.seen.size,
    crowd: map(g.crowd.segs, (l) => l.map((s) => `${s.e.id}|${s.a}|${s.b}|${s.s0}`).sort().join(' ')),
    policeNodes: [...g.police.nodes.keys()].sort().join(' '),
    policeLinks: map(g.police.links, (l) => l.map((o) => `${o.e.id}>${o.to}${o.back ? 'b' : ''}${o.foot ? 'f' : ''}${o.cost}`).sort().join(' ')),
  };
}

const heap = () => { globalThis.gc?.(); return process.memoryUsage().heapUsed / 1e6; };
const STEP = 100, steps = Math.round((KM * 1000) / STEP), x0 = -KM * 500;
const base = heap();
const kept = game(false), trimmed = game(true);
const rows = [];
let peak = 0, compared = 0;
for (let n = 0; n <= steps; n++) {
  const x = x0 + n * STEP;
  kept.at(x, 0);
  trimmed.at(x, 0);
  // (The police link lazily, when a route is asked for.)
  if (n % 5 === 0) { kept.police.sync(); trimmed.police.sync(); }
  if (n % 10 === 0) {
    rows.push({ km: (n * STEP) / 1000, ...Object.fromEntries(Object.entries(trimmed.sizes()).map(([k, v]) => [k, `${v} / ${kept.sizes()[k]}`])) });
    // A new game that walks only the last stretch, as far as the graphs keep, has the
    // same tiles and must hold exactly the same.
    const fresh = game(false);
    for (const k of trimmed.driveBy.keys()) {
      const t = tile(k);
      fresh.driveBy.set(k, fresh.drive.add(t.drive));
      const w = fresh.walk.add(t.walk ?? []);
      fresh.names.add(fresh.driveBy.get(k));
      fresh.names.add(fresh.walk.fresh);
      fresh.crowd.index(fresh.walk.fresh);
      void w;
    }
    fresh.police.sync();
    trimmed.police.sync();
    assert.deepEqual(picture(trimmed), picture(fresh), `after ${n * STEP} m the graphs hold what a new game there would`);
    compared++;
  }
  if (n * STEP >= 2000) peak = Math.max(peak, trimmed.sizes().drive);
}
console.table(rows);
console.log('(each cell: forgetting / keeping everything)');

const end = trimmed.sizes(), all = kept.sizes();
const settled = rows.filter((r) => r.km >= 2).map((r) => Number(r.tiles.split(' ')[0]));
assert.ok(Math.max(...settled) <= 2 * Math.min(...settled), `the tiles held level off (${Math.min(...settled)}–${Math.max(...settled)})`);
assert.ok(all.tiles > 2 * Math.max(...settled), `a graph that keeps everything grows well past that (${all.tiles} tiles)`);
for (const key of Object.keys(end)) assert.ok(end[key] <= all[key], `${key} is no bigger than when everything is kept`);

// A pursuit back where the trip began: those streets were forgotten and are joined
// again as their tiles load. The police find the same way as in the game that kept
// everything, and the same again the other way.
let routes = 0;
for (const x of [x0 + 150, x0 + 900, 0]) {
  kept.at(x, 0);
  trimmed.at(x, 0);
  // Between points on the streets round the spot.
  const near = around(x, 0, LOAD).flatMap((k) => trimmed.driveBy.get(k) || []).filter((e) => !e.bridge && !e.tunnel);
  const spot = (i) => near[Math.floor((near.length - 1) * i)].pts[0];
  for (const [i, j] of [[0, 1], [0.2, 0.7], [0.9, 0.4], [0.5, 0.05]]) {
    const [ax, ay] = spot(i), [bx, by] = spot(j);
    for (const foot of [true, false]) {
      const a = kept.police.route(ax, ay, bx, by, foot), b = trimmed.police.route(ax, ay, bx, by, foot);
      assert.equal(!!b, !!a, `a way exists at ${x}, ${i} → ${j}, in both or neither`);
      if (!a || !b) continue;
      assert.ok(Math.abs(a.length - b.length) < 1, `the same way at ${x}: ${a.length.toFixed(1)} m keeping everything, ${b.length.toFixed(1)} m forgetting`);
      routes++;
    }
  }
}
assert.ok(routes >= 12, `enough ways were found to compare (${routes})`);

// Memory: the same trip, one game at a time.
let heaps = '';
if (globalThis.gc) {
  const measure = (forgets) => {
    const before = heap(), g = game(forgets);
    for (let n = 0; n <= steps; n++) { g.at(x0 + n * STEP, 0); if (n % 5 === 0) g.police.sync(); }
    const used = heap() - before;
    return [used, g];
  };
  const [a] = measure(false), [b] = measure(true);
  heaps = `; heap held by the graphs and their indexes after ${KM} km: ${a.toFixed(1)} MB keeping everything, ${b.toFixed(1)} MB forgetting`;
}
void base;
console.log(`ok: ${compared} comparisons with a new game, ${routes} police routes${heaps}`);
console.log(`after ${KM} km: ${end.tiles} tiles' streets held (${all.tiles} without forgetting), ${end.drive} drive edges (${all.drive}), ${end.walk} walk edges (${all.walk}), ${end.nameSegments} name segments (${all.nameSegments}), ${end.crowdSegments} crowd segments (${all.crowdSegments}), ${end.policeLinks} police links (${all.policeLinks})`);
