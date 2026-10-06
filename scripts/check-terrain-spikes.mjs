#!/usr/bin/env node
// Spikes and pits in the ground of a built map, in every tile: a lattice point that
// stands above, or lies below, every neighbour with its own label by more than --over
// metres (2 unless given). A slope, however steep, has points both higher and lower
// beside each of its own; a lone point metres off its neighbours is what shows in the
// game as a spike or a pit (the terrain-steps skill, "Finding what's wrong at a place").
//
//   node scripts/check-terrain-spikes.mjs [area, praha] [--data public/data] [--over 2] [--worst 40] [--save out.json]
//
// Lists the worst places (latitude, longitude, tile, the point's height and its
// neighbours' range) and how many there are by size. It reports; it doesn't fail.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const args = {}, pos = [];
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
const root = new URL('..', import.meta.url).pathname;
const area = pos[0] || 'praha', dir = join(args.data || join(root, 'public/data'), `${area}_now`);
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const { tile: T, origin: [ox, oy], terrain: { n, step } } = index;
const OVER = Number(args.over || 2);
const [bw, bs, be, bn] = index.bbox_wgs84, lat0 = (bs + bn) / 2, lon0 = (bw + be) / 2, rad = Math.PI / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * rad), mLon = (lat) => 111412.84 * Math.cos(lat * rad) - 93.5 * Math.cos(3 * lat * rad);
const toWgs = (x, y) => { const lat = lat0 + y / mLat; return [+lat.toFixed(5), +(lon0 + x / mLon(lat)).toFixed(5)]; };

const found = [];
let tiles = 0;
for (const [i, j] of index.tiles) {
  const gz = join(dir, 'tiles', `${i}_${j}.height.bin.gz`), plain = join(dir, 'tiles', `${i}_${j}.height.bin`);
  if (!existsSync(gz) && !existsSync(plain)) continue;
  const raw = readFileSync(existsSync(gz) ? gz : plain), buf = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  const h = new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * n * 2));
  const labels = buf.byteLength >= n * n * 3 ? buf.subarray(n * n * 2, n * n * 3) : null;
  tiles++;
  // (The tile's own points only: its edge points are judged by the neighbours they have here.)
  for (let q = 0; q < n; q++) {
    for (let p = 0; p < n; p++) {
      const o = q * n + p, me = h[o], label = labels ? labels[o] : 0;
      if (label === 1) continue; // water is flat
      let lo = Infinity, hi = -Infinity, count = 0;
      for (let dq = -1; dq <= 1; dq++) {
        for (let dp = -1; dp <= 1; dp++) {
          const a = p + dp, b = q + dq;
          if ((!dp && !dq) || a < 0 || b < 0 || a >= n || b >= n) continue;
          const k = b * n + a;
          if (labels && labels[k] !== label) continue;
          lo = Math.min(lo, h[k]); hi = Math.max(hi, h[k]); count++;
        }
      }
      if (count < 4) continue;
      const off = me > hi ? (me - hi) / 10 : me < lo ? (me - lo) / 10 : 0;
      if (Math.abs(off) > OVER) {
        found.push({ off: +off.toFixed(1), at: toWgs(i * T - ox + p * step, j * T - oy + q * step), tile: `${i}_${j}`, label, h: me / 10 + 100, around: [lo / 10 + 100, hi / 10 + 100] });
      }
    }
  }
}
found.sort((a, b) => Math.abs(b.off) - Math.abs(a.off));
const count = (f) => found.filter(f).length;
console.log(`${area}: built ${index.built}, ${tiles} tiles; ${found.length} lone points more than ${OVER} m off every neighbour of their label `
  + `(${count((f) => f.off > 0)} spikes, ${count((f) => f.off < 0)} pits; ${count((f) => Math.abs(f.off) > 5)} over 5 m, ${count((f) => Math.abs(f.off) > 10)} over 10 m)`);
const byTile = new Map();
for (const f of found) byTile.set(f.tile, (byTile.get(f.tile) || 0) + 1);
console.log(`Tiles with the most: ${[...byTile].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, c]) => `${k} (${c})`).join(', ')}`);
for (const f of found.slice(0, Number(args.worst || 40))) {
  console.log(`  ${String(f.off).padStart(6)} m  ${f.at.join(', ')}  tile ${f.tile}, ${f.h.toFixed(1)} m among ${f.around[0].toFixed(1)}–${f.around[1].toFixed(1)} m${f.label ? `, terrace ${f.label}` : ''}`);
}
if (args.save) writeFileSync(args.save, JSON.stringify({ built: index.built, over: OVER, found }));
