#!/usr/bin/env node
// Makes countryside tiles (src/countryside.ts) from the local PMTiles file, without a
// browser, and checks that they hold together: the same tile comes out the same twice,
// a street crossing from one tile into the next is one street in the graph, and
// nothing reaches into the built map. Then the join with the built map (plan 021, step
// 2), all the way round `praha`: every built street that runs on outside is met by the
// generated streets at its outer end, none is doubled by a generated one, no junction
// stands twice, routes cross the map's edge both ways on each side, and the ground's
// height is the same on both sides. Prints how long a tile takes and the counts.
//   node scripts/check-countryside.mjs [lon lat] [--dump out.json] [--places] [--flat]
// The hills come from Mapzen's elevation tiles at AWS: the few it needs are fetched once
// and kept in pipeline/.cache/terrarium. --flat leaves the hills out (no network).
// --places lists where main roads leave the map (lat, lon), for screenshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PMTiles } from 'pmtiles';
import { Countryside } from '../src/countryside.ts';
import { HILLS_FROM, REACH, blendHeights, edgeGrid } from '../src/countrysideJoin.ts';
import { DriveGraph, WalkGraph } from '../src/network.ts';

const file = process.env.COUNTRYSIDE_FILE || 'public/data/countryside/central-bohemia.pmtiles';
const index = JSON.parse(fs.readFileSync('public/data/praha_now/index.json', 'utf8'));
const fd = fs.openSync(file);
const archive = new PMTiles({
  getKey: () => file,
  getBytes: async (offset, length) => {
    const b = Buffer.alloc(length);
    fs.readSync(fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) };
  },
});
const [w, s, e, n] = index.bbox_wgs84;
const setup = { centre: [(w + e) / 2, (s + n) / 2], tile: index.tile, origin: index.origin, cols: index.cols, rows: index.rows, size: index.size, grid: { n: index.terrain.n, step: index.terrain.step } };
const builtTile = (i, j) => { const f = `public/data/praha_now/tiles/${i}_${j}.json`; return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined; };
const args = process.argv.slice(2);
// An elevation tile as metres above the sea: an 8-bit RGB PNG, read here by hand.
function terrarium(png) {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  assert.ok(png[24] === 8 && png[25] === 2 && png[28] === 0, 'an elevation tile is not a plain 8-bit RGB PNG');
  const parts = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts)), line = w * 3, out = new Float32Array(w * h), row = new Uint8Array(line), up = new Uint8Array(line);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (line + 1)];
    for (let k = 0; k < line; k++) {
      const v = raw[y * (line + 1) + 1 + k], a = k >= 3 ? row[k - 3] : 0, b = up[k], c = k >= 3 ? up[k - 3] : 0;
      const p = a + b - c, paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      row[k] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = row[x * 3] * 256 + row[x * 3 + 1] + row[x * 3 + 2] / 256 - 32768;
    up.set(row);
  }
  return out;
}
const hilly = !args.includes('--flat'), demDir = 'pipeline/.cache/terrarium';
let demFetched = 0;
const elevation = hilly ? async (z, x, y) => {
  const f = `${demDir}/${z}_${x}_${y}.png`;
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`);
    if (!r.ok) return undefined;
    fs.mkdirSync(demDir, { recursive: true });
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
    demFetched++;
  }
  return terrarium(fs.readFileSync(f));
} : undefined;
const make = () => new Countryside(async (z, x, y) => (await archive.getZxy(z, x, y))?.data, async (i, j) => builtTile(i, j), setup, 15, undefined, elevation);
const land = make();

// The projection is the pipeline's: the map's south-west corner lands on its origin.
const [cx, cy] = land.metres(w, s);
assert.ok(Math.hypot(cx + index.origin[0], cy + index.origin[1]) < 0.05, `projection is off: ${cx}, ${cy}`);

const dump = args.indexOf('--dump');
const at = args.filter((a) => /^-?[\d.]+$/.test(a)).map(Number);
// Default: Beroun's old town, 12 km west of the map's edge (streets, a river, a motorway nearby).
const [x, y] = land.metres(at[0] ?? 14.072, at[1] ?? 49.964);
const T = index.tile, ci = Math.floor((x + index.origin[0]) / T), cj = Math.floor((y + index.origin[1]) / T);

const R = 4, tiles = new Map(), times = [];
for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) {
  const t0 = performance.now();
  tiles.set(`${i}_${j}`, await land.tile(i, j));
  times.push(performance.now() - t0);
}
const sorted = [...times].sort((a, b) => a - b), total = (k) => [...tiles.values()].reduce((a, t) => a + k(t), 0);
console.log(`${tiles.size} tiles round ${ci}_${cj}: median ${sorted[sorted.length >> 1].toFixed(1)} ms, worst ${sorted.at(-1).toFixed(0)} ms (the first reads its vector tiles)`);
console.log(`vector tiles read: ${land.stats.fetched}, ${(land.stats.bytes / 1024).toFixed(0)} kB unzipped`);
console.log(`street edges ${total((t) => t.drive.length)}, paths ${total((t) => t.walk.length)}, buildings ${total((t) => t.buildings.filter((b) => b.own).length)}, trees ${total((t) => t.trees.length)}, JSON ${(total((t) => JSON.stringify(t).length) / tiles.size / 1024).toFixed(0)} kB a tile`);

// The towns and villages round it, for the title on the screen.
const named = await land.places(x, y, 3000);
console.log(`places within 3 km: ${named.map((p) => `${p.name} (${p.kind}, ${Math.hypot(p.at[0] - x, p.at[1] - y).toFixed(0)} m)`).join(', ')}`);
if (at.length < 2) assert.ok(named.some((p) => p.name === 'Beroun' && p.kind === 'town' && Math.hypot(p.at[0] - x, p.at[1] - y) < 1000), 'Beroun is not among the places at Beroun');
assert.equal(new Set(named.map((p) => `${p.name} ${p.at}`)).size, named.length, 'a place is listed twice');

// The same tile from a fresh generator, asked for alone, is the same tile.
const again = await make().tile(ci, cj);
assert.deepEqual(again, tiles.get(`${ci}_${cj}`), 'a tile differs when it is made alone');

// Streets join up: every edge end met in two tiles has one id, and most ends lead on.
const out = new Map(), ends = new Map();
for (const t of tiles.values()) for (const d of t.drive) {
  if (out.has(d.id)) { assert.deepEqual(out.get(d.id).pts, d.pts, `edge ${d.id} differs between tiles`); continue; }
  out.set(d.id, d);
  for (const [node, p] of [[d.u, d.pts[0]], [d.v, d.pts.at(-1)]]) {
    const known = ends.get(node);
    if (known) assert.ok(Math.hypot(known[0] - p[0], known[1] - p[1]) < 0.02, `junction ${node} is in two places`);
    else ends.set(node, p);
  }
}
// Two junctions in one spot would be a street cut in two without knowing it.
const spots = new Map();
let split = 0;
for (const [node, p] of ends) {
  const k = `${Math.round(p[0] / 0.05)}_${Math.round(p[1] / 0.05)}`;
  if (spots.has(k) && spots.get(k) !== node) { split++; if (process.env.DEBUG) console.log("doubled", node, p, spots.get(k), ends.get(spots.get(k))); }
  spots.set(k, node);
}
const degree = new Map();
for (const d of out.values()) degree.set(d.u, (degree.get(d.u) || 0) + 1);
const inner = [...out.values()].filter((d) => { const [px, py] = d.pts.at(-1); return Math.abs(px - x) < (R - 0.5) * T && Math.abs(py - y) < (R - 0.5) * T; });
const stuck = inner.filter((d) => !(degree.get(d.v) > 0)).length;
console.log(`${out.size} directed edges, ${ends.size} junctions, ${split} junctions doubled, ${stuck} of ${inner.length} edges end with no way on`);
assert.equal(split, 0, 'a junction has two ids');

// Nothing generated lies inside the built map.
// The built map: it ends part of the way across its last column and row of tiles.
const rect = [-index.origin[0], -index.origin[1], index.size[0] - index.origin[0], index.size[1] - index.origin[1]];
const edge = await make().tile(-1, 50);
const ownEdges = new Set((builtTile(0, 50).drive || []).map((d) => d.id)); // the built streets it passes on do
for (const d of edge.drive) if (!ownEdges.has(d.id)) for (const [px, py] of d.pts) assert.ok(px <= rect[0] + 0.01, `edge ${d.id} runs into the built map`);

// ---- The join with the built map ----
const { cols, rows } = index, [ox, oy] = index.origin;
// The tiles the countryside makes, whole or in part: those past the grid, and the built
// map's last column and row where the map ends part of the way across them.
const generated = (a, b) => a < 0 || b < 0 || a >= cols || b >= rows || (a === cols - 1 && index.size[0] < cols * T - 0.5) || (b === rows - 1 && index.size[1] < rows * T - 0.5);
const outside = ([px, py]) => px < rect[0] || px > rect[2] || py < rect[1] || py > rect[3];
const beyond = ([px, py]) => Math.max(rect[0] - px, px - rect[2], rect[1] - py, py - rect[3]);
const dist = (p, pts) => {
  let best = Infinity;
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], dx = pts[k + 1][0] - ax, dy = pts[k + 1][1] - ay;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + dx * t - p[0], ay + dy * t - p[1]));
  }
  return best;
};
const walked = (pts, step) => {
  const o = [pts[0]];
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let q = 1; q <= m; q++) o.push([a[0] + ((b[0] - a[0]) * q) / m, a[1] + ((b[1] - a[1]) * q) / m]);
  }
  return o;
};

// The built map's rim: its streets, and those that run on outside (read here on their
// own, not through the generator).
const built = { drive: new Map(), walk: new Map() }, stubs = { drive: [], walk: [] };
const rim = [];
for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) if (i === 0 || j === 0 || i === cols - 1 || j === rows - 1) rim.push([i, j]);
let structuresAtEdge = 0;
for (const [i, j] of rim) {
  const t = builtTile(i, j);
  if (!t) continue;
  for (const g of ['drive', 'walk']) for (const e of t[g] || []) {
    if (built[g].has(e.id)) continue;
    built[g].set(e.id, e);
    if (e.pts.some(outside)) stubs[g].push(e);
  }
  for (const s of t.structures || []) if (s.polys.flat(2).some(([px, py]) => Math.min(px - rect[0], rect[2] - px, py - rect[1], rect[3] - py) < 0.5)) structuresAtEdge++;
}
const reach = Math.max(...[...stubs.drive, ...stubs.walk].map((e) => Math.max(...e.pts.map(beyond))));
console.log(`\nthe join: ${stubs.drive.length} built street edges and ${stubs.walk.length} walking edges run on outside the map, the longest ${reach.toFixed(0)} m`);
assert.ok(reach < REACH - 500, `a built street runs ${reach.toFixed(0)} m outside: raise REACH in src/countrysideJoin.ts`);

// Every countryside tile those streets pass through, and the ones round them.
const wanted = new Set();
for (const e of [...stubs.drive, ...stubs.walk]) for (const [px, py] of walked(e.pts, 100)) {
  const i = Math.floor((px + ox) / T), j = Math.floor((py + oy) / T);
  for (let a = i - 1; a <= i + 1; a++) for (let b = j - 1; b <= j + 1; b++) if (generated(a, b)) wanted.add(`${a}_${b}`);
}
// The map's own list of those streets (leaving.json, pipeline/layers.py), where it has
// one: the same streets as its rim tiles give, and the same countryside tiles from it.
const leavingFile = 'public/data/praha_now/leaving.json';
const listed = index.leaving ? JSON.parse(fs.readFileSync(leavingFile, 'utf8')) : null;
if (listed) {
  for (const g of ['drive', 'walk']) {
    assert.deepEqual(new Set(listed[g].map((e) => e.id)), new Set(stubs[g].map((e) => e.id)), `leaving.json's ${g} streets are not the rim tiles'`);
    for (const e of listed[g]) assert.deepEqual(e, built[g].get(e.id), `leaving.json's edge ${e.id} is not the tile's`);
  }
  console.log(`leaving.json lists the same ${listed.drive.length + listed.walk.length} edges (${(fs.statSync(leavingFile).size / 1024).toFixed(0)} kB)`);
} else console.log('this map has no leaving.json (built before pipeline/layers.py wrote it): the rim tiles are read instead');
const fromList = listed && new Countryside(async (z, x, y) => (await archive.getZxy(z, x, y))?.data, async () => { throw new Error('a rim tile was read although the map has leaving.json'); }, setup, 15, async () => listed);
const seamLand = make(), made = new Map();
let t0 = performance.now();
for (const k of wanted) { const [i, j] = k.split('_').map(Number); made.set(k, await seamLand.tile(i, j)); }
if (fromList) {
  let same = 0;
  for (const k of [...wanted].filter((_, q) => q % 6 === 0)) { const [i, j] = k.split('_').map(Number); assert.deepEqual(await fromList.tile(i, j), made.get(k), `tile ${k} differs when made from leaving.json`); same++; }
  console.log(`${same} of those tiles made from leaving.json are the same tiles`);
}
console.log(`${made.size} countryside tiles along them in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

const all = { drive: new Map(), walk: new Map() }; // generated edges (not the built ones the tiles pass on)
for (const t of made.values()) for (const g of ['drive', 'walk']) for (const e of t[g]) {
  if (built[g].has(e.id)) { assert.deepEqual(e, built[g].get(e.id), `built edge ${e.id} was changed`); continue; }
  all[g].set(e.id, e);
}
// A built street's outer part is in the tiles it passes through, with its surface.
for (const e of stubs.drive) {
  const out = walked(e.pts, 20).filter((p) => beyond(p) > 1);
  for (const p of out) {
    const t = made.get(`${Math.floor((p[0] + ox) / T)}_${Math.floor((p[1] + oy) / T)}`);
    assert.ok(t.drive.some((d) => d.id === e.id), `built edge ${e.id} is missing from tile ${t.i}_${t.j}`);
    // (A little to either side as well: the point may lie right where two pieces of the surface meet.)
    const on = [[0, 0], [0.3, 0.2], [-0.2, 0.3]].some(([sx, sy]) => (t.roads.road || []).some(([ring]) => {
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xi, yi] = ring[a], [xj, yj] = ring[b];
        if (yi > p[1] + sy !== yj > p[1] + sy && p[0] + sx < ((xj - xi) * (p[1] + sy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }));
    assert.ok(on, `no road surface under built edge ${e.id} at ${p}`);
  }
}

// The built map ends part of the way across its last column and row of tiles: the
// countryside fills the rest of each, to the last square metre.
{
  const ringArea = (r) => Math.abs(r.reduce((sum, p, k) => sum + p[0] * r[(k + 1) % r.length][1] - r[(k + 1) % r.length][0] * p[1], 0)) / 2;
  let partial = 0;
  for (const [i, j] of [[cols - 1, 50], [62, rows - 1], [cols - 1, rows - 1]]) {
    if (!generated(i, j)) continue;
    const t = await seamLand.tile(i, j), x0 = i * T - ox, y0 = j * T - oy;
    const builtPart = Math.max(0, Math.min(x0 + T, rect[2]) - x0) * Math.max(0, Math.min(y0 + T, rect[3]) - y0);
    const field = (t.areas.field || []).reduce((sum, [ring]) => sum + ringArea(ring), 0);
    assert.ok(Math.abs(field - (T * T - builtPart)) < 1, `tile ${i}_${j}: the countryside covers ${field.toFixed(0)} m² of the ${(T * T - builtPart).toFixed(0)} m² the built map leaves`);
    for (const d of [...t.drive, ...t.walk]) if (!built.drive.has(d.id) && !built.walk.has(d.id)) for (const p of d.pts) assert.ok(beyond(p) > -0.02, `generated edge ${d.id} runs into the built map in tile ${i}_${j}`);
    partial++;
  }
  console.log(`the map ends ${(cols * T - index.size[0]).toFixed(0)} m short of its last column's edge and ${(rows * T - index.size[1]).toFixed(0)} m short of its last row's: the countryside fills the rest of those tiles (${partial} checked)`);
}

// 1. Each built street's outer end leads on into the generated streets.
for (const g of ['drive', 'walk']) {
  const from = new Map(), to = new Map();
  for (const e of all[g].values()) { from.set(e.u, (from.get(e.u) || 0) + 1); to.set(e.v, (to.get(e.v) || 0) + 1); }
  const ends = new Map(); // outer junction → the classes of the built streets ending there
  for (const e of stubs[g]) for (const [node, p, leaving] of [[e.u, e.pts[0], false], [e.v, e.pts.at(-1), true]]) {
    if (!outside(p)) continue;
    const joined = g === 'walk' ? from.has(node) || to.has(node) : leaving || e.oneway === false ? from.has(node) || (g === 'drive' && !leaving && to.has(node)) : to.has(node);
    const known = ends.get(node) || { p, hw: e.hw, joined: false };
    known.joined ||= joined;
    ends.set(node, known);
  }
  const loose = [...ends.entries()].filter(([, v]) => !v.joined);
  const by = {};
  for (const [, v] of loose) by[v.hw] = (by[v.hw] || 0) + 1;
  console.log(`${g}: ${ends.size} outer ends of built streets, ${ends.size - loose.length} lead on into generated streets, ${loose.length} don't ${JSON.stringify(by)}`);
  if (process.env.DEBUG) for (const [node, v] of loose) console.log('  loose', g, node, v.hw, seamLand.lonLat(...v.p).reverse().map((c) => c.toFixed(5)).join(','));
  stubs[g].ends = ends;
  stubs[g].loose = loose;
}

// 2. No generated street lies along a built one, and none starts at the map's edge
// where a built street carries on.
for (const g of ['drive', 'walk']) {
  let doubled = 0, cutAtEdge = 0;
  for (const e of all[g].values()) {
    if (e.u[0] === 'r' || e.v[0] === 'r') cutAtEdge++;
    const near = stubs[g].filter((s) => s.pts.some(([px, py]) => Math.abs(px - e.pts[0][0]) < REACH && Math.abs(py - e.pts[0][1]) < REACH));
    const pts = walked(e.pts, 3), on = pts.filter((p) => near.some((s) => dist(p, s.pts) < 2)).length;
    if (pts.length > 3 && on / pts.length > 0.6) { doubled++; if (process.env.DEBUG) console.log('  doubled', g, e.id, e.hw, seamLand.lonLat(...e.pts[0]).reverse().join(',')); }
  }
  console.log(`${g}: ${all[g].size} generated edges, ${doubled} along a built street, ${cutAtEdge} start at the map's edge with no built street to carry on from`);
  stubs[g].doubled = doubled;
}

// 3. No junction twice: a built outer end with a generated junction still beside it.
let twice = 0;
const apart = new Set();
for (const g of ['drive', 'walk']) {
  const spots = new Map();
  for (const e of all[g].values()) for (const [node, p] of [[e.u, e.pts[0]], [e.v, e.pts.at(-1)]]) {
    const known = spots.get(node);
    // (Either side of a vector tile's edge places a point on it up to a decimetre apart; a
    // street cut at the map's edge, "r…", has no junction there.)
    if (known && node[0] !== 'r' && Math.hypot(known[0] - p[0], known[1] - p[1]) >= 0.15) { apart.add(node); if (process.env.DEBUG) console.log('  apart', g, node, known, p, e.id); }
    else spots.set(node, p);
  }
  for (const [node, v] of stubs[g].ends) for (const [other, p] of spots) {
    if (other !== node && other[0] !== 'r' && Math.hypot(p[0] - v.p[0], p[1] - v.p[1]) < 1.5) { twice++; if (process.env.DEBUG) console.log('  twice', g, node, other, seamLand.lonLat(...p).reverse().join(',')); }
  }
}
console.log(`junctions standing twice (a generated one within 1.5 m of a built street's outer end): ${twice}`);

// 4. Routes cross the map's edge: from inside the map along a main road out to 300 m
// past the built road's end and back in, on each side; the same on foot.
const sides = { west: (p) => rect[0] - p[0], east: (p) => p[0] - rect[2], south: (p) => rect[1] - p[1], north: (p) => p[1] - rect[3] };
const RANK = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified'];
const places = [];
for (const [side, past] of Object.entries(sides)) {
  for (const g of ['drive', 'walk']) {
    // The biggest roads that leave on this side.
    const picks = stubs[g].filter((e) => !outside(e.pts[0]) && past(e.pts.at(-1)) > 5 && RANK.includes(e.hw))
      .sort((a, b) => RANK.indexOf(a.hw) - RANK.indexOf(b.hw) || (a.id < b.id ? -1 : 1)).slice(0, g === 'drive' ? 4 : 2);
    assert.ok(picks.length, `no built street leaves the map to the ${side}`);
    for (const e of picks) {
      const end = e.pts.at(-1), ci = Math.floor((end[0] + ox) / T), cj = Math.floor((end[1] + oy) / T);
      const edges = new Map(built[g]);
      for (let a = ci - 5; a <= ci + 5; a++) for (let b = cj - 5; b <= cj + 5; b++) {
        if (!generated(a, b)) continue;
        for (const d of (await seamLand.tile(a, b))[g]) edges.set(d.id, d);
      }
      const far = (way) => {
        const next = new Map();
        for (const d of edges.values()) for (const [a, b] of way === 'out' ? [[d.u, d.v]] : [[d.v, d.u]]) { if (!next.has(a)) next.set(a, []); next.get(a).push([b, d]); }
        if (g === 'walk') for (const d of edges.values()) { if (!next.has(d.v)) next.set(d.v, []); next.get(d.v).push([d.u, d]); if (!next.has(d.u)) next.set(d.u, []); next.get(d.u).push([d.v, d]); }
        const seen = new Set([e.u]), queue = [e.u];
        let best = -Infinity;
        while (queue.length) for (const [b, d] of next.get(queue.pop()) || []) {
          if (seen.has(b)) continue;
          seen.add(b);
          queue.push(b);
          best = Math.max(best, past(d.u === b ? d.pts[0] : d.pts.at(-1)));
        }
        return best;
      };
      const out = far('out') - past(end), back = e.oneway ? Infinity : far('back') - past(end);
      const [lon, lat] = seamLand.lonLat(...end);
      if (g === 'drive') places.push({ side, hw: e.hw, name: e.name, lat: +lat.toFixed(5), lon: +lon.toFixed(5), out: Math.round(out) });
      assert.ok(out > 300, `${g}: no way out to the ${side} along ${e.hw} ${e.name || e.id} (${lat.toFixed(5)}, ${lon.toFixed(5)}): reaches ${out.toFixed(0)} m past the built road's end`);
      assert.ok(back > 300, `${g}: no way back in from the ${side} along ${e.hw} ${e.name || e.id} (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    }
  }
}
console.log(`routes cross the map's edge both ways at ${places.length} main roads (and on foot), 300 m and more past the built road's end`);
if (args.includes('--places')) console.table(places);

// 5. The ground: a countryside tile's grid has the built tile's own numbers along the
// edge they share, so the step there is nothing. (Bridges and tunnels are levels of
// their own; none may reach the edge, since the countryside has no levels yet.)
const N = index.terrain.n, scale = 0.1; // (heights are whole decimetres: src/terrain.ts)
let step = 0, compared = 0;
for (const [i, j] of rim) {
  const f = `public/data/praha_now/tiles/${i}_${j}.height.bin.gz`;
  if (!fs.existsSync(f)) continue;
  const raw = zlib.gunzipSync(fs.readFileSync(f)), from = new Uint16Array(raw.buffer, raw.byteOffset, N * N);
  for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
    const a = i + di, b = j + dj;
    if (a >= 0 && b >= 0 && a < cols && b < rows) continue;
    if (Math.max(0, Math.min(cols - 1, a)) !== i || Math.max(0, Math.min(rows - 1, b)) !== j) continue;
    const grid = edgeGrid(from, N, a, b, cols, rows);
    for (let q = 0; q < N; q++) {
      // The shared points: the countryside tile's side facing the built one.
      const pairs = [];
      if (di && !dj) pairs.push([q * N + (di < 0 ? N - 1 : 0), q * N + (di < 0 ? 0 : N - 1)]);
      if (dj && !di) pairs.push([(dj < 0 ? N - 1 : 0) * N + q, (dj < 0 ? 0 : N - 1) * N + q]);
      if (di && dj && !q) pairs.push([(dj < 0 ? N - 1 : 0) * N + (di < 0 ? N - 1 : 0), (dj < 0 ? 0 : N - 1) * N + (di < 0 ? 0 : N - 1)]);
      for (const [mine, theirs] of pairs) { step = Math.max(step, Math.abs(grid[mine] - from[theirs]) * scale); compared++; }
    }
  }
}
// The hills (plan 021, step 4). Round the place asked for: neighbouring tiles give the
// points they share the same height, the ground is level across each road, and the
// numbers are a real place's. At the map's edge: the blend is the flat at the edge
// and the hills HILLS_FROM metres out.
if (hilly) {
  const grids = new Map();
  const took = [];
  for (let i = ci - 2; i <= ci + 2; i++) for (let j = cj - 2; j <= cj + 2; j++) { const t1 = performance.now(); grids.set(`${i}_${j}`, await land.heights(i, j)); took.push(performance.now() - t1); }
  const perTile = took.sort((a, b) => a - b)[took.length >> 1];
  assert.ok([...grids.values()].every(Boolean), 'no heights where the elevation tiles should have them');
  let apart = 0, low = Infinity, high = -Infinity;
  for (const [k, g] of grids) {
    const [i, j] = k.split('_').map(Number), east = grids.get(`${i + 1}_${j}`), north = grids.get(`${i}_${j + 1}`);
    for (let q = 0; q < N; q++) {
      if (east) apart = Math.max(apart, Math.abs(g[q * N + N - 1] - east[q * N]));
      if (north) apart = Math.max(apart, Math.abs(g[(N - 1) * N + q] - north[q]));
    }
    for (const v of g) { low = Math.min(low, v / 10 + 100); high = Math.max(high, v / 10 + 100); }
  }
  assert.equal(apart, 0, 'two tiles give a point they share different heights');
  assert.ok(low > 100 && high < 1700 && high - low > 5, `heights from ${low} to ${high} m are not a place in Bohemia`);
  // Across each road of the middle tile: the height at its middle and a metre inside either edge.
  const step = index.terrain.step, mid = tiles.get(`${ci}_${cj}`), g = grids.get(`${ci}_${cj}`), bx = ci * T - ox, by = cj * T - oy;
  const at = (px, py) => {
    const fx = Math.max(0, Math.min(N - 1.001, (px - bx) / step)), fy = Math.max(0, Math.min(N - 1.001, (py - by) / step)), a = Math.floor(fx), b = Math.floor(fy);
    return ((g[b * N + a] * (1 - fx + a) + g[b * N + a + 1] * (fx - a)) * (1 - fy + b) + (g[(b + 1) * N + a] * (1 - fx + a) + g[(b + 1) * N + a + 1] * (fx - a)) * (fy - b)) / 10;
  };
  let tilt = 0, crossed = 0;
  for (const d of mid.drive) for (let k = 0; k < d.pts.length - 1; k++) {
    const [ax, ay] = d.pts[k], [qx, qy] = d.pts[k + 1], len = Math.hypot(qx - ax, qy - ay), side = Math.max(0.5, d.width / 2 - 1);
    for (let s2 = 2; s2 < len - 2; s2 += 5) {
      const px = ax + ((qx - ax) * s2) / len, py = ay + ((qy - ay) * s2) / len, nx = (-(qy - ay) / len) * side, ny = ((qx - ax) / len) * side;
      if (![[px + nx, py + ny], [px - nx, py - ny]].every(([sx, sy]) => sx > bx + 5 && sy > by + 5 && sx < bx + T - 5 && sy < by + T - 5)) continue;
      tilt = Math.max(tilt, Math.abs(at(px + nx, py + ny) - at(px - nx, py - ny)));
      crossed++;
    }
  }
  console.log(`\nhills: ${grids.size} tiles' heights in ${perTile.toFixed(1)} ms each at the median, ${took.at(-1).toFixed(0)} ms at worst (${demFetched} elevation tiles fetched just now), from ${low.toFixed(0)} to ${high.toFixed(0)} m; shared points agree; across ${crossed} places on the middle tile's roads the two sides differ by ${tilt.toFixed(2)} m at most`);
  assert.ok(tilt < 0.6, 'the ground tilts across a road');
  // The blend at the map's west edge, row 50: the flat at the edge, the hills HILLS_FROM out.
  const raw = zlib.gunzipSync(fs.readFileSync('public/data/praha_now/tiles/0_50.height.bin.gz')), from = new Uint16Array(raw.buffer, raw.byteOffset, N * N);
  const far = -Math.ceil(HILLS_FROM / T) - 1;
  for (const i of [-1, far]) {
    const flat = edgeGrid(from, N, i, 50, cols, rows), hills = await seamLand.heights(i, 50), both = blendHeights(flat, hills, N, T, i, 50, cols, rows);
    if (i === -1) for (let q = 0; q < N; q++) assert.equal(both[q * N + N - 1], from[q * N], 'the blended ground steps at the edge of the built map');
    else assert.deepEqual(both, hills, `the ground ${HILLS_FROM} m past the map is not the hills'`);
    if (i === -1) console.log(`at the west edge the built map is at ${(from[31 * N] / 10 + 100).toFixed(1)} m and the hills 250 m out at ${(hills[31 * N] / 10 + 100).toFixed(1)} m`);
  }
}

const bridges = [...stubs.drive, ...stubs.walk].filter((e) => e.bridge || e.tunnel).length;
console.log(`ground: the biggest step at the map's edge is ${step.toFixed(3)} m over ${compared} shared points; ${structuresAtEdge} bridges or tunnels touch the edge, ${bridges} built streets leave on one`);
assert.ok(step < 0.01, 'the ground steps at the edge of the built map');

// 6. The street graphs take and forget countryside tiles as they do built ones: a built
// street carried by a built tile and a countryside tile stays while either is loaded.
{
  const e = stubs.drive.find((d) => !outside(d.pts[0]) && beyond(d.pts.at(-1)) > 100), end = e.pts.at(-1);
  const inner = rim.map(([i, j]) => builtTile(i, j)).find((t) => t?.drive?.some((d) => d.id === e.id));
  const outer = await seamLand.tile(Math.floor((end[0] + ox) / T), Math.floor((end[1] + oy) / T));
  const drive = new DriveGraph(), walk = new WalkGraph();
  const a = drive.add(inner.drive), b = drive.add(outer.drive), wa = walk.add(inner.walk), wb = walk.add(outer.walk);
  assert.ok(inner.drive.some((d) => d.id === e.id) && outer.drive.some((d) => d.id === e.id), 'the built street is not in both tiles');
  assert.ok((drive.out.get(e.v) || []).some((d) => d.id[0] === 'c'), 'no generated street leaves the built street\'s outer end in the graph');
  drive.remove(a);
  assert.ok(drive.byId.has(e.id), 'the built street left the graph while a countryside tile still carries it');
  drive.remove(b);
  walk.remove(wa);
  walk.remove(wb);
  assert.equal(drive.byId.size + walk.byId.size, 0, 'streets stay in the graphs after their tiles are forgotten');
  console.log('the street graphs take and forget a countryside tile as they do a built one');
}

const share = (g) => 1 - stubs[g].loose.length / stubs[g].ends.size;
assert.ok(stubs.drive.loose.every(([, v]) => !['motorway', 'trunk', 'primary', 'secondary'].includes(v.hw)), 'a main road leaves the map and ends');
assert.ok(share('drive') > 0.9 && share('walk') > 0.85, 'too many built streets end outside the map with nothing to carry on');
assert.equal(stubs.drive.doubled, 0, 'a generated street lies along a built one');
// (On foot a few remain: a path crossing a built street with no point of its own there.)
assert.ok(stubs.walk.doubled <= 5, 'generated paths lie along built ones');
assert.equal(apart.size, 0, 'a junction is in two places');
assert.equal(twice, 0, 'a junction stands twice');

if (dump >= 0) fs.writeFileSync(args[dump + 1], JSON.stringify(tiles.get(`${ci}_${cj}`)));
console.log('ok');
