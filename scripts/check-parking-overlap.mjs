#!/usr/bin/env node
// Parked cars against each other for a whole built map, without a browser: every tile's
// cars are placed as the game places them (scripts/offline-city.mjs), and each pair whose
// bodies touch is counted, in the same tile or across a tile's edge.
// node scripts/check-parking-overlap.mjs [area] [--list n] [--strict]
import { City, loadModels, network } from './offline-city.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const area = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'centrum';
const list = Number(flag('--list') ?? 8);
await loadModels();
const city = new City(area);
const hash = new network.SpatialHash(10), parked = [];
for (const k of city.keys()) {
  const p = city.park(k);
  if (!p) continue;
  for (const c of p.cars) {
    c.tile = k;
    parked.push(c);
    for (const [x, y] of c.circles()) hash.add({ x, y, r: c.r, car: c });
  }
}
const pairs = [], seen = new Set();
parked.forEach((c, n) => { c.n = n; });
for (const c of parked) for (const [x, y] of c.circles()) for (const o of hash.near(x, y, c.r + 1.5)) {
  if (o.car === c || o.car.n < c.n) continue;
  const depth = c.r + o.r - Math.hypot(o.x - x, o.y - y), id = c.n * 1e6 + o.car.n;
  if (depth <= 0.02) continue;
  if (!seen.has(id)) { seen.add(id); pairs.push({ a: c, b: o.car, depth }); }
  else { const p = pairs.find((q) => q.a === c && q.b === o.car); p.depth = Math.max(p.depth, depth); }
}
const across = pairs.filter((p) => p.a.tile !== p.b.tile).length;
console.log(`${parked.length} parked cars, ${pairs.length} pairs touching (${across} across a tile's edge)`);
for (const p of pairs.sort((a, b) => b.depth - a.depth).slice(0, list)) {
  console.log(`  ${p.depth.toFixed(2)} m  ${p.a.type} / ${p.b.type}  at ${p.a.x.toFixed(1)}, ${p.a.y.toFixed(1)}  tiles ${p.a.tile}${p.a.tile === p.b.tile ? '' : ' / ' + p.b.tile}`);
}
if (args.includes('--strict') && pairs.length) process.exit(1);
