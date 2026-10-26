#!/usr/bin/env node
// Times parking per tile without a browser: the lane-clearance index alone
// (parkingClearance) and the whole of parkCars, as TileWorld.make calls them, and
// prints a hash of the parked cars so two revisions can be compared for sameness.
// node scripts/time-parking.mjs [area] [--tiles k1,k2,…] [--sample n] [--repeat 3]
import { City, loadModels, clearance } from './offline-city.mjs';
import { DriveGraph } from '../src/network.ts';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const area = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'praha';
await loadModels();
const city = new City(area);
let keys = flag('--tiles')?.split(',') ?? null;
if (!keys) {
  // Every n-th tile of the map, in a fixed order.
  const all = city.keys().sort(), n = Number(flag('--sample') ?? 60), step = Math.max(1, Math.floor(all.length / n));
  keys = all.filter((_, i) => i % step === 0).slice(0, n);
}
const repeat = Number(flag('--repeat') ?? 3);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let hash = 0, sumIndex = 0, sumPark = 0, rows = [];
for (const k of keys) {
  const t = city.tile(k);
  if (!t) continue;
  const halo = new DriveGraph();
  halo.add(city.halo(k).flatMap((tile) => tile.drive || []).sort((a, b) => a.id.localeCompare(b.id)));
  const index = [], park = [];
  let cars = [];
  for (let n = 0; n < repeat; n++) {
    let s = performance.now();
    clearance.parkingClearance(halo.edges, t.box);
    index.push(performance.now() - s);
    s = performance.now();
    cars = city.park(k).cars;
    park.push(performance.now() - s);
  }
  for (const c of cars) hash = (hash * 31 + Math.round(c.x * 100) * 7 + Math.round(c.y * 100) * 13 + Math.round(c.h * 1000) + c.type.length) % 2147483647;
  rows.push({ k, index: median(index), park: median(park), cars: cars.length });
  sumIndex += median(index); sumPark += median(park);
}
rows.sort((a, b) => b.park - a.park);
for (const r of rows.slice(0, Number(flag('--list') ?? 10))) console.log(`${r.k.padEnd(8)} clearance index ${r.index.toFixed(1).padStart(6)} ms, parking (with grid) ${r.park.toFixed(1).padStart(6)} ms, ${r.cars} cars`);
console.log(`${rows.length} tiles: clearance index ${sumIndex.toFixed(0)} ms, parking ${sumPark.toFixed(0)} ms in all (medians of ${repeat}); cars ${rows.reduce((a, r) => a + r.cars, 0)}, hash ${hash}`);
