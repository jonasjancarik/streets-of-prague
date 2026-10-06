#!/usr/bin/env node
// The river as the boats sail it, checked from the map data without a browser:
//   node scripts/check-river.mjs [area]        (praha by default)
// Every point of the fairway and of the ferries' crossings (river.json) must be on open
// water as the game sees it; under every bridge deck over them there must be room for
// the boat; and the water's height along the fairway must not step.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createServer } from 'vite';

const area = process.argv[2] || 'praha', dir = `public/data/${area}_now`;
const FASCIA = 1.2; // the deck's edge below its surface (src/ground.ts)
// Decks the map has too low for a cruise boat, by tile: bridge heights to be put right in
// the pipeline (pipeline/structures.py), reported here and not a failure until then. A
// deck that has since been raised is reported too, so the list gets shorter.
const KNOWN_LOW = { praha: ['49_37', '52_43', '54_48', '64_76'] };
const STEP = 0.3; // m: a jump in the water's height over 2 m of fairway that counts as a seam
globalThis.location = { search: '' };
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { parseRiver, openWater, Course } = await server.ssrLoadModule('/src/river.ts');
  const { decodeHeights, decodeLevels, pointLabels, heightSampler } = await server.ssrLoadModule('/src/terrain.ts');
  const { onPolygons } = await server.ssrLoadModule('/src/map/geo.ts');
  const { BOAT_TOP } = await server.ssrLoadModule('/src/boats.ts');
  const index = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
  const river = parseRiver(JSON.parse(readFileSync(`${dir}/river.json`, 'utf8')));
  const [ox, oy] = index.origin, size = index.tile, ref = index.iprRef ?? 180, { n, step } = index.terrain;
  const bin = (k, kind) => { const p = `${dir}/tiles/${k}.${kind}.bin${index.gzip ? '.gz' : ''}`; if (!existsSync(p)) return null; const b = readFileSync(p); const u = index.gzip ? gunzipSync(b) : b; return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
  const tiles = new Map();
  const tileAt = (x, y) => {
    const k = `${Math.floor((x + ox) / size)}_${Math.floor((y + oy) / size)}`;
    if (!tiles.has(k)) {
      let tile = null;
      if (existsSync(`${dir}/tiles/${k}.json`)) {
        const t = JSON.parse(readFileSync(`${dir}/tiles/${k}.json`, 'utf8')), h = bin(k, 'height'), lv = (t.structures || []).length ? bin(k, 'levels') : null;
        const water = (t.areas.water || []).map((rings) => {
          const xs = rings[0].map((p) => p[0]), ys = rings[0].map((p) => p[1]);
          return { rings, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
        });
        const hm = h ? decodeHeights(h, n, ref) : null;
        const levels = lv ? decodeLevels(lv, n, t.structures.length, ref) : [];
        tile = {
          k, water, weirs: t.weirs || [],
          level: hm ? heightSampler(hm, t.box, n, step, pointLabels(h, n)) : null,
          decks: (t.structures || []).map((s, i) => ({ s, on: onPolygons(s.polys), sample: levels[i] ? heightSampler(levels[i], t.box, n, step) : null })).filter((d) => d.s.kind === 'bridge' && d.sample),
        };
      }
      tiles.set(k, tile);
    }
    return tiles.get(k);
  };
  let dry = 0, points = 0, lowest = Infinity;
  const tight = [], seams = [], cleared = new Set(), known = KNOWN_LOW[area] ?? [];
  const lockNear = (x, y) => river.locks.some((l) => new Course(l).project(x, y).d < 40);
  const sail = (name, pts, top, widths) => {
    const c = new Course(pts);
    let before = null;
    for (let s = 0; s <= c.length; s += 2) {
      const p = c.at(s), t = tileAt(p.x, p.y);
      points++;
      if (!t || !openWater(t, p.x, p.y)) { dry++; if (dry <= 8) console.log(`  not on open water: ${name} at ${s.toFixed(0)} m (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`); before = null; continue; }
      const z = t.level ? t.level(p.x, p.y, true) : NaN;
      for (const d of t.decks) {
        if (!d.on(p.x, p.y)) continue;
        const room = d.sample(p.x, p.y) - FASCIA - z - top;
        if (Number.isNaN(room)) continue;
        lowest = Math.min(lowest, room);
        if (room >= 0) cleared.add(t.k);
        if (room < 0.5 && !tight.some((q) => q.k === t.k && q.name === name)) tight.push({ name, k: t.k, s: Math.round(s), room: +room.toFixed(2), deck: +d.sample(p.x, p.y).toFixed(2), water: +z.toFixed(2) });
      }
      if (widths && before !== null && Math.abs(z - before.z) > STEP) seams.push({ lock: lockNear(p.x, p.y), name, s: Math.round(s), from: +before.z.toFixed(2), to: +z.toFixed(2), tile: t.k, edge: before.k !== t.k });
      before = { z, k: t.k };
    }
  };
  river.fairway.forEach((r, i) => sail(`fairway ${i + 1}`, r.pts, BOAT_TOP.cruise, true));
  for (const f of river.ferries) f.legs.forEach((leg, i) => sail(`${f.ref} leg ${i + 1}`, leg, BOAT_TOP.ferry, false));
  console.log(`${area}: ${river.fairway.length} stretches of fairway, ${river.ferries.length} ferries, ${points} points sailed`);
  console.log(`  lowest room under a deck: ${lowest === Infinity ? 'no deck over the fairway' : `${lowest.toFixed(2)} m`}`);
  for (const q of tight) console.log(`  low bridge${q.room < 0 && known.includes(q.k) ? ' (known, a bridge height in the map)' : ''}: ${q.name} at ${q.s} m, tile ${q.k}: deck ${q.deck}, water ${q.water}, room ${q.room} m`);
  for (const k of known) if (!tight.some((q) => q.k === k && q.room < 0)) console.log(`  tile ${k} is no longer too low${cleared.has(k) ? '' : ' (no deck over the fairway there now)'}: take it off KNOWN_LOW`);
  const atLocks = seams.filter((q) => q.lock).length;
  if (atLocks) console.log(`  ${atLocks} steps in the water's height are at locks, where a boat rises or sinks slowly`);
  seams.splice(0, seams.length, ...seams.filter((q) => !q.lock));
  for (const q of seams.slice(0, process.argv.includes("--all") ? Infinity : 40)) console.log(`  water steps ${q.from} -> ${q.to} m: ${q.name} at ${q.s} m, tile ${q.tile}${q.edge ? ' (at a tile edge)' : ''}`);
  if (seams.length > 40 && !process.argv.includes("--all")) console.log(`  … and ${seams.length - 40} more steps`);
  assert.equal(dry, 0, `${dry} points of the fairway or a crossing are not on open water`);
  assert.equal(tight.filter((q) => q.room < 0 && !known.includes(q.k)).length, 0, 'a boat does not fit under a bridge deck');
  if (process.argv.includes('--strict')) assert.equal(seams.length, 0, `${seams.length} steps in the water's height along the fairway`);
  const low = tight.filter((q) => q.room < 0).length;
  console.log(`River: on open water and ${low ? `clear of every deck but ${low} known low ones` : 'clear of every deck'}${seams.length ? `; ${seams.length} steps in the water's height (see above)` : ', no steps in the water'}.`);
} finally {
  await server.close();
}
