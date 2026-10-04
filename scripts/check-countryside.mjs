#!/usr/bin/env node
// Makes countryside tiles (src/countryside.ts) from the local PMTiles file, without a
// browser, and checks that they hold together: the same tile comes out the same twice,
// a street crossing from one tile into the next is one street in the graph, and
// nothing reaches into the built map. Prints how long a tile takes.
//   node scripts/check-countryside.mjs [lon lat] [--dump out.json]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PMTiles } from 'pmtiles';
import { Countryside } from '../src/countryside.ts';

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
const setup = { centre: [(w + e) / 2, (s + n) / 2], tile: index.tile, origin: index.origin, cols: index.cols, rows: index.rows };
const make = () => new Countryside(async (z, x, y) => (await archive.getZxy(z, x, y))?.data, setup);
const land = make();

// The projection is the pipeline's: the map's south-west corner lands on its origin.
const [cx, cy] = land.metres(w, s);
assert.ok(Math.hypot(cx + index.origin[0], cy + index.origin[1]) < 0.05, `projection is off: ${cx}, ${cy}`);

const args = process.argv.slice(2), dump = args.indexOf('--dump');
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
const rect = [-index.origin[0], -index.origin[1], index.cols * T - index.origin[0], index.rows * T - index.origin[1]];
const edge = await make().tile(-1, 50);
for (const d of edge.drive) for (const [px, py] of d.pts) assert.ok(px <= rect[0] + 0.01, `edge ${d.id} runs into the built map`);

if (dump >= 0) fs.writeFileSync(args[dump + 1], JSON.stringify(tiles.get(`${ci}_${cj}`)));
console.log('ok');
