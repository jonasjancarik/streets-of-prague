#!/usr/bin/env node
// Driving directions (src/satnav.ts) offline: made-up streets for the one-way rules and
// the turns, then the real map round the Old Town, loaded as far as a car's view and
// kept as the game keeps it, for a way across the loaded streets, a way to somewhere
// not loaded yet, and how long the searches take.
//   node scripts/check-satnav.mjs [--area praha]
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import proj4 from 'proj4';
import ts from 'typescript';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
}});
globalThis.location = { search: '?lang=en' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem: () => {} }, configurable: true });
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], documentElement: { lang: 'en' } };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { DriveGraph } = await import('../src/network.ts');
const { findWay } = await import('../src/satnav.ts');

const joined = (way) => way.edges.every((e, i) => i === 0 || way.edges[i - 1].v === e.u);

// ---- Made-up streets ----
const raw = (id, u, v, pts, more = {}) => ({ id, u, v, pts, hw: 'residential', width: 6, lanes: 1, oneway: true, ...more });
{
  // A one-way street straight to the goal, against you, and the long way round.
  //   a ──► b ◄── c      (b→c is one way the wrong way: c→b only)
  //   │           ▲
  //   ▼           │
  //   d ────────► e
  const g = new DriveGraph();
  g.add([
    raw('ab', 'a', 'b', [[0, 0], [100, 0]]),
    raw('cb', 'c', 'b', [[200, 0], [100, 0]]),
    raw('ad', 'a', 'd', [[0, 0], [0, -100]]),
    raw('de', 'd', 'e', [[0, -100], [200, -100]]),
    raw('ec', 'e', 'c', [[200, -100], [200, 0]]),
    raw('in', 'z', 'a', [[-100, 0], [0, 0]]),
  ]);
  const near = () => g.edges;
  const way = findWay(g, near, { x: -50, y: 0, h: 0 }, { x: 200, y: 0 });
  assert.ok(way?.reached, 'the goal is reached');
  assert.deepEqual(way.edges.map((e) => e.id), ['in', 'ad', 'de', 'ec'], 'round the block, not against the one-way street');
  assert.ok(joined(way));
  assert.deepEqual(way.turns.map((x) => x.kind), ['right'], 'right off the street you are on; the bends with no other way go untold');
  // Facing the other way on a two-way street: it starts in the lane you're in.
  const two = new DriveGraph();
  two.add([raw('east', 'p', 'q', [[0, 0], [100, 0]], { oneway: false }), raw('west', 'q', 'p', [[100, 0], [0, 0]], { oneway: false })]);
  const back = findWay(two, () => two.edges, { x: 50, y: 1.5, h: Math.PI }, { x: 90, y: 0 });
  assert.equal(back.edges[0].id, 'west');
  assert.ok(back.reached && back.turns.some((x) => x.kind === 'back'), 'turning round to a goal behind you');
}

// ---- The real map ----
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const AREA = arg('area', 'praha');
const dir = new URL(`../public/data/${AREA}_now/`, import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
const T = index.tile, [ox, oy] = index.origin, [w0, s0, e0, n0] = index.bbox_wgs84;
const local = `+proj=tmerc +lat_0=${(s0 + n0) / 2} +lon_0=${(w0 + e0) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
const at = (lat, lon) => proj4('EPSG:4326', local, [lon, lat]);
const available = new Set(index.tiles.map(([i, j]) => `${i}_${j}`));
const around = (x, y, r) => {
  const out = [];
  for (let i = Math.floor((x - r + ox) / T); i <= Math.floor((x + r + ox) / T); i++) {
    for (let j = Math.floor((y - r + oy) / T); j <= Math.floor((y + r + oy) / T); j++) {
      const k = `${i}_${j}`;
      if (!available.has(k)) continue;
      const d = Math.max(0, Math.hypot((i + 0.5) * T - ox - x, (j + 0.5) * T - oy - y) - T * 0.71);
      if (d <= r) out.push(k);
    }
  }
  return out;
};
// In a car the tiles load within the view and 220 m more, about 600 m at the usual
// zoom, and the graph keeps 500 m beyond that (TileWorld.graphBeyond).
const g = new DriveGraph(), driveBy = new Map();
const [sx, sy] = at(50.08155, 14.41455); // Národní, at the National Theatre end
for (const k of around(sx, sy, 1100)) driveBy.set(k, g.add(JSON.parse(readFileSync(new URL(`tiles/${k}.json`, dir), 'utf8')).drive));
const near = (x, y, r) => [...new Set(around(x, y, r).flatMap((k) => driveBy.get(k) || []))];
console.log(`${driveBy.size} tiles, ${g.edges.length} lanes loaded`);
const timed = (from, to) => { const t0 = performance.now(), way = findWay(g, near, from, to); return { way, ms: performance.now() - t0 }; };
const from = { x: sx, y: sy, h: 0 }; // heading east along Národní

// Across the loaded streets: to Karlovo náměstí.
{
  const to = at(50.0768, 14.4193), crow = Math.hypot(to[0] - sx, to[1] - sy);
  const { way, ms } = timed(from, { x: to[0], y: to[1] });
  assert.ok(way?.reached, 'Karlovo náměstí is within the loaded streets');
  assert.ok(joined(way));
  const end = way.line.at(way.line.length);
  assert.ok(Math.hypot(end.x - to[0], end.y - to[1]) < 40, 'the way ends by the goal');
  assert.ok(way.line.length < crow * 2, `a sensible way (${Math.round(way.line.length)} m for ${Math.round(crow)} m as the crow flies)`);
  console.log(`Národní → Karlovo náměstí: ${Math.round(way.line.length)} m (${Math.round(crow)} m crow), ${way.edges.length} streets, ${ms.toFixed(1)} ms`);
  for (const x of way.turns) console.log(`  ${String(Math.round(x.at)).padStart(5)} m  ${x.kind}${x.onto ? `  ${x.onto}` : ''}`);
}

// To somewhere not loaded: Chodov, 8 km off. The way goes as far as the streets do, towards it.
{
  const to = at(50.0313, 14.4910);
  const { way, ms } = timed(from, { x: to[0], y: to[1] });
  assert.ok(way && !way.reached, 'a partial way');
  assert.ok(joined(way));
  const end = way.line.at(way.line.length), d0 = Math.hypot(to[0] - sx, to[1] - sy), d1 = Math.hypot(to[0] - end.x, to[1] - end.y);
  assert.ok(d1 < d0 - 500, `it ends nearer (${Math.round(d0)} → ${Math.round(d1)} m)`);
  console.log(`Národní → Chodov (not loaded): ${Math.round(way.line.length)} m, ends ${Math.round(d1)} m from it, ${ms.toFixed(1)} ms`);
}

// How long the searches take, between random spots in the loaded streets.
{
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const times = [];
  for (let i = 0; i < 40; i++) {
    const a = g.edges[Math.floor(r() * g.edges.length)], b = g.edges[Math.floor(r() * g.edges.length)];
    const p = a.path.at(a.path.length / 2), q = b.path.at(b.path.length / 2);
    let best = Infinity;
    for (let k = 0; k < 3; k++) { // (the quickest of three: the first runs cold)
      const { way, ms } = timed({ x: p.x, y: p.y, h: p.ang }, { x: q.x, y: q.y });
      if (way) assert.ok(joined(way));
      best = Math.min(best, ms);
    }
    times.push(best);
  }
  times.sort((a, b) => a - b);
  console.log(`40 random ways: median ${times[20].toFixed(1)} ms, slowest ${times[39].toFixed(1)} ms`);
}
console.log('Satnav passed: one-way streets, turns, a turn round, a way across the loaded streets and one towards a place not loaded yet.');
