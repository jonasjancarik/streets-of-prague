#!/usr/bin/env node
// Measures the pitched roofs the game builds from footprints (src/map/buildings.ts), so
// that two versions of the roof builder can be compared building by building.
//
//   node scripts/roof-compare.mjs record out.json   every roof in the sample, as built now
//   node scripts/roof-compare.mjs diff a.json b.json [--list n]
//
// The sample: every tile of `ujezd` and `centrum`, and every 40th tile of `praha` (which
// reaches the suburbs and the villages past the city limits). Every building of a tile is
// measured, as with ?osm; `game` marks the ones the game really extrudes (those IPR's 3D
// model doesn't have). Buildings the roof rules make flat are left out.
//
// Each building goes through buildBuildings on its own, as in the tile worker. Of its mesh,
// the roof is the triangles that aren't vertical. Recorded per roof:
//   verts   vertices of the roof's triangles
//   top     the highest point over the eaves, m
//   area    the roof's surface, m²
//   plan    the roof's area seen from above over the footprint's (1 = covers it exactly)
//   ridge   length of the ridges and of the hips and valleys between them: the edges where
//           two slopes meet with both ends above the eaves, m
//   flat    true when the skeleton failed and the roof fell back to flat
// and per tile the time buildBuildings took for all its buildings.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { signedArea } from '../src/map/geo.ts';

// straight-skeleton 3 is built for browsers and workers only: it wants these two to exist.
globalThis.self ??= globalThis;
globalThis.importScripts ??= () => {};
const { initRoofs, buildBuildings } = await import('../src/map/buildings.ts');

const read = (f) => { let b = fs.readFileSync(f); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return JSON.parse(b); };
const [mode, ...rest] = process.argv.slice(2);

function sample() {
  const out = [];
  for (const [area, every] of [['ujezd', 1], ['centrum', 1], ['praha', 40]]) {
    const dir = `public/data/${area}_now/tiles/`;
    const files = fs.readdirSync(dir).filter((f) => /^\d+_\d+\.json$/.test(f)).sort();
    files.forEach((f, i) => { if (i % every === 0) out.push({ area, file: dir + f, key: `${area}/${f.replace('.json', '')}` }); });
  }
  return out;
}

export function measure(b, built) {
  const p = built.mesh.geometry.attributes.position.array, n = built.mesh.geometry.attributes.normal.array;
  const eaves = Math.max(b.h, b.minh + 3);
  let verts = 0, top = 0, area = 0, plan = 0, bad = 0;
  const edges = new Map();
  const key = (i) => `${Math.round(p[i] * 1000)},${Math.round(p[i + 1] * 1000)},${Math.round(p[i + 2] * 1000)}`;
  for (let t = 0; t < p.length; t += 9) {
    if (!(n[t + 1] > 1e-6)) continue; // a wall or a gable end
    verts += 3;
    for (let i = t; i < t + 9; i++) if (!Number.isFinite(p[i])) bad++;
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2];
    const vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    area += Math.hypot(cx, cy, cz) / 2;
    plan += Math.abs(cy) / 2;
    for (let v = 0; v < 3; v++) {
      const i = t + v * 3, j = t + ((v + 1) % 3) * 3;
      top = Math.max(top, p[i + 1] - eaves);
      if (p[i + 1] < eaves - 1e-3) bad++;
      if (p[i + 1] > eaves + 1e-3 && p[j + 1] > eaves + 1e-3) {
        const a = key(i), c = key(j), k = a < c ? a + '|' + c : c + '|' + a;
        const e = edges.get(k) ?? { len: Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1], p[j + 2] - p[i + 2]), normals: [] };
        e.normals.push([n[t], n[t + 1], n[t + 2]]);
        edges.set(k, e);
      }
    }
  }
  let ridge = 0;
  for (const e of edges.values()) {
    const [a, c] = e.normals;
    // An edge inside one slope has the same normal on both sides; a ridge, hip or valley hasn't.
    if (!c || a[0] * c[0] + a[1] * c[1] + a[2] * c[2] < 0.9999) ridge += e.len;
  }
  const foot = Math.abs(b.rings.reduce((s, r, i) => s + (i ? -1 : 1) * Math.abs(signedArea(r)), 0));
  const r = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
  return { verts, top: r(top), area: r(area, 2), plan: r(plan / (foot || 1), 4), ridge: r(ridge, 2), ...(bad ? { bad } : {}), ...(built.stats.failed ? { flat: true } : {}) };
}

async function record(out) {
  await initRoofs();
  const roofs = {}, tiles = {};
  let crashed = 0;
  for (const { file, key } of sample()) {
    const t = read(file);
    const [x0, y0, x1, y1] = t.box;
    const size = [x1 - x0, y1 - y0], origin = [-x0, -y0], water = t.areas?.water ?? [];
    let ms = 0, n = 0;
    for (const b of t.buildings || []) {
      if (!b.own) continue;
      const t0 = performance.now();
      let built;
      try {
        built = buildBuildings({ size, origin, buildings: [b], areas: { water } });
      } catch (e) {
        crashed++;
        roofs[`${key} ${b.id}`] = { crash: String(e.message || e).slice(0, 120), game: !t.ipr || !!b.noIpr };
        continue;
      }
      const took = performance.now() - t0;
      if (built.stats.flat && !built.stats.failed) continue; // flat by rule
      ms += took; n++;
      roofs[`${key} ${b.id}`] = { ...measure(b, built), n: b.rings.reduce((s, r) => s + r.length, 0), holes: b.rings.length - 1, ...(!t.ipr || b.noIpr ? { game: true } : {}) };
    }
    if (n) tiles[key] = { ms: Math.round(ms * 100) / 100, n };
  }
  fs.writeFileSync(out, JSON.stringify({ roofs, tiles }));
  const all = Object.values(roofs), ms = Object.values(tiles).reduce((s, t) => s + t.ms, 0);
  const worst = Object.entries(tiles).sort((a, b) => b[1].ms - a[1].ms)[0];
  console.log(`${all.length} roofs in ${Object.keys(tiles).length} tiles (${all.filter((r) => r.game).length} of them the game extrudes)`);
  console.log(`fell back to flat: ${all.filter((r) => r.flat).length}, crashed: ${crashed}, with a broken mesh: ${all.filter((r) => r.bad).length}`);
  console.log(`not covering the footprint exactly (plan off by over 1 %): ${all.filter((r) => !r.flat && !r.crash && Math.abs(r.plan - 1) > 0.01).length}`);
  console.log(`time: ${ms.toFixed(0)} ms in all, ${(ms / Object.keys(tiles).length).toFixed(2)} ms a tile, ${(ms / all.length).toFixed(3)} ms a roof; slowest tile ${worst[0]} ${worst[1].ms} ms (${worst[1].n} roofs)`);
}

// How two roofs of the same building differ.
export function verdict(a, b) {
  if (b.crash) return 'crash';
  if (a.flat && b.flat) return 'both flat';
  if (b.flat) return 'newly flat';
  if (a.flat) return 'newly a roof';
  const dTop = Math.abs(a.top - b.top), dArea = Math.abs(a.area - b.area) / (a.area || 1), dRidge = Math.abs(a.ridge - b.ridge);
  if (dTop <= 0.01 && dArea <= 0.001 && dRidge <= 0.02 + 0.001 * a.ridge) return a.verts === b.verts ? 'identical' : 'same shape, other triangles';
  if (dTop <= 0.1 && dArea <= 0.01 && dRidge <= Math.max(0.5, 0.05 * a.ridge)) return 'slightly different';
  return 'visibly different';
}

function diff(fa, fb) {
  const A = read(fa), B = read(fb);
  const list = rest.includes('--list') ? Number(rest[rest.indexOf('--list') + 1]) : 0;
  for (const [title, pick] of [['All roofs', () => true], ['The roofs the game extrudes', (r) => r.game]]) {
    const tally = {}, shown = [];
    let only = 0;
    for (const [k, a] of Object.entries(A.roofs)) {
      if (!pick(a)) continue;
      const b = B.roofs[k];
      if (!b) { only++; continue; }
      const v = verdict(a, b);
      tally[v] = (tally[v] || 0) + 1;
      if (!['identical', 'same shape, other triangles', 'both flat'].includes(v)) shown.push([k, v, a, b]);
    }
    const total = Object.values(tally).reduce((s, v) => s + v, 0);
    console.log(`\n${title}: ${total}` + (only ? ` (${only} missing from the second file)` : ''));
    for (const [v, c] of Object.entries(tally).sort((x, y) => y[1] - x[1])) console.log(`  ${v.padEnd(28)} ${String(c).padStart(6)}  ${(100 * c / total).toFixed(2)} %`);
    if (list && title === 'All roofs') {
      for (const [k, v, a, b] of shown.slice(0, list)) console.log(`  ${v}: ${k}\n    ${JSON.stringify(a)}\n    ${JSON.stringify(b)}`);
    }
  }
  const off = (R) => Object.values(R.roofs).filter((r) => !r.flat && !r.crash && Math.abs(r.plan - 1) > 0.01).length;
  console.log(`\nRoofs not covering their footprint exactly: ${off(A)} before, ${off(B)} after`);
  const sum = (R) => Object.values(R.tiles).reduce((s, t) => s + t.ms, 0), n = Object.keys(A.tiles).length;
  const worst = (R) => Math.max(...Object.values(R.tiles).map((t) => t.ms));
  console.log(`Time per tile: ${(sum(A) / n).toFixed(2)} ms before, ${(sum(B) / Object.keys(B.tiles).length).toFixed(2)} ms after; slowest tile ${worst(A)} ms before, ${worst(B)} ms after`);
}

if (mode === 'record' && rest[0]) await record(rest[0]);
else if (mode === 'diff' && rest[1]) diff(rest[0], rest[1]);
else if (mode) { console.error('usage: roof-compare.mjs record out.json | diff a.json b.json [--list n]'); process.exit(1); }
