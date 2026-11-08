#!/usr/bin/env node
// Do the car streets lie as streets do? Reads a built map's tiles as the game reads them
// (src/terrain.ts), with no browser, and walks every street of the car network a metre at
// a time, along its middle and along both its edges, on its own level (a bridge's deck, a
// tunnel's floor) or on the ground. A street may climb, and lean a little towards its
// gutters, but has no steps, doesn't lean hard across, doesn't twist and doesn't run over
// grass.
//
//   node scripts/check-road-flatness.mjs [area, praha] [--data public/data] [--worst 25]
//        [--near lat,lon[,metres]] [--save now.json] [--against before.json]
//        [--roadprofiles | --roadsurfaces file] [--bridgesurfaces file] [--profile <edge id or part of a name>] [--strict]
//        [--across 1 | 0] [--scan <LiDAR directory> | off] [--places scripts/road-places.json | off]
//
// Per street, the worst of:
// - step: a jump between two samples a metre apart that the slope either side doesn't
//   account for (as check-bridge-decks.mjs), along the middle or either edge;
// - lean: the height across, edge to edge, over the width (real streets: 2-3 %, a banked
//   bend 6-8 %);
// - bump: the middle above or below the straight line BUMP metres either side of it
//   (a washboard the step test lets through: no one jump is big);
// - crown: the middle above or below the line between the edges (a ridge or a trough);
// - twist: how much the lean changes over TWIST metres along the street;
// - off the road: the longest stretch of a street on the ground whose middle isn't on a
//   carriageway's surface (grass or a verge drawn over the road);
// - waves: along lines a metre apart (--across) from edge to edge, each line's height
//   against the straight line WAVES metres either side of it. A street may climb and
//   lean, but each line along it is smooth: 2 m catches a step or a rut, 5 m a hump a car
//   bounces over, 12 m a dip or a crest it would take too fast;
// - off the scan: the map's height against IPR's 2023 LiDAR ground (pipeline/scan_heights.py)
//   on the same lines, for streets on the ground and not under a bridge: the worst, the
//   share of samples over SCAN_NEAR and the metres over SCAN_FAR.
// Steps, lean and the rest count only where the samples are on the carriageway as drawn
// (OSM's width can reach past the kerb, onto a wall beside the street).
// The places in scripts/road-places.json (broken streets players or checks found) get the
// worst of each measure within their radius, by name.
// The samples within END metres (or the street's width) of its ends are left out: at a
// junction the edges lie across other streets. The lean is the middle value over LEAN metres. --strict fails when anything is over the hard limits (LIMIT).
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { decodeHeights, decodeLevels, pointLabels, heightSampler, terraceAt, flatTerraces, withRamps, stepLineIndex, lineReach, sampling } from '../src/terrain.ts';
import { readRoadProfile, withRoadProfile } from '../src/roadProfiles.ts';
import { readRoadSurfaces, withRoadSurfaces } from '../src/roadSurfaces.ts';
import { bridgeSurfaceBuffers, bridgeSurfaceTile, readBridgeSurfacePreview } from '../src/bridgeSurfacePreview.ts';
import { onPolygons } from '../src/map/geo.ts';

const args = {}, pos = [];
const rest = process.argv.slice(2);
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
if (args.lines === 'off') sampling.lines = false; // the steps' lattice ramps, without the tile's step lines
const root = new URL('..', import.meta.url).pathname;
const area = pos[0] || 'praha', dir = join(args.data || join(root, 'public/data'), `${area}_now`);
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
const { tile: T, origin: [ox, oy], terrain } = index;
const pilot = args.roadprofiles
  ? readRoadProfile(JSON.parse(readFileSync(join(dir, 'road-profile.json'), 'utf8')), index.area, index.built) : null;
if (args.roadprofiles && !pilot) throw new Error('No road profile for this map build');
if (args.roadsurfaces === true) throw new Error('--roadsurfaces requires a filename');
const trial = args.roadsurfaces ? readFileSync(args.roadsurfaces, 'utf8') : undefined;
let surfaces = trial !== undefined ? readRoadSurfaces(JSON.parse(trial), index.area, index.built) : null;
if (args.roadsurfaces && (!surfaces || pilot)) throw new Error('Choose one matching road surface file');
const bridgeTrial = args.bridgesurfaces ? readFileSync(args.bridgesurfaces, 'utf8') : null;
const preview = bridgeTrial ? readBridgeSurfacePreview(JSON.parse(bridgeTrial), index.area, index.built) : null;
if (args.bridgesurfaces && !preview) throw new Error('Bridge surfaces do not match the map build');
if (preview) {
  surfaces = new Map(surfaces);
  for (const [key, fits] of preview.ground) surfaces.set(key, [...fits, ...(surfaces.get(key) ?? [])]);
}
const REF = 100; // heights here are metres above 100 m a.s.l.
const STEP = 1;     // m between samples
const END = 4;      // m at each end left out, or the street's width if more (a junction)
const INSET = 0.75; // m in from each edge (the kerb itself is the pavement's)
const TWIST = 4;    // m over which the lean's change is measured
const BUMP = 3;     // m either side of a point its bump is measured against
const LEAN = 5;     // m (odd) over which the lean is taken
const OFF_MIN = 4;  // m: shorter stretches off the road are crossings and junctions
const ACROSS = args.across !== undefined ? Number(args.across) : 1; // m between the lines along a street (0: the middle and the edges)
const WAVES = [2, 5, 12]; // m either side of a point its wave is measured against
const SCAN_EVERY = 2;     // m between the samples compared with the LiDAR, on every line
const SCAN_NEAR = 0.3, SCAN_FAR = 1; // m off the LiDAR
const UNDER = 2;    // m: a level this far over the street is a bridge, which the LiDAR doesn't see under
// What counts as a finding, and (--strict) what fails.
const FLAG = { step: 0.25, bump: 0.15, lean: 8, crown: 0.3, twist: 5, off: OFF_MIN, wave2: 0.1, wave5: 0.2, wave12: 0.5, scan: SCAN_NEAR };
const LIMIT = { step: 1, bump: 0.5, lean: 15, crown: 1, twist: 12, off: 10, wave2: 0.3, wave5: 0.6, wave12: 1.5, scan: 2 };
// The streets a car is meant to drive on: these are checked off the road too (a service
// way or a track may well cross a yard or grass).
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'living_street']);

const binary = (name) => {
  const gz = join(dir, 'tiles', `${name}.gz`), plain = join(dir, 'tiles', name);
  if (!existsSync(gz) && !existsSync(plain)) return null;
  const raw = readFileSync(existsSync(gz) ? gz : plain);
  const out = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
};
// Whether a point is on any of these polygons (with holes), as a mask of half-metre cells
// over the tile's box: the same answer as onPolygons a quarter of a metre from an outline,
// and the test is a lookup instead of a walk round thousands of vertices.
const RES = 2; // cells a metre
function onMask(groups, [bx0, by0, bx1, by1]) {
  const w = Math.ceil((bx1 - bx0) * RES), h = Math.ceil((by1 - by0) * RES), cells = new Uint8Array(w * h);
  for (const polys of groups) for (const rings of polys) {
    // (Each polygon on its own, even-odd over its rings: overlapping polygons stay covered.)
    const rows = new Map();
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi === yj) continue;
        const lo = Math.max(0, Math.ceil((Math.min(yi, yj) - by0) * RES - 0.5)), hi = Math.min(h - 1, Math.ceil((Math.max(yi, yj) - by0) * RES - 0.5) - 1);
        for (let r = lo; r <= hi; r++) {
          const y = by0 + (r + 0.5) / RES, x = xi + (xj - xi) * (y - yi) / (yj - yi);
          (rows.get(r) ?? rows.set(r, []).get(r)).push(x);
        }
      }
    }
    for (const [r, xs] of rows) {
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - bx0) * RES - 0.5)), c1 = Math.min(w - 1, Math.ceil((xs[k + 1] - bx0) * RES - 0.5) - 1);
        cells.fill(1, r * w + c0, c1 >= c0 ? r * w + c1 + 1 : r * w + c0);
      }
    }
  }
  return (x, y) => {
    const c = Math.floor((x - bx0) * RES), r = Math.floor((y - by0) * RES);
    return c >= 0 && r >= 0 && c < w && r < h ? cells[r * w + c] === 1 : false;
  };
}

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
    const roads = t.roads || {}, side = terraceAt(t.terraces);
    const base = height ? heightSampler(decodeHeights(height, terrain.n, REF, terrain.unit), t.box, terrain.n, terrain.step,
      pointLabels(height, terrain.n), side, flatTerraces(t.terraces, REF), stepLineIndex(t.stepLines, REF, lineReach(terrain.step), terrain.unit)) : () => NaN;
    out = {
      side: side || (() => 0),
      base,
      ground: withRoadSurfaces(withRoadProfile(base, height && pilot?.tiles.includes(k) ? pilot.profile : undefined, REF),
        height ? surfaces?.get(k) : undefined, REF, side),
      levels: structures.map((s, n) => ({ level: s.level, on: args.exact ? onPolygons(s.polys) : onMask([s.polys], t.box), sample: withRamps(heightSampler(heights[n], t.box, terrain.n, terrain.step), s.ramps, REF) })),
    };
    // (The carriageways, and outside the survey the asphalt the photos show.)
    const road = [...['road', 'sett', 'bridge', 'trambed'].map((k) => roads[k]), ...['cover_asphalt', 'parking'].map((k) => t.areas?.[k])].filter((p) => p?.length);
    // (A living street may be paved like a pavement.)
    const paved = ['pavement', 'pavement_asphalt'].map((k) => roads[k]).filter((p) => p?.length);
    // (--exact: the polygons themselves, as before November 2026, to compare.)
    out.hasRoad = road.length > 0;
    out.road = args.exact ? ((ons) => (x, y) => ons.some((on) => on(x, y)))(road.map((p) => onPolygons(p))) : onMask(road, t.box);
    out.paved = args.exact ? ((ons) => (x, y) => ons.some((on) => on(x, y)))(paved.map((p) => onPolygons(p))) : onMask(paved, t.box);
  }
  tiles.set(k, out);
  if (tiles.size > 400) tiles.delete(tiles.keys().next().value);
  return out;
}
const at = (x, y) => tileOf(Math.floor((x + ox) / T), Math.floor((y + oy) / T));
const groundAt = (x, y) => at(x, y)?.ground(x, y) ?? NaN;
// (Past the built map, where the countryside is made up in the game, nothing is drawn to be
// on; nor in the last metres before the map's edge, where its streets are cut off.)
const [sw, sh] = index.size, EDGE = 50;
const inMap = (x, y) => x + ox > EDGE && x + ox < sw - EDGE && y + oy > EDGE && y + oy < sh - EDGE;
const onRoad = (x, y, living) => {
  const t = at(x, y);
  return !inMap(x, y) || !t?.hasRoad || t.road(x, y) || (living && t.paved(x, y));
};
// The height of a level at a point (as World.levelAt), NaN off it. (Within 0.4 m of its
// outline counts as on it: the game's level masks have cells of half a metre.)
const NEAR = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]];
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
const sideAt = (x, y) => at(x, y)?.side(x, y) ?? 0;
const heightOn = (x, y, level) => {
  const h = level !== undefined ? levelAt(x, y, level) : NaN;
  return Number.isNaN(h) ? groundAt(x, y) : h;
};

// (The area's transverse Mercator, well enough for naming a place to look at.)
const [bw, bs, be, bn] = index.bbox_wgs84, lat0 = (bs + bn) / 2, lon0 = (bw + be) / 2, rad = Math.PI / 180;
const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * rad), mLon = (lat) => 111412.84 * Math.cos(lat * rad) - 93.5 * Math.cos(3 * lat * rad);
const toWgs = (x, y) => { const lat = lat0 + y / mLat; return [lat.toFixed(5), (lon0 + x / mLon(lat)).toFixed(5)]; };
const near = args.near ? String(args.near).split(',').map(Number) : null;
const centre = near ? [(near[1] - lon0) * mLon(near[0]), (near[0] - lat0) * mLat, near[2] || 600] : null;

// Every car street once. (An edge is listed by every tile it crosses, whole or clipped: the
// longest; and a two-way street is an edge each way, one is enough.)
const edges = new Map();
const both = (id) => { const [u, v, k] = id.split('>'); return u < v ? id : `${v}>${u}>${k}`; };
for (const [i, j] of index.tiles) {
  if (centre && (Math.abs((i + 0.5) * T - ox - centre[0]) > centre[2] + T || Math.abs((j + 0.5) * T - oy - centre[1]) > centre[2] + T)) continue;
  const path = join(dir, 'tiles', `${i}_${j}.json`);
  if (!existsSync(path)) continue;
  const tile = bridgeSurfaceTile(JSON.parse(readFileSync(path, 'utf8')), `${i}_${j}`, preview);
  for (const e of tile.drive || []) {
    const key = both(e.id), had = edges.get(key);
    if (!had || had.pts.length < e.pts.length) edges.set(key, e);
  }
}

// The lines along a street: ACROSS metres apart out from the middle, and both edges (left,
// anticlockwise of the way's direction, positive).
function across(left, right) {
  const offs = [-right, 0, left];
  for (let k = 1; ACROSS > 0 && k * ACROSS < Math.max(left, right) - 0.3; k++) {
    if (k * ACROSS < left - 0.3) offs.push(k * ACROSS);
    if (k * ACROSS < right - 0.3) offs.push(-k * ACROSS);
  }
  return offs.sort((a, b) => a - b);
}

// A street's samples, a metre apart: on each line along it (the middle and both edges among
// them), each on the street's level there.
function walk(e) {
  const half = Math.max(1, (e.width || 6) / 2);
  const [kl, kr] = e.kerb || [half, half];
  const left = Math.max(0.5, Math.min(kl, half) - INSET), right = Math.max(0.5, Math.min(kr, half) - INSET);
  const offs = across(left, right), M = offs.indexOf(0), L = offs.length - 1;
  const out = [], living = e.hw === 'living_street';
  let s = 0;
  for (let i = 0; i < e.pts.length - 1; i++) {
    const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1], len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const n = Math.max(1, Math.round(len / STEP)), ux = (bx - ax) / len, uy = (by - ay) / len;
    for (let k = 0; k < n; k++, s += len / n) {
      const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n;
      // (Its level here: an edge of several ways can change level along itself.)
      const level = e.levels ? e.levels.reduce((lv, [from, l]) => (from <= s ? l : lv), e.levels[0][1]) : e.level;
      const hs = offs.map((o) => heightOn(x - uy * o, y + ux * o, level));
      const ons = level ? offs.map(() => true) : offs.map((o) => onRoad(x - uy * o, y + ux * o, living));
      const lx = x - uy * left, ly = y + ux * left, rx = x + uy * right, ry = y - ux * right;
      out.push({ s, x, y, ux, uy, lx, ly, rx, ry, level, mid: hs[M], l: hs[L], r: hs[0], left, width: left + right, offs, hs, ons,
        // (Off the road only where the whole width is: one way of a dual carriageway has a
        // median down its middle.)
        road: ons[M] || ons[L] || ons[0], on: { mid: ons[M], l: ons[L], r: ons[0] } });
    }
  }
  return out;
}

// What the LiDAR is compared with: points on the ground's streets, gathered over the whole
// run and looked up at once (scan_heights.py), each with its street and place along it.
const SCAN = args.scan === 'off' ? null : resolve(typeof args.scan === 'string' ? args.scan : join(root, 'pipeline/.cache/ipr_lidar/2023'));
const scanOn = SCAN && existsSync(join(SCAN, 'heights.npy'));
class Grow {
  constructor(T) { this.T = T; this.a = new T(1 << 16); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get view() { return this.a.subarray(0, this.n); }
}
const scanXY = new Grow(Float32Array), scanMap = new Grow(Float32Array), scanPos = new Grow(Uint32Array);
let scanUnder = 0;
// (A level well over the street here: it's under a bridge.)
const bridged = (x, y, h) => (at(x, y)?.levels ?? []).some((l) => l.on(x, y) && l.sample(x, y) > h + UNDER);
// What a point is next to: a bridge's or tunnel's level within BESIDE metres, a wall's
// terrace, or neither (for sorting what's off the LiDAR).
const BESIDE = 15;
const ROUND = [[0, 0], ...[5, 10, 15].flatMap((d) => [[d, 0], [-d, 0], [0, d], [0, -d], [d * .7, d * .7], [-d * .7, d * .7], [d * .7, -d * .7], [-d * .7, -d * .7]])];
function beside(x, y) {
  if (ROUND.some(([dx, dy]) => (at(x + dx, y + dy)?.levels ?? []).some((l) => l.on(x + dx, y + dy)))) return 'structure';
  if (ROUND.slice(0, 9).some(([dx, dy]) => sideAt(x + dx, y + dy) >= 2)) return 'terrace';
  return 'ground';
}

// The reported places, by the area's own coordinates, and the worst of each measure near each.
const PLACES = args.places === 'off' ? [] : JSON.parse(readFileSync(typeof args.places === 'string' ? args.places : join(root, 'scripts/road-places.json'), 'utf8')).places
  .map((p) => ({ ...p, xy: [(p.at[1] - lon0) * mLon(p.at[0]), (p.at[0] - lat0) * mLat], r: p.radius || 40, worst: {} }));
function placesNear(e) {
  if (!PLACES.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of e.pts) { x0 = Math.min(x, x0); y0 = Math.min(y, y0); x1 = Math.max(x, x1); y1 = Math.max(y, y1); }
  const pad = (e.width || 6) / 2 + 1;
  return PLACES.filter(({ xy: [x, y], r }) => x > x0 - r - pad && x < x1 + r + pad && y > y0 - r - pad && y < y1 + r + pad);
}
function notePlace(list, k, v, x, y, e) {
  for (const p of list) {
    if (Math.hypot(x - p.xy[0], y - p.xy[1]) > p.r || !(Math.abs(v) > Math.abs(p.worst[k]?.[0] ?? 0))) continue;
    p.worst[k] = [v, toWgs(x, y), `${e.hw} ${e.name || ''}`.trim()];
  }
}

// The ordinary metrics trim edge ends. Check the same-level approaches too,
// using the unmodified sampler for a point-by-point comparison.
function surfaceCheck(prof) {
  const ids = new Set();
  let unsafe = false;
  for (const [key, xKey, yKey] of [['mid', 'x', 'y'], ['l', 'lx', 'ly'], ['r', 'rx', 'ry']]) {
    const prior = prof.map((p) => {
      const x = p[xKey], y = p[yKey], i = Math.floor((x + ox) / T), j = Math.floor((y + oy) / T);
      const patches = surfaces.get(`${i}_${j}`);
      if (!patches || p.level) return p[key];
      const candidates = patches.filter(({ box: [a, b, c, d] }) => x > a && x < c && y > b && y < d);
      if (!candidates.length) return p[key];
      const h = at(x, y).base(x, y);
      if (Math.abs(h - p[key]) > 1e-6) for (const patch of candidates) ids.add(patch.id);
      return h;
    });
    const same = (a, b) => a.on[key] && b.on[key] && a.level === b.level
      && sideAt(a[xKey], a[yKey]) === sideAt(b[xKey], b[yKey]);
    for (let i = 1; i < prof.length; i++) {
      const a = prof[i - 1], b = prof[i];
      if (a[key] === prior[i - 1] && b[key] === prior[i]) continue;
      if (!same(a, b) || b.s - a.s < .3) continue;
      const grade = Math.abs(b[key] - a[key]) / (b.s - a.s);
      const old = Math.abs(prior[i] - prior[i - 1]) / (b.s - a.s);
      if (grade > .18 && grade > old + .035) unsafe = true;
    }
    for (let i = 3; i + 3 < prof.length; i++) {
      const a = prof[i - 3], b = prof[i], c = prof[i + 3];
      if (a[key] === prior[i - 3] && b[key] === prior[i] && c[key] === prior[i + 3]) continue;
      if (!same(a, b) || !same(b, c) || c.s - a.s < 4) continue;
      const f = (b.s - a.s) / (c.s - a.s);
      const bump = Math.abs(b[key] - (a[key] * (1 - f) + c[key] * f));
      const old = Math.abs(prior[i] - (prior[i - 3] * (1 - f) + prior[i + 3] * f));
      if (bump > .22 && bump > old + .06) unsafe = true;
    }
  }
  return ids.size ? { patches: [...ids], unsafeApproach: unsafe } : {};
}

const patchBounds = surfaces ? [...new Set([...surfaces.values()].flat())].map((p) => p.box) : [];
function touchesPatch(e) {
  if (!patchBounds.length || !e.pts.length) return false;
  const half = Math.max(1, (e.width || 6) / 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of e.pts) {
    x0 = Math.min(x, x0); y0 = Math.min(y, y0);
    x1 = Math.max(x, x1); y1 = Math.max(y, y1);
  }
  return patchBounds.some(([a, b, c, d]) => x0 - half < c && x1 + half > a && y0 - half < d && y1 + half > b);
}

const rows = [], scanRows = [];
// (Over the whole network: how many line metres each wave was measured on, and how many were over.)
const waveTotal = Object.fromEntries(WAVES.map((h) => [`wave${h}`, { n: 0, flag: 0, limit: 0 }]));
for (const e of edges.values()) {
  const prof = walk(e);
  const length = prof.length ? prof[prof.length - 1].s : 0;
  const end = Math.max(END, e.width || 0), inner = (p) => p.s >= end && p.s <= length - end;
  const worst = { step: [0, null], bump: [0, null], lean: [0, null], crown: [0, null], twist: [0, null], off: [0, null],
    ...Object.fromEntries(WAVES.map((h) => [`wave${h}`, [0, null]])) };
  const places = placesNear(e);
  const note = (k, v, p) => {
    if (places.length) notePlace(places, k, v, p.x, p.y, e);
    if (Math.abs(v) > Math.abs(worst[k][0])) worst[k] = [v, p];
  };
  // Waves: each line against its chord, within one level and on the carriageway.
  for (let li = 0; prof.length && li < prof[0].offs.length; li++) {
    const o = prof[0].offs[li];
    for (const h of WAVES) {
      const k = `wave${h}`, tot = waveTotal[k];
      for (let i = h; i + h < prof.length; i++) {
        const a = prof[i - h], p = prof[i], c = prof[i + h];
        if (!inner(a) || !inner(c) || a.level !== p.level || c.level !== p.level || !a.ons[li] || !p.ons[li] || !c.ons[li]) continue;
        const f = (p.s - a.s) / (c.s - a.s), v = p.hs[li] - (a.hs[li] * (1 - f) + c.hs[li] * f);
        if (!Number.isFinite(v)) continue;
        tot.n++;
        if (Math.abs(v) > FLAG[k]) tot.flag++;
        if (Math.abs(v) > LIMIT[k]) tot.limit++;
        const x = p.x - p.uy * o, y = p.y + p.ux * o;
        if (places.length) notePlace(places, k, v, x, y, e);
        if (Math.abs(v) > Math.abs(worst[k][0])) worst[k] = [v, { x, y, line: o }];
      }
    }
  }
  // The points to compare with the LiDAR: on the ground, on the carriageway, not under a bridge.
  const scanFrom = scanMap.n;
  for (let i = 0; scanOn && i < prof.length; i += SCAN_EVERY) {
    const p = prof[i];
    if (!inner(p) || p.level !== undefined) continue;
    for (let li = 0; li < p.offs.length; li++) {
      const x = p.x - p.uy * p.offs[li], y = p.y + p.ux * p.offs[li], h = p.hs[li];
      if (!p.ons[li] || !Number.isFinite(h) || !inMap(x, y)) continue;
      if (bridged(x, y, h)) { scanUnder++; continue; }
      scanXY.push(x); scanXY.push(y); scanMap.push(h + REF); scanPos.push(i);
    }
  }
  for (let i = 1; i < prof.length; i++) {
    const p = prof[i];
    if (!inner(p) || !inner(prof[i - 1])) continue;
    for (const side of ['mid', 'l', 'r']) {
      const d = p[side] - prof[i - 1][side];
      // A jump, not a slope: what the change either side of it doesn't account for.
      const beside = Math.max(i > 1 ? Math.abs(prof[i - 1][side] - prof[i - 2][side]) : 0,
        i < prof.length - 1 ? Math.abs(prof[i + 1][side] - p[side]) : 0);
      // (Only on the carriageway: OSM's width can reach past the kerb, onto a wall beside it.)
      if (!p.on[side] || !prof[i - 1].on[side]) continue;
      if (Number.isFinite(d) && Number.isFinite(beside)) note('step', Math.sign(d) * (Math.abs(d) - Math.min(Math.abs(d), beside)), { ...p, side, prev: prof[i - 1] });
    }
  }
  // (Over LEAN metres, the middle one of them: one sample is a point in a gutter or on a crossing.)
  const across = prof.map((p) => (p.on.l && p.on.r ? (p.l - p.r) / p.width * 100 : NaN)), m = LEAN >> 1;
  const lean = across.map((_, i) => {
    const w = i < m || i + m >= across.length ? [NaN] : across.slice(i - m, i + m + 1);
    return w.some(Number.isNaN) ? NaN : w.sort((a, b) => a - b)[m];
  });
  for (let i = 0; i < prof.length; i++) {
    const p = prof[i];
    if (!inner(p) || !Number.isFinite(lean[i])) continue;
    note('lean', lean[i], p);
    const b = Math.round(BUMP / STEP);
    if (i >= b && i + b < prof.length && inner(prof[i - b]) && inner(prof[i + b])) note('bump', p.mid - (prof[i - b].mid + prof[i + b].mid) / 2, p);
    // (The middle against the straight line between the edges, where the middle crosses it.)
    if (p.on.l && p.on.r && p.on.mid) note('crown', p.mid - (p.l + (p.r - p.l) * p.left / p.width), p);
    const j = i - Math.round(TWIST / STEP);
    if (j >= 0 && inner(prof[j]) && Number.isFinite(lean[j])) note('twist', lean[i] - lean[j], p);
  }
  if (MAIN.has(e.hw)) {
    let run = 0, from = null;
    for (const p of prof) {
      if (inner(p) && !p.road) { if (!run) from = p; run += STEP; note('off', run, from); } else run = 0;
    }
  }
  // What the worst step is: the edge of a deck or a tunnel's floor, a wall between two
  // terraces of the terrain, or the ground's lattice itself (a ramp or a spike).
  const st = worst.step[1], why = (() => {
    if (!st) return '';
    const xy = (q) => (st.side === 'mid' ? [q.x, q.y] : st.side === 'l' ? [q.lx, q.ly] : [q.rx, q.ry]);
    const [a, b] = [xy(st.prev), xy(st)];
    if (st.level !== undefined && Number.isNaN(levelAt(...a, st.level)) !== Number.isNaN(levelAt(...b, st.level))) return 'deck';
    return sideAt(...a) !== sideAt(...b) ? 'wall' : 'ground';
  })();
  // (Where exactly, and the terrace labels either side: for finding what made it.)
  const stepPair = st ? (st.side === 'mid' ? [[st.prev.x, st.prev.y], [st.x, st.y]] : st.side === 'l' ? [[st.prev.lx, st.prev.ly], [st.lx, st.ly]]
    : [[st.prev.rx, st.prev.ry], [st.rx, st.ry]]).map(([x, y]) => [+x.toFixed(2), +y.toFixed(2), sideAt(x, y)]) : null;
  const r = { id: e.id, why, stepPair, name: e.name || '', hw: e.hw, level: e.level, length: Math.round(length) };
  for (const k of Object.keys(worst)) { r[k] = +worst[k][0].toFixed(k === 'lean' || k === 'twist' ? 1 : 2); r[`${k}At`] = worst[k][1] ? toWgs(worst[k][1].x, worst[k][1].y) : null; }
  r.profile = args.profile && `${e.id} ${e.name || ''}`.includes(args.profile) ? prof : undefined;
  if (scanMap.n > scanFrom) scanRows.push([rows.length, scanFrom, scanMap.n, places, e]);
  rows.push(touchesPatch(e) ? { ...r, ...surfaceCheck(prof) } : r);
}

// The LiDAR at every gathered point, then per street: the worst offset (map minus scan), the
// share of its samples off by more than SCAN_NEAR, and the metres off by more than SCAN_FAR.
const scanSummary = (() => {
  if (!scanOn) return null;
  const work = mkdtempSync(join(tmpdir(), 'road-scan-')), pin = join(work, 'points.f32'), pout = join(work, 'heights.f32');
  try {
    writeFileSync(pin, scanXY.view);
    const run = spawnSync('uv', ['run', 'python', 'scan_heights.py', index.area || area, pin, pout, '--lidar', SCAN],
      { cwd: join(root, 'pipeline'), stdio: ['ignore', 'inherit', 'inherit'] });
    if (run.status !== 0) throw new Error(`scan_heights.py failed (${run.status ?? run.error})`);
    const raw = readFileSync(pout), scan = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    if (scan.length !== scanMap.n) throw new Error(`scan_heights.py gave ${scan.length} heights for ${scanMap.n} points`);
    const map = scanMap.view, pos = scanPos.view, xy = scanXY.view;
    const all = [];
    let n = 0, near = 0, far = 0;
    for (const [ri, from, to, places, e] of scanRows) {
      const r = rows[ri], bad = new Set();
      let worst = 0, at = null, count = 0, over = 0;
      for (let q = from; q < to; q++) {
        const d = map[q] - scan[q];
        if (!Number.isFinite(d)) continue;
        count++;
        if (Math.abs(d) > SCAN_NEAR) over++;
        if (Math.abs(d) > SCAN_FAR) bad.add(pos[q]);
        if (Math.abs(d) > Math.abs(worst)) { worst = d; at = q; }
        if (places.length) notePlace(places, 'scan', d, xy[2 * q], xy[2 * q + 1], e);
        if (q % 7 === 0) all.push(d);
      }
      n += count; near += count - over;
      if (!count) continue;
      r.scan = +worst.toFixed(2);
      r.scanAt = toWgs(xy[2 * at], xy[2 * at + 1]);
      r.scanNear = beside(xy[2 * at], xy[2 * at + 1]);
      r.scanShare = Math.round(100 * over / count);
      r.scanBad = bad.size * STEP;
    }
    for (let q = 0; q < scan.length; q++) if (Math.abs(map[q] - scan[q]) > SCAN_FAR) far++;
    all.sort((a, b) => a - b);
    return { lidar: basename(SCAN), samples: n, under: scanUnder, within: n ? +(100 * near / n).toFixed(1) : null,
      over: n ? +(100 * far / n).toFixed(2) : null, median: all.length ? +all[all.length >> 1].toFixed(3) : null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
})();

const before = args.against ? JSON.parse(readFileSync(args.against, 'utf8')) : null;
const KINDS = [['step', 'Steps along the street', 'm'], ['bump', `Bumps (against the line ${BUMP} m either side)`, 'm'], ['lean', 'Leaning across', '%'], ['crown', 'Ridge or trough across', 'm'],
  ['twist', `Twisting (lean's change over ${TWIST} m)`, '%'], ['off', 'Off the road (middle not on a carriageway)', 'm'],
  ...WAVES.map((h) => [`wave${h}`, `Waves along a line (${h} m either side)`, 'm']),
  ...(scanSummary ? [['scan', 'Off the LiDAR (map minus scan)', 'm']] : [])];
const over = (list, k, lim) => list.filter((r) => Math.abs(r[k]) > lim[k] || (k === 'off' && r[k] >= lim[k] && lim === FLAG)).length;
const had = (list, k) => list.some((r) => r[k] !== undefined);
console.log(`${area}: built ${index.built} (pipeline ${index.pipeline || '?'}${index.terrainOptions ? `, ${Object.keys(index.terrainOptions).join(' ') || 'default options'}` : ''}), `
  + `${rows.length} car streets${centre ? ` within ${centre[2]} m of ${near[0]}, ${near[1]}` : ''}`);
console.log('\nStreets with a finding (flag / hard limit):');
for (const [k, title, unit] of KINDS) {
  console.log(`  ${title.padEnd(44)} ${String(over(rows, k, FLAG)).padStart(5)} over ${FLAG[k]} ${unit}, ${String(over(rows, k, LIMIT)).padStart(4)} over ${LIMIT[k]} ${unit}`
    + (before ? (had(before.rows, k) ? `   (before: ${over(before.rows, k, FLAG)}, ${over(before.rows, k, LIMIT)})` : '   (before: not measured)') : ''));
}
// Over the whole network, which doesn't depend on how a street is cut into edges.
const pct = (a, b) => (b ? (100 * a / b).toFixed(2) : '–');
const lines = { across: ACROSS, waves: Object.fromEntries(Object.entries(waveTotal).map(([k, t]) => [k, { km: +(t.n * STEP / 1000).toFixed(1), flag: +pct(t.flag, t.n), limit: +pct(t.limit, t.n) }])) };
console.log(`\nAlong the lines${ACROSS ? ` ${ACROSS} m apart` : ' (middle and edges)'}, share of line metres with a wave over the flag / the hard limit:`);
for (const [k, t] of Object.entries(lines.waves)) {
  const b = before?.lines?.waves?.[k];
  console.log(`  ${k.slice(4).padStart(2)} m either side: ${String(t.flag).padStart(5)} % / ${String(t.limit).padStart(5)} %  of ${t.km} km${b ? `   (before: ${b.flag} % / ${b.limit} %)` : ''}`);
}
if (scanSummary) {
  const b = before?.scan;
  console.log(`\nAgainst the LiDAR (${scanSummary.lidar}), streets on the ground, every ${SCAN_EVERY} m on every line: ${scanSummary.within} % within ${SCAN_NEAR} m, `
    + `${scanSummary.over} % off by more than ${SCAN_FAR} m; middle offset ${scanSummary.median} m; ${scanSummary.samples} samples, ${scanSummary.under} under bridges left out`
    + (b ? `\n  (before: ${b.within} % within, ${b.over} % over ${SCAN_FAR} m, middle ${b.median} m)` : ''));
  const by = (list) => list.filter((r) => Math.abs(r.scan) > SCAN_FAR).reduce((o, r) => ({ ...o, [r.scanNear]: (o[r.scanNear] || 0) + 1 }), {});
  const now = by(rows), was = before && had(before.rows, 'scanNear') ? by(before.rows) : null;
  console.log(`  streets whose worst is over ${SCAN_FAR} m off: ${['structure', 'terrace', 'ground'].map((k) => `${now[k] || 0} ${k === 'structure' ? 'by a bridge or tunnel' : k === 'terrace' ? "by a wall's terrace" : 'by neither'}`
    + (was ? ` (before: ${was[k] || 0})` : '')).join(', ')}`);
} else if (SCAN) console.log(`\n(No LiDAR in ${SCAN}: --scan <directory> to compare with it; pipeline/ipr_lidar.py imports it.)`);
const N = Number(args.worst || 25);
for (const [k, title, unit] of KINDS) {
  const list = rows.filter((r) => Math.abs(r[k]) > FLAG[k] || (k === 'off' && r[k] >= FLAG[k])).sort((a, b) => Math.abs(b[k]) - Math.abs(a[k])).slice(0, N);
  if (!list.length) continue;
  console.log(`\n${title}:`);
  for (const r of list) {
    console.log(`  ${String(r[k]).padStart(6)} ${unit}  ${r[`${k}At`].join(', ')}  ${k === 'step' ? `${r.why}: ` : ''}${r.hw} ${r.name} (${r.id}, ${r.length} m${r.level !== undefined ? `, level ${r.level}` : ''}`
      + `${k === 'scan' ? `, ${r.scanShare} % over ${SCAN_NEAR} m, ${r.scanBad} m over ${SCAN_FAR} m, by ${r.scanNear}` : ''})`);
  }
}
// The reported places: the worst of each measure near each, ! over the flag, !! over the hard limit.
const placeRows = PLACES.filter((p) => Object.keys(p.worst).length).map((p) => ({ name: p.name, at: p.at, worst: p.worst }));
if (placeRows.length) {
  console.log(`\nReported places (the worst within each one's radius; ! over the flag, !! over the hard limit):`);
  const mark = (k, v) => (Math.abs(v) > LIMIT[k] ? '!!' : Math.abs(v) > FLAG[k] ? '!' : '');
  for (const p of placeRows) {
    const was = before?.places?.find((q) => q.name === p.name)?.worst;
    const show = (k) => (p.worst[k] ? `${k} ${p.worst[k][0].toFixed(k === 'lean' || k === 'twist' ? 1 : 2)}${mark(k, p.worst[k][0])}`
      + (was?.[k] ? ` (${was[k][0].toFixed(k === 'lean' || k === 'twist' ? 1 : 2)})` : '') : null);
    console.log(`  ${p.name}: ${KINDS.map(([k]) => show(k)).filter(Boolean).join(', ')}`);
    const top = KINDS.map(([k]) => [k, p.worst[k]]).filter(([k, w]) => w && Math.abs(w[0]) > FLAG[k])
      .sort((a, b) => Math.abs(b[1][0]) / LIMIT[b[0]] - Math.abs(a[1][0]) / LIMIT[a[0]])[0];
    if (top) console.log(`      worst: ${top[0]} at ${top[1][1].join(', ')} on ${top[1][2]}`);
  }
}
for (const r of rows) {
  if (!r.profile) continue;
  console.log(`\n${r.id} ${r.hw} ${r.name} (every ${STEP} m: left / middle / right, a = above sea level; * = off the road)`);
  console.log('  ' + r.profile.map((p) => `${(p.l + REF).toFixed(1)}/${(p.mid + REF).toFixed(1)}/${(p.r + REF).toFixed(1)}${p.road ? '' : '*'}`).join(' '));
  delete r.profile;
}
if (args.save) writeFileSync(args.save, JSON.stringify({ built: index.built, pipeline: index.pipeline, terrainOptions: index.terrainOptions,
  terrainMode: surfaces ? 'surfaces' : pilot ? 'profile' : 'base', near: args.near || undefined, lines, scan: scanSummary, places: placeRows,
  patchDigest: trial && createHash('sha256').update(trial).digest('hex'),
  ...(bridgeTrial ? { bridgeDigest: createHash('sha256').update(bridgeTrial).digest('hex') } : {}),
  rows: rows.map(({ profile, ...r }) => r) }));
if (args.strict) {
  const bad = KINDS.reduce((n, [k]) => n + over(rows, k, LIMIT), 0);
  if (bad) {
    console.error(`\n${bad} finding(s) over the hard limits`);
    process.exit(1);
  }
}
