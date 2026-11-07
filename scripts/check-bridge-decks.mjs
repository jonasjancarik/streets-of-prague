#!/usr/bin/env node
// Do the bridges' decks run on without breaks, and do they meet their streets? Reads a
// built map's tiles as the game reads them (src/terrain.ts), with no browser: every
// street and path on a bridge is walked a metre at a time on its own level, and at each
// end its height is compared with what it runs on into (the ground, or the next bridge).
//
//   node scripts/check-bridge-decks.mjs [area, praha] [--data public/data] [--worst 25]
//        [--save now.json] [--against before.json] [--profile <edge id or part of a name>]
//        [--max-break 1.0] [--max-join 1.0] [--named-only] [--near lat,lon[,metres]]
//        [--roadsurfaces file] [--bridgesurfaces file] [--strict-regressions (requires --against)]
//
// A "break" is the largest jump between two samples a metre apart along a deck (the
// change that the slope either side doesn't account for; ways tagged as steps are left
// out); a "join" the difference at an end between the deck and what it runs on into:
// the next bridge, the street on the ground, or the ground where the deck's outline
// stops short of the end. The bridges in
// .agents/skills/terrain-steps/bridges.json are listed by name, and the script fails when
// one of those has a break over --max-break or a join over --max-join.
// --near: only the tiles round a place (600 m either way unless given), which takes seconds.
// Maps built before the pipeline wrote each street's level have no `level` on their
// edges: there the deck walked is the bridge level nearest in height to the last sample.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { decodeHeights, decodeLevels, pointLabels, heightSampler, terraceAt, flatTerraces, withRamps } from '../src/terrain.ts';
import { onPolygons } from '../src/map/geo.ts';
import { readRoadSurfaces, withRoadSurfaces } from '../src/roadSurfaces.ts';
import { bridgeSurfaceBuffers, bridgeSurfaceTile, readBridgeSurfacePreview } from '../src/bridgeSurfacePreview.ts';
import { bridgeRegressions } from './bridge-regressions.mjs';

const args = {}, pos = [];
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
if (args['strict-regressions'] && !args.against) throw new Error('--strict-regressions requires --against');
const root = new URL('..', import.meta.url).pathname;
const area = pos[0] || 'praha', dir = join(args.data || join(root, 'public/data'), `${area}_now`);
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const trial = args.roadsurfaces ? readFileSync(args.roadsurfaces, 'utf8') : null;
const surfaces = trial && readRoadSurfaces(JSON.parse(trial), index.area, index.built);
if (args.roadsurfaces && !surfaces) throw new Error('Road surfaces do not match the map build');
const bridgeTrial = args.bridgesurfaces ? readFileSync(args.bridgesurfaces, 'utf8') : null;
const preview = bridgeTrial ? readBridgeSurfacePreview(JSON.parse(bridgeTrial), index.area, index.built) : null;
if (args.bridgesurfaces && !preview) throw new Error('Bridge surfaces do not match the map build');
const { tile: T, origin: [ox, oy], terrain } = index;
const REF = 100; // heights here are metres above 100 m a.s.l.
const STEP = 1, BREAK = Number(args['max-break'] ?? 1.0), JOIN = Number(args['max-join'] ?? 1.0);

const binary = (name) => {
  const gz = join(dir, 'tiles', `${name}.gz`), plain = join(dir, 'tiles', name);
  if (!existsSync(gz) && !existsSync(plain)) return null;
  const raw = readFileSync(existsSync(gz) ? gz : plain);
  const out = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
};
const tiles = new Map();
function tileOf(i, j) {
  const k = `${i}_${j}`;
  if (tiles.has(k)) return tiles.get(k);
  let out = null;
  const path = join(dir, 'tiles', `${k}.json`);
  if (existsSync(path)) {
    const t = bridgeSurfaceTile(JSON.parse(readFileSync(path, 'utf8')), k, preview);
    const structures = t.structures || [];
    const { height, levels } = bridgeSurfaceBuffers(t, k, terrain.n, binary(`${k}.height.bin`),
      structures.length ? binary(`${k}.levels.bin`) : null, preview);
    const heights = levels ? decodeLevels(levels, terrain.n, structures.length, REF) : [];
    const side = terraceAt(t.terraces);
    const base = height ? heightSampler(decodeHeights(height, terrain.n, REF, terrain.unit), t.box, terrain.n, terrain.step,
      pointLabels(height, terrain.n), side, flatTerraces(t.terraces, REF)) : () => NaN;
    const road = surfaces ? surfaces.get(k) : undefined, lower = preview?.ground.get(k);
    const fits = lower ? [...lower, ...(road ?? [])] : road;
    const patches = height && !structures.some(s => s.kind === 'tunnel') ? fits : undefined;
    out = {
      t, ground: withRoadSurfaces(base, patches, REF, side),
      levels: structures.map((s, n) => ({ level: s.level, kind: s.kind, on: onPolygons(s.polys), sample: withRamps(heightSampler(heights[n], t.box, terrain.n, terrain.step), s.ramps, REF) })),
    };
  }
  tiles.set(k, out);
  if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
  return out;
}
const at = (x, y) => tileOf(Math.floor((x + ox) / T), Math.floor((y + oy) / T));
const groundAt = (x, y) => at(x, y)?.ground(x, y) ?? NaN;
// The height of a level at a point (as World.levelAt), NaN off it.
function levelAt(x, y, level) {
  for (const [dx, dy] of NEAR) {
    const t = at(x + dx, y + dy);
    for (const l of t?.levels ?? []) {
      if (l.level !== level || !l.on(x + dx, y + dy)) continue;
      const h = l.sample(x + dx, y + dy);
      return Number.isNaN(h) ? t.ground(x, y) : h;
    }
  }
  return NaN;
}
// (Where two ways meet at an angle their outlines touch at the node alone, and the game's
// level masks have cells of half a metre: a point counts as on a level within 0.4 m of it.)
const NEAR = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]];
const bridgesAt = (x, y) => [...new Set(NEAR.flatMap(([dx, dy]) => (at(x + dx, y + dy)?.levels ?? []).filter((l) => l.level > 0 && l.on(x + dx, y + dy)).map((l) => l.level)))];

// (The area's transverse Mercator, well enough for naming a place to look at.)
const [bw, bs, be, bn] = index.bbox_wgs84, lat0 = (bs + bn) / 2, lon0 = (bw + be) / 2, rad = Math.PI / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * rad), mLon = (lat) => 111412.84 * Math.cos(lat * rad) - 93.5 * Math.cos(3 * lat * rad);
const toWgs = (x, y) => { const lat = lat0 + y / mLat; return [lat.toFixed(5), (lon0 + x / mLon(lat)).toFixed(5)]; };
const near = args.near ? String(args.near).split(',').map(Number) : null;
const centre = near ? [(near[1] - lon0) * mLon(near[0]), (near[0] - lat0) * mLat, near[2] || 600] : null;

// Every edge once, and which edges meet at each node.
const edges = new Map();
for (const [i, j] of index.tiles) {
  if (centre && (Math.abs((i + 0.5) * T - ox - centre[0]) > centre[2] + T || Math.abs((j + 0.5) * T - oy - centre[1]) > centre[2] + T)) continue;
  const path = join(dir, 'tiles', `${i}_${j}.json`);
  if (!existsSync(path)) continue;
  const t = bridgeSurfaceTile(JSON.parse(readFileSync(path, 'utf8')), `${i}_${j}`, preview);
  for (const [net, list] of [['drive', t.drive || []], ['walk', t.walk || []]]) {
    for (const e of list) {
      const key = `${net}:${e.id}`, had = edges.get(key);
      // (An edge is listed by every tile it crosses, whole or clipped: the longest.)
      if (!had || had.pts.length < e.pts.length) edges.set(key, { ...e, net });
    }
  }
}
const atNode = new Map();
for (const e of edges.values()) for (const n of [e.u, e.v]) atNode.set(n, [...(atNode.get(n) || []), e]);
const leveled = [...edges.values()].some((e) => e.level !== undefined);

function walk(e) {
  const pts = [];
  for (let i = 0; i < e.pts.length - 1; i++) {
    const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1], n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STEP));
    for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
  }
  pts.push(e.pts[e.pts.length - 1]);
  let level = e.level, was = NaN, s = 0, last = null;
  const prof = [];
  for (const [x, y] of pts) {
    let h = NaN;
    if (last) s += Math.hypot(x - last[0], y - last[1]);
    last = [x, y];
    // (Its level here: an edge of several ways can change level along itself.)
    const own = e.levels ? e.levels.reduce((lv, [from, l]) => (from <= s ? l : lv), e.levels[0][1]) : e.level;
    if (own !== undefined) h = levelAt(x, y, own);
    // (An edge can run on from its deck onto another level: stairs down from a bridge,
    // mapped as bridge ways, are one edge with the footway they leave.)
    if (Number.isNaN(h) && own !== 0) {
      // The level nearest in height to the last sample (to the ground, at the start).
      const ref = Number.isNaN(was) ? groundAt(x, y) : was;
      for (const l of bridgesAt(x, y)) {
        const v = levelAt(x, y, l);
        if (!Number.isNaN(v) && (Number.isNaN(h) || Math.abs(v - ref) < Math.abs(h - ref))) { h = v; level = l; }
      }
    }
    const deck = !Number.isNaN(h);
    if (!deck) h = groundAt(x, y);
    prof.push([x, y, h, deck]);
    if (!Number.isNaN(h)) was = h;
  }
  return prof;
}
// What an edge is at one of its ends: its height a metre in from there. (Right at the
// node a point lies on the very edge of the deck's outline, or of the flat terrace under
// the street's last metres, and reads as whatever is beside it.)
const inFrom = (pts, d) => {
  const [a, b] = pts, len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, k = Math.min(0.5, d / len);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
};
const endHeight = (e, node, profs) => {
  const p = profs.get(e), first = e.u === node;
  if (p) return p[first ? Math.min(1, p.length - 1) : Math.max(0, p.length - 2)][2];
  if (e.bridge) return NaN;
  return groundAt(...inFrom(first ? e.pts : e.pts.slice(-2).reverse(), 1));
};

const profs = new Map();
for (const e of edges.values()) if (e.bridge) profs.set(e, walk(e));
const rows = [];
const bridgeEnds = (node, net) => (atNode.get(node) || []).filter((o) => o.net === net && o.bridge && profs.has(o)).length;
for (const [e, prof] of profs) {
  // Along the deck; and where deck and ground hand over within the edge (the level's
  // outline stops short of the end, or has a gap).
  let worst = 0, where = 0, onDeck = 0, hand = 0, handAt = 0;
  for (let i = 1; i < prof.length; i++) {
    if (prof[i][3]) onDeck++;
    const d = prof[i][2] - prof[i - 1][2];
    // (Not the samples right at the nodes: they lie on the very edge of the level's outline.)
    if (prof[i][3] && prof[i - 1][3]) {
      // A jump, not a slope: what the change either side of it doesn't account for
      // (stairs fall half a metre a metre, evenly).
      const beside = Math.max(i > 1 ? Math.abs(prof[i - 1][2] - prof[i - 2][2]) : 0, i < prof.length - 1 ? Math.abs(prof[i + 1][2] - prof[i][2]) : 0);
      const jump = Math.abs(d) - Math.min(Math.abs(d), beside);
      if (i > 1 && i < prof.length - 1 && jump > worst) { worst = jump; where = i; }
    } else if (prof[i][3] !== prof[i - 1][3] && i > 1 && i < prof.length - 1 && Math.abs(d) > Math.abs(hand)) { hand = d; handAt = i; }
  }
  if (!onDeck) continue; // (a way the pipeline left on the ground)
  const length = prof.length - 1;
  // At each end: the other bridges it runs on into, where there are any (stairs down
  // from the middle of a bridge leave it at the deck's height, whatever the ground is);
  // at the bridge's own end, the streets on the ground.
  const joins = [0, 1].map((end) => {
    if (e.levels?.[end ? e.levels.length-1 : 0]?.[1] === 0) return 0;
    const node = end ? e.v : e.u, mine = endHeight(e, node, profs), among = bridgeEnds(node, e.net) > 1;
    let far = 0;
    for (const o of atNode.get(node) || []) {
      if (o === e || o.net !== e.net || o.hw === 'steps' || o.tunnel || (among && !profs.has(o))) continue;
      const d = endHeight(o, node, profs) - mine;
      if (Math.abs(d) > Math.abs(far)) far = d;
    }
    return +far.toFixed(2);
  });
  const end = handAt > length / 2 ? 1 : 0;
  if (Math.abs(hand) > Math.abs(joins[end])) joins[end] = +hand.toFixed(2);
  rows.push({ id: `${e.net}:${e.id}`, name: e.name || '', hw: e.hw, level: e.level, length, break: +worst.toFixed(2), breakAt: where,
    breakPlace: toWgs(prof[where][0], prof[where][1]), joins, ends: [toWgs(prof[0][0], prof[0][1]), toWgs(prof[length][0], prof[length][1])],
    mid: [prof[length >> 1][0], prof[length >> 1][1]] });
}

// The named bridges: every edge within 30 m of the bridge's way that runs along it.
const NAMED = JSON.parse(readFileSync(join(root, '.agents/skills/terrain-steps/bridges.json'), 'utf8'));
const nearLine = (p, pts) => {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
    const k = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - ax - dx * k, p[1] - ay - dy * k));
  }
  return best;
};
const real = (r) => r.hw !== 'steps';
const summary = [];
for (const b of area === 'praha' ? NAMED : []) {
  const on = rows.filter((r) => nearLine(r.mid, b.pts) < 30);
  if (!on.length) continue;
  const worstBreak = on.filter(real).reduce((m, r) => (r.break > (m?.break ?? -1) ? r : m), null);
  const worstJoin = on.reduce((m, r) => (Math.max(...r.joins.map(Math.abs)) > (m ? Math.max(...m.joins.map(Math.abs)) : -1) ? r : m), null);
  summary.push({ name: b.name, edges: on.length, break: worstBreak?.break ?? 0, breakAt: worstBreak?.breakPlace, join: Math.max(...worstJoin.joins.map(Math.abs)),
    joinAt: worstJoin.ends[Math.abs(worstJoin.joins[0]) >= Math.abs(worstJoin.joins[1]) ? 0 : 1] });
}

// Each named bridge's own way too (as bridges.mjs walks it in the game), from 24 m before
// to 24 m past it straight on: catches a way the street network doesn't call a bridge.
const out = (a, c, d) => { const l = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [c[0] + (c[0] - a[0]) / l * d, c[1] + (c[1] - a[1]) / l * d]; };
for (const b of area === 'praha' ? NAMED : []) {
  if (centre && Math.hypot(b.pts[0][0] - centre[0], b.pts[0][1] - centre[1]) > centre[2]) continue;
  const pts = [out(b.pts[1], b.pts[0], 24), ...b.pts, out(b.pts[b.pts.length - 2], b.pts[b.pts.length - 1], 24)];
  const prof = walk({ pts });
  let worst = 0, where = 0;
  const hands = [];
  for (let i = 1; i < prof.length; i++) {
    const d = prof[i][2] - prof[i - 1][2];
    if (prof[i][3] && prof[i - 1][3]) { if (Math.abs(d) > worst) { worst = Math.abs(d); where = i; } }
    else if (prof[i][3] !== prof[i - 1][3]) hands.push([i - 24, +d.toFixed(2)]);
  }
  let s = summary.find((r) => r.name === b.name);
  if (!s) summary.push(s = { name: b.name, edges: 0, break: 0, join: 0 });
  s.way = { break: +worst.toFixed(2), breakAt: where - 24, hands };
  if (args.profile && b.name.includes(args.profile)) s.wayProfile = prof.map((p) => (p[2] + REF).toFixed(1) + (p[3] ? '' : 'g')).join(' ');
}

const before = args.against ? JSON.parse(readFileSync(args.against, 'utf8')) : null;
const was = (list, key, name, field) => { const o = list?.find((r) => r[key] === name); return o ? `${o[field]} → ` : ''; };
console.log(`${area}: built ${index.built}, ${rows.length} streets and paths on bridges${leveled ? '' : ' (no levels on the edges: decks guessed by height)'}`);
if (summary.length) {
  console.log('\nNamed bridges (worst break along a deck, worst join at an end, in metres):');
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(27)} break ${was(before?.summary, 'name', s.name, 'break')}${s.break}${s.break > BREAK ? ` at ${s.breakAt}` : ''}`
      + `   join ${was(before?.summary, 'name', s.name, 'join')}${s.join}${s.join > JOIN ? ` at ${s.joinAt}` : ''}`
      + (s.way ? `   its way: break ${s.way.break}${s.way.break > 0.5 ? ` (at ${s.way.breakAt} m)` : ''}, deck/ground ${JSON.stringify(s.way.hands)}` : ''));
    if (s.wayProfile) console.log(`     ${s.wayProfile}`);
  }
}
if (!args['named-only']) {
  const N = Number(args.worst || 25);
  const count = (f) => rows.filter(f).length;
  console.log(`\nAll bridges: ${count((r) => real(r) && r.break > 0.5)} with a break over 0.5 m, ${count((r) => real(r) && r.break > 1)} over 1 m; `
    + `${count((r) => Math.max(...r.joins.map(Math.abs)) > 0.5)} with a join over 0.5 m, ${count((r) => Math.max(...r.joins.map(Math.abs)) > 1)} over 1 m`
    + (before ? ` (before: ${before.rows.filter((r) => real(r) && r.break > 0.5).length}, ${before.rows.filter((r) => real(r) && r.break > 1).length}; `
      + `${before.rows.filter((r) => Math.max(...r.joins.map(Math.abs)) > 0.5).length}, ${before.rows.filter((r) => Math.max(...r.joins.map(Math.abs)) > 1).length})` : ''));
  console.log(`\nWorst breaks along a deck:`);
  for (const r of rows.filter(real).sort((a, b) => b.break - a.break).slice(0, N)) {
    console.log(`  ${String(r.break).padStart(6)} m  ${r.breakPlace.join(', ')}  ${r.hw} ${r.name} (${r.id}, ${r.length} m, at ${r.breakAt} m${r.level !== undefined ? `, level ${r.level}` : ''})`);
  }
  console.log(`\nWorst joins at an end:`);
  const j = (r) => Math.max(...r.joins.map(Math.abs));
  for (const r of rows.slice().sort((a, b) => j(b) - j(a)).slice(0, N)) {
    const end = Math.abs(r.joins[0]) >= Math.abs(r.joins[1]) ? 0 : 1;
    console.log(`  ${String(r.joins[end]).padStart(6)} m  ${r.ends[end].join(', ')}  ${r.hw} ${r.name} (${r.id}, ${r.length} m)`);
  }
}
if (args.profile) {
  for (const [e, prof] of profs) {
    if (!`${e.net}:${e.id} ${e.name || ''}`.includes(args.profile)) continue;
    console.log(`\n${e.net}:${e.id} ${e.hw} ${e.name || ''} (every ${STEP} m; g = on the ground)`);
    console.log('  ' + prof.map((p) => (p[2] + REF).toFixed(1) + (p[3] ? '' : 'g')).join(' '));
    for (const node of [e.u, e.v]) {
      console.log(`  at node ${node}: ${(atNode.get(node) || []).filter((o) => o.net === e.net).map((o) => `${o.id} ${o.hw}${o.bridge ? ' bridge' : ''}${o.tunnel ? ' tunnel' : ''}${o.level !== undefined ? ` L${o.level}` : ''} ${(endHeight(o, node, profs) + REF).toFixed(1)}`).join('; ')}`);
    }
  }
}
const result = { built: index.built, summary, rows,
  ...(bridgeTrial ? { bridgeDigest: createHash('sha256').update(bridgeTrial).digest('hex') } : {}),
  ...(trial ? { patchDigest: createHash('sha256').update(trial).digest('hex') } : {}) };
if (args.save) writeFileSync(args.save, JSON.stringify(result));
const bad = summary.filter((s) => s.break > BREAK || s.join > JOIN);
if (args['strict-regressions']) {
  const regressions = bridgeRegressions(before, result);
  console.log(`Bridge regressions: ${JSON.stringify(regressions)}`);
  if (regressions.length) process.exitCode = 1;
} else if (bad.length) {
  console.error(`\n${bad.length} named bridge(s) over the limits (break ${BREAK} m, join ${JOIN} m): ${bad.map((s) => s.name).join(', ')}`);
  process.exit(1);
}
