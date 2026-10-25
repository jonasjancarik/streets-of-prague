#!/usr/bin/env node
// CPU checks that TileWorld.update loads, draws, keeps and drops exactly the tiles its
// original selection did, with fake files and workers and a controlled clock. Each
// fixture runs twice side by side: once through test-only copies of the original
// selection code (the oracles below) and once through the real methods, and every
// event and every bit of scheduling state must match after every frame.
//   node scripts/check-tile-selection.mjs             also: a repeated view reuses its selection
//   node scripts/check-tile-selection.mjs --baseline  for code without reuse: oracles and scheduling only
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
const baseline = process.argv.includes('--baseline');
let clock = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
globalThis.location = { search: '?go' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
const { TileWorld } = await import('../src/tiles.ts');
const { CountrysideTiles } = await import('../src/countrysideTiles.ts');
const source = readFileSync(new URL('../src/tiles.ts', import.meta.url), 'utf8');
const DRAWN_KEEP = Number(source.match(/const DRAWN_KEEP = (\d+);/)[1]);
// Expected failures (fetches and draws the fixtures fail on purpose) are counted, not printed.
let quiet = 0;
console.error = console.warn = () => { quiet++; };

// ---- Oracles: TileWorld's selection as it was before plan 035 (36b50fc) ----------
function oracleAround(x, y, r) {
  const T = this.T, out = [];
  const i0 = Math.floor((x - r + this.ox) / T), i1 = Math.floor((x + r + this.ox) / T);
  const j0 = Math.floor((y - r + this.oy) / T), j1 = Math.floor((y + r + this.oy) / T);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const k = `${i}_${j}`;
      if (!this.has(i, j)) continue;
      const cx = (i + 0.5) * T - this.ox, cy = (j + 0.5) * T - this.oy;
      const d = Math.max(0, Math.hypot(cx - x, cy - y) - T * 0.71);
      if (d <= r) out.push([d, k]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
}
function oracleNear(x, y, r) {
  const T = this.T, out = [];
  const i0 = Math.floor((x - r + this.ox) / T), i1 = Math.floor((x + r + this.ox) / T);
  const j0 = Math.floor((y - r + this.oy) / T), j1 = Math.floor((y + r + this.oy) / T);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const k = `${i}_${j}`;
      if (!this.has(i, j)) continue;
      const ax = i * T - this.ox, ay = j * T - this.oy;
      const d = Math.hypot(Math.max(ax - x, 0, x - ax - T), Math.max(ay - y, 0, y - ay - T));
      if (d <= r) out.push([d, k]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
}
function oracleReach(x, y, r, drawn) { return drawn < r ? this.near(x, y, drawn) : this.around(x, y, r); }
function oracleUpdate(x, y, r, drawn = r) {
  const now = performance.now();
  const want = this.around(x, y, r).filter((k) => !((this.retry.get(k) ?? 0) > now));
  for (const k of want.slice(0, 12)) this.fetchTile(k);
  const show = this.reach(x, y, r, drawn);
  this.shown = new Set(show);
  for (const k of show) {
    if (this.building + this.dressing.size >= this.workers.size) break;
    const tile = this.loaded.get(k);
    if (tile && !tile.drawn && !tile.dressing && tile.drawAfter <= now) void this.dress(tile);
  }
  while (this.building + this.dressing.size < this.workers.size) {
    const next = want.find((k) => !this.loaded.has(k) && !this.inFlight.has(k));
    if (!next) break;
    this.building++;
    this.inFlight.add(next);
    this.fetchTile(next).then((files) => this.build(next, files)).catch((e) => console.error(e)).finally(() => {
      this.building--;
      this.inFlight.delete(next);
    });
  }
  const keep = new Set(this.around(x, y, r + this.T * 0.5));
  for (const k of [...this.loaded.keys()]) if (!keep.has(k)) this.drop(k);
  if (now - this.trimmed > 1000) { this.trimmed = now; this.forget(x, y, r); }
  if (drawn < r) {
    const keepDrawn = new Set(this.near(x, y, drawn + DRAWN_KEEP));
    for (const tile of this.loaded.values()) if (tile.shown && !keepDrawn.has(tile.k)) this.undress(tile);
  }
  for (const k of [...this.pending.keys()]) if (!keep.has(k) && !this.loaded.has(k) && !this.inFlight.has(k)) this.pending.delete(k);
  for (const k of this.photos.keys()) {
    if (!keep.has(k) && !this.loaded.has(k) && !this.inFlight.has(k) && !this.builds.has(k)) this.dropPhoto(k);
  }
  const ci = Math.floor((x + this.ox) / this.T), cj = Math.floor((y + this.oy) / this.T);
  const reach = Math.ceil(r / this.T) + 3;
  if (ci !== this.jsonRange?.i || cj !== this.jsonRange?.j || reach !== this.jsonRange?.reach) {
    this.jsonRange = { i: ci, j: cj, reach };
    for (const k of this.jsons.keys()) {
      const [i, j] = k.split('_').map(Number);
      if (Math.abs(i - ci) > reach || Math.abs(j - cj) > reach) this.jsons.delete(k);
    }
  }
}

// ---- Fixtures ---------------------------------------------------------------------
// A 16 × 14 built map with an origin off the grid, and holes in it (sparse coverage).
const T = 250, OX = 1234.5, OY = -321.25, COLS = 16, ROWS = 14;
const index = { tile: T, origin: [OX, OY], cols: COLS, rows: ROWS, size: [COLS * T, ROWS * T] };
function random(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }
function sparse(seed, share = 0.75) {
  const rand = random(seed), out = [];
  for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) if (rand() < share) out.push(`${i}_${j}`);
  return out;
}
const centre = (i, j) => [(i + 0.5) * T - OX, (j + 0.5) * T - OY];
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise((done) => setImmediate(done)); };
function defer(k) {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { k, promise, resolve, reject };
}

function world(oracle, { available = sparse(1), box, workers = 3 } = {}) {
  const log = [], makes = [], draws = [];
  const country = box === undefined ? null : Object.assign(Object.create(CountrysideTiles.prototype), { index, box });
  const w = Object.assign(Object.create(TileWorld.prototype), {
    T, ox: OX, oy: OY, index, available: new Set(available), availableRevision: 0, country,
    loaded: new Map(), byIndex: new Map(), sky: new Map(), photos: new Map(), pending: new Map(),
    builds: new Map(), retry: new Map(), jsons: new Map(), jsonRange: null, buildTimes: [], drawTimes: [],
    dressing: new Set(), inFlight: new Set(), building: 0, workers: { size: workers }, shown: new Set(),
    last: { i: NaN }, terrainRevision: 0, trimmed: 0, driveBy: new Map(), walkBy: new Map(), graphBeyond: 500,
    anchors: () => [], drive: { remove: (e) => e }, walk: { remove: (e) => e },
    onForget: (drive, walk, keys) => log.push(`forget ${keys.join(' ')}`), onDrop() {},
    trees: { remove() {} }, scene: { remove() {} }, skyTotals: { coalesced: 0, cancelled: 0 },
    failing: new Set(), log, makes, draws, made: 0, assembled: 0, sorted: 0, unsorted: 0, forgetQueries: 0, forgetting: false,
  });
  w.fetchTile = function (k) {
    log.push(`fetch ${k}`);
    if (!this.pending.has(k)) {
      const files = this.failing.has(k) ? Promise.reject(new Error(`fixture: ${k} failed`)) : Promise.resolve({});
      files.catch(() => { if (this.pending.get(k) === files) this.failed(k); });
      this.pending.set(k, files);
    }
    return this.pending.get(k);
  };
  // A finished build places its tile, as insert() does.
  w.make = function (k) {
    log.push(`make ${k}`); this.made++;
    const job = defer(k); makes.push(job);
    return job.promise.then(() => {
      const [i, j] = k.split('_').map(Number);
      const tile = { k, i, j, shown: false, drawn: null, dressing: null, drawAfter: 0, relief: null, source: null, furniture: [], fixtures: [], poles: [], fences: [] };
      this.loaded.set(k, tile); this.byIndex.set(i * 65536 + j, tile);
      return tile;
    });
  };
  w.meshJobs = () => null;
  w.assemble = function (tile) {
    log.push(`assemble ${tile.k}`); this.assembled++;
    const job = defer(tile.k); job.tile = tile; draws.push(job);
    return job.promise.then(() => { tile.drawn = { group: { clear() {} }, surfaces: { dispose() {} }, own: [], smoke: null }; });
  };
  for (const name of ['dress', 'undress', 'drop']) {
    const method = TileWorld.prototype[name];
    w[name] = function (a, ...rest) { log.push(`${name} ${typeof a === 'string' ? a : a.k}`); return method.call(this, a, ...rest); };
  }
  const forget = TileWorld.prototype.forget;
  w.forget = function (...a) { this.forgetting = true; try { return forget.apply(this, a); } finally { this.forgetting = false; } };
  if (oracle) Object.assign(w, { around: oracleAround, near: oracleNear, reach: oracleReach, update: oracleUpdate });
  else {
    // Spatial queries, counted: those made for the frame's selection, sorted or not,
    // and those of the timed graph forgetting, apart.
    for (const name of ['around', 'near']) {
      const method = TileWorld.prototype[name];
      w[name] = function (...a) {
        if (this.forgetting) this.forgetQueries++; else if (a[3] === false) this.unsorted++; else this.sorted++;
        return method.apply(this, a);
      };
    }
  }
  return w;
}

function pair(options) {
  const p = { ref: world(true, options), cand: world(false, options) };
  p.both = (f) => { f(p.ref); f(p.cand); };
  return p;
}
const queries = (w) => w.sorted + w.unsorted;
// Everything update() decides, in order, must be the same in both worlds.
function same(p, label) {
  const { ref, cand } = p;
  assert.deepEqual(cand.log, ref.log, `${label}: events`);
  const state = (w) => ({
    shown: [...w.shown], loaded: [...w.loaded.keys()], pending: [...w.pending.keys()], photos: [...w.photos.keys()],
    retry: [...w.retry], inFlight: [...w.inFlight], building: w.building, dressing: [...w.dressing].map((t) => t.k),
    drawn: [...w.loaded.values()].filter((t) => t.drawn).map((t) => t.k), drawAfter: [...w.loaded.values()].map((t) => t.drawAfter),
    jsons: [...w.jsons.keys()], driveBy: [...w.driveBy.keys()], makes: w.makes.map((j) => j.k), draws: w.draws.map((j) => j.k),
  });
  assert.deepEqual(state(cand), state(ref), `${label}: state`);
  const events = ref.log.slice();
  ref.log.length = 0; cand.log.length = 0;
  return events;
}
// One frame in both worlds, and the fetches and builds it set off.
async function frame(p, x, y, r, drawn, label) {
  p.both((w) => w.update(x, y, r, drawn));
  await flush();
  return same(p, label);
}
// Settles the oldest outstanding build or mesh job in both worlds alike.
async function finish(p, kind, ok = true, label = kind) {
  const a = p.ref[kind], b = p.cand[kind];
  if (!a.length) return false;
  const ja = a.shift(), jb = b.shift();
  if (ok) { ja.resolve(); jb.resolve(); } else { ja.reject(new Error('fixture job failed')); jb.reject(new Error('fixture job failed')); }
  await flush();
  same(p, `${label}: completion`);
  return true;
}
async function finishAll(p, label) { while (await finish(p, 'makes', true, label) || await finish(p, 'draws', true, label)); }
// …or every outstanding job but those for one key.
async function finishOthers(p, k, label) {
  for (const kind of ['makes', 'draws']) {
    for (let n = 0; n < p.ref[kind].length;) {
      if (p.ref[kind][n].k === k) { n++; continue; }
      const [ja] = p.ref[kind].splice(n, 1), [jb] = p.cand[kind].splice(n, 1);
      assert.equal(jb.k, ja.k);
      ja.resolve(); jb.resolve();
      await flush(); same(p, `${label}: completion`);
    }
  }
}

const counts = {};
const failures = [];
async function check(name, run) {
  try { await run(); } catch (error) { failures.push(name); console.log(`FAIL ${name}`); console.log(error); }
}

// ---- 1. Selection oracles at random, edge-of-tile and countryside positions --------
await check('selection oracles', async () => {
  const probes = [world(false, { available: sparse(2) }), world(false, { available: sparse(3, 0.4), box: [-3000, -3000, 6500, 5000] }), world(false, { available: [], box: [-9000, -9000, 9000, 9000] })];
  const rand = random(7);
  let n = 0;
  for (const w of probes) {
    for (let step = 0; step < 600; step++) {
      let x = rand() * 6000 - 1500, y = rand() * 5000 - 1200;
      // On tile edges and corners exactly, and the smallest step either side of them.
      if (step % 3 === 0) x = Math.round((x + OX) / T) * T - OX;
      if (step % 5 === 0) y = Math.round((y + OY) / T) * T - OY;
      if (step % 7 === 0) x += (rand() < 0.5 ? -1 : 1) * Number.EPSILON * Math.max(1, Math.abs(x));
      for (const r of [0, 1, 120, 300 + rand() * 900, 2500]) {
        const ref = { ...w, has: w.has };
        assert.deepEqual(w.around(x, y, r), oracleAround.call(ref, x, y, r), `around(${x}, ${y}, ${r})`);
        assert.deepEqual(w.near(x, y, r), oracleNear.call(ref, x, y, r), `near(${x}, ${y}, ${r})`);
        assert.deepEqual(new Set(w.around(x, y, r, false)), new Set(oracleAround.call(ref, x, y, r)), `unsorted around(${x}, ${y}, ${r})`);
        assert.deepEqual(new Set(w.near(x, y, r, false)), new Set(oracleNear.call(ref, x, y, r)), `unsorted near(${x}, ${y}, ${r})`);
        for (const drawn of [r * 0.4, r, Infinity]) assert.deepEqual(w.reach(x, y, r, drawn), oracleReach.call({ ...ref, around: oracleAround, near: oracleNear }, x, y, r, drawn));
        n++;
      }
    }
  }
  counts.selectionProbes = n;
});

// ---- 1. Driving, zooming, teleports and tiny moves, with work finishing in between ---
await check('random drive', async () => {
  const p = pair({ available: sparse(4), box: [-2500, -2000, 7000, 5500] });
  const rand = random(11);
  let x = 800, y = 600, r = 520, drawn = 380, frames = 0;
  for (let step = 0; step < 900; step++) {
    const move = rand();
    if (move < 0.35) { x += (rand() - 0.5) * 6; y += (rand() - 0.5) * 6; } // driving
    else if (move < 0.5) { x += (rand() - 0.5) * 1e-6; } // within the same tile, by a hair
    else if (move < 0.6) { x = Math.round((x + OX) / T) * T - OX; y = Math.round((y + OY) / T) * T - OY; } // a tile corner
    else if (move < 0.65) { x = rand() * 9000 - 2500; y = rand() * 7000 - 2000; } // teleport, maybe into the countryside
    else if (move < 0.72) { r = 300 + rand() * 900; drawn = rand() < 0.3 ? Infinity : r * (0.3 + rand() * 0.9); } // zoom
    else if (move < 0.76) drawn = rand() < 0.2 ? Infinity : r * (0.3 + rand() * 0.9); // the view about to widen, alone
    else if (move < 0.78) r += 1e-9; // the loading radius alone, by a hair
    else if (move < 0.8) y -= 1e-9;
    // (otherwise exactly the same view again)
    if (rand() < 0.03) { const k = [...p.ref.pending.keys(), ...p.ref.available][Math.floor(rand() * 20)]; if (k) p.both((w) => w.failing.add(k)); }
    if (rand() < 0.03) p.both((w) => w.failing.clear());
    await frame(p, x, y, r, drawn, `drive step ${step}`); frames++;
    clock += 16 + Math.floor(rand() * 20);
    for (let m = Math.floor(rand() * 3); m > 0; m--) await finish(p, 'makes', rand() > 0.1, `drive step ${step}`);
    for (let m = Math.floor(rand() * 3); m > 0; m--) await finish(p, 'draws', rand() > 0.1, `drive step ${step}`);
  }
  counts.drive = { frames, sorted: p.cand.sorted, unsorted: p.cand.unsorted, forget: p.cand.forgetQueries };
});

// ---- 2/3. Standing still: work drains, and the selection is reused ----------------
await check('stationary drain', async () => {
  const p = pair({ available: sparse(5), workers: 2 });
  const [x, y] = centre(7, 6), r = 640, drawn = 420;
  await frame(p, x, y, r, drawn, 'prime');
  const before = queries(p.cand);
  const made0 = p.cand.made, assembled0 = p.cand.assembled;
  for (let n = 0; n < 60; n++) {
    clock += 16;
    await frame(p, x, y, r, drawn, `still ${n}`);
    await finish(p, 'makes', true, `still ${n}`);
    await finish(p, 'draws', true, `still ${n}`);
  }
  const made = p.cand.made - made0, dressed = p.cand.assembled - assembled0;
  counts.still60 = { selection: queries(p.cand) - before, made, dressed };
  assert.ok(made > 10 && dressed > 5, 'builds and draws keep being dispatched while the view stands still');
  if (!baseline) assert.equal(queries(p.cand) - before, 0, '60 identical views make no spatial queries after the first');
  for (let n = 0; n < 400 && (p.ref.makes.length || p.ref.draws.length || p.ref.building || p.ref.dressing.size || n < 2); n++) {
    clock += 16;
    await frame(p, x, y, r, drawn, `drain ${n}`);
    await finishAll(p, `drain ${n}`);
  }
  const want = oracleAround.call(p.ref, x, y, r), show = oracleNear.call(p.ref, x, y, drawn);
  assert.deepEqual(want.filter((k) => !p.cand.loaded.has(k)), [], 'every tile within reach is loaded without moving');
  assert.deepEqual(show.filter((k) => !p.cand.loaded.get(k)?.drawn), [], 'every tile in view is drawn without moving');
  assert.equal(p.cand.building + p.cand.dressing.size, 0, 'no stranded work');
});

// ---- 4. Failed fetches wait out their pause, at a fixed view -----------------------
await check('failed fetch cooldown', async () => {
  const p = pair({ available: sparse(6), workers: 2 });
  const [x, y] = centre(5, 5), r = 520, drawn = 400;
  const k = oracleAround.call(p.ref, x, y, r)[0];
  p.both((w) => w.failing.add(k));
  await frame(p, x, y, r, drawn, 'fail');
  await flush(); same(p, 'fail settles');
  const deadline = p.cand.retry.get(k);
  assert.ok(deadline > clock, 'failed fetch sets a retry time');
  p.both((w) => w.failing.delete(k));
  const before = queries(p.cand);
  while (clock + 16 < deadline) {
    clock += 16;
    const events = await frame(p, x, y, r, drawn, 'cooling');
    assert.ok(!events.includes(`fetch ${k}`), 'no fetch before the retry time');
    await finishAll(p, 'cooling');
  }
  if (!baseline) assert.equal(queries(p.cand) - before, 0, 'cooldown frames reuse the selection');
  clock = deadline + 1;
  const events = await frame(p, x, y, r, drawn, 'retry due');
  assert.ok(events.includes(`fetch ${k}`), 'fetched again once the retry time passes, without moving');
  await finishAll(p, 'retry'); await frame(p, x, y, r, drawn, 'retried'); await finishAll(p, 'retried');
  assert.ok(p.cand.loaded.has(k), 'the retried tile loads');
});

// ---- 4. A failed draw waits out its pause too ---------------------------------------
await check('dress cooldown', async () => {
  const p = pair({ available: sparse(8), workers: 1 });
  const [x, y] = centre(6, 6), r = 400, drawn = 300;
  await frame(p, x, y, r, drawn, 'start');
  const k = p.ref.makes[0].k;
  await finish(p, 'makes', true, 'built');
  let events = await frame(p, x, y, r, drawn, 'dress');
  assert.ok(events.includes(`dress ${k}`));
  await finish(p, 'draws', false, 'draw fails');
  const deadline = p.cand.loaded.get(k).drawAfter;
  assert.ok(deadline > clock, 'failed draw sets a pause');
  while (clock + 16 < deadline) {
    clock += 16;
    events = await frame(p, x, y, r, drawn, 'draw cooling');
    assert.ok(!events.includes(`dress ${k}`), 'no draw before the pause ends');
    while (await finish(p, 'makes', true, 'draw cooling'));
    // Other tiles' draws finish; the failed one is not among them.
    while (await finish(p, 'draws', true, 'draw cooling'));
  }
  clock = deadline + 1;
  events = await frame(p, x, y, r, drawn, 'draw due');
  assert.ok(events.includes(`dress ${k}`), 'drawn again once the pause ends, without moving');
});

// ---- 4. An old tile's late draw doesn't take its replacement's place ---------------
await check('stale completion after replacement', async () => {
  const p = pair({ available: sparse(9, 1), workers: 2 });
  const [x, y] = centre(4, 4), r = 300, drawn = 200;
  await frame(p, x, y, r, drawn, 'start');
  await finishAll(p, 'start');
  await frame(p, x, y, r, drawn, 'dress');
  const old = p.cand.draws[0];
  assert.ok(old, 'a draw is in progress');
  const [fx, fy] = centre(14, 12);
  let events = await frame(p, fx, fy, r, drawn, 'teleport away');
  assert.ok(events.includes(`drop ${old.k}`), 'the old tile is dropped');
  await finishOthers(p, old.k, 'away');
  for (let n = 0; n < 30 && !p.cand.loaded.has(old.k); n++) {
    clock += 16; await frame(p, x, y, r, drawn, `back ${n}`);
    await finishOthers(p, old.k, `back ${n}`);
    while (p.ref.makes.length) await finish(p, 'makes', true, `back ${n}`);
  }
  const replacement = p.cand.loaded.get(old.k);
  assert.ok(replacement && replacement !== old.tile, 'a replacement tile is built under the same key');
  for (let n = 0; n < 30 && !replacement.dressing; n++) { clock += 16; await frame(p, x, y, r, drawn, `replacement ${n}`); await finishOthers(p, old.k, `replacement ${n}`); }
  assert.ok(replacement.dressing, 'the replacement has its own draw in progress');
  // Settle the old tile's draw first, in both worlds.
  const ia = p.ref.draws.findIndex((j) => j.k === old.k), ib = p.cand.draws.findIndex((j) => j.k === old.k);
  assert.equal(ia, ib);
  const [ja] = p.ref.draws.splice(ia, 1), [jb] = p.cand.draws.splice(ib, 1);
  assert.equal(jb, old);
  ja.resolve(); jb.resolve(); await flush(); same(p, 'old completion');
  assert.ok(p.cand.dressing.has(replacement) && replacement.dressing, 'the replacement is still scheduled as busy');
  events = await frame(p, x, y, r, drawn, 'after old completion');
  assert.ok(!events.includes(`dress ${old.k}`), 'no second draw for the replacement');
  await finishAll(p, 'finish'); await frame(p, x, y, r, drawn, 'done');
  assert.ok(replacement.drawn);
});

// ---- 4. Tiles coming and going at a fixed view --------------------------------------
await check('availability changes', async () => {
  const keys = sparse(10, 1);
  const [x, y] = centre(8, 7), r = 520, drawn = 380;
  const p = pair({ available: keys });
  const removed = oracleAround.call(p.ref, x, y, r)[2];
  p.both((w) => { w.available.delete(removed); w.availableRevision++; });
  await frame(p, x, y, r, drawn, 'start');
  for (let n = 0; n < 60; n++) { clock += 16; await frame(p, x, y, r, drawn, `fill ${n}`); await finishAll(p, `fill ${n}`); }
  assert.ok(!p.cand.loaded.has(removed));
  p.both((w) => { w.available.add(removed); w.availableRevision++; });
  let events = await frame(p, x, y, r, drawn, 'added');
  assert.ok(events.includes(`fetch ${removed}`), 'a tile that becomes available is fetched at once');
  await finishAll(p, 'added'); await frame(p, x, y, r, drawn, 'added built'); await finishAll(p, 'added built');
  assert.ok(p.cand.loaded.has(removed));
  const gone = oracleAround.call(p.ref, x, y, r)[0];
  p.both((w) => { w.available.delete(gone); w.availableRevision++; });
  events = await frame(p, x, y, r, drawn, 'removed');
  assert.ok(events.includes(`drop ${gone}`), 'a tile that stops being available is dropped at once');
});

// ---- 4. The countryside opening, shrinking and failing ------------------------------
await check('countryside coverage', async () => {
  const p = pair({ available: sparse(12, 1), box: null });
  // At the built map's east edge, looking out over where the countryside would be.
  const x = COLS * T - OX - 40, y = 7 * T - OY, r = 700, drawn = 500;
  const outside = (w) => [...w.loaded.keys()].filter((k) => Number(k.split('_')[0]) >= COLS);
  await frame(p, x, y, r, drawn, 'closed');
  for (let n = 0; n < 40; n++) { clock += 16; await frame(p, x, y, r, drawn, `closed ${n}`); await finishAll(p, `closed ${n}`); }
  assert.equal(outside(p.cand).length, 0);
  p.both((w) => { w.country.box = [-OX - 2000, -OY - 2000, COLS * T - OX + 2000, ROWS * T - OY + 2000]; });
  let events = await frame(p, x, y, r, drawn, 'opened');
  assert.ok(events.some((e) => e.startsWith('fetch ') && Number(e.slice(6).split('_')[0]) >= COLS), 'countryside tiles are fetched once it opens');
  for (let n = 0; n < 40; n++) { clock += 16; await frame(p, x, y, r, drawn, `open ${n}`); await finishAll(p, `open ${n}`); }
  const opened = outside(p.cand);
  assert.ok(opened.length > 2);
  // The same box shrunk in place: its contents, not its identity, decide.
  p.both((w) => { w.country.box[2] = COLS * T - OX + T; });
  events = await frame(p, x, y, r, drawn, 'shrunk');
  assert.ok(events.some((e) => e.startsWith('drop ')), 'tiles past a shrunk box are dropped');
  assert.ok(outside(p.cand).every((k) => k.startsWith(`${COLS}_`)));
  p.both((w) => { w.country.box = null; }); // a worker failure withdraws it
  events = await frame(p, x, y, r, drawn, 'failed');
  assert.equal(outside(p.cand).length, 0, 'countryside tiles go when the countryside fails');
});

// ---- 4. Graph forgetting keeps running, and follows moving anchors ------------------
await check('graph anchors', async () => {
  const p = pair({ available: sparse(13, 1) });
  const [x, y] = centre(2, 2), r = 400, drawn = 300;
  const [ax, ay] = centre(12, 10);
  let anchor = { x: ax, y: ay };
  p.both((w) => {
    w.anchors = () => [anchor];
    for (let i = 0; i < COLS; i++) for (let j = 0; j < ROWS; j++) { w.driveBy.set(`${i}_${j}`, [`d${i}_${j}`]); w.walkBy.set(`${i}_${j}`, []); }
  });
  clock += 1100;
  let events = await frame(p, x, y, r, drawn, 'first forget');
  const forgot = events.find((e) => e.startsWith('forget '));
  assert.ok(forgot && !forgot.split(' ').includes('12_10'), 'streets round an anchor are kept');
  assert.ok(p.cand.driveBy.has('12_10'));
  anchor = { x: x + 10, y };
  for (let n = 0; n < 50; n++) { clock += 16; await frame(p, x, y, r, drawn, `waiting ${n}`); }
  clock += 1100;
  events = await frame(p, x, y, r, drawn, 'anchor moved');
  assert.ok(events.find((e) => e.startsWith('forget '))?.split(' ').includes('12_10'), 'once the anchor leaves, its streets are forgotten with the camera still');
});

// ---- 4. Prefetched photos and files are retired at a fixed view ---------------------
await check('pending photos', async () => {
  const p = pair({ available: sparse(14, 1) });
  const [x, y] = centre(3, 3), r = 400, drawn = 300;
  const disposed = { ref: [], cand: [] };
  const photo = (w, side, k) => w.photos.set(k, Promise.resolve({ dispose: () => disposed[side].push(k) }));
  for (const [side, w] of [['ref', p.ref], ['cand', p.cand]]) { photo(w, side, '3_3'); photo(w, side, '13_12'); w.pending.set('13_12', Promise.resolve({})); }
  await frame(p, x, y, r, drawn, 'photos'); await flush();
  assert.deepEqual(disposed.cand, ['13_12']); assert.deepEqual(disposed.ref, disposed.cand);
  assert.ok(p.cand.photos.has('3_3') && !p.cand.pending.has('13_12'));
  for (const [side, w] of [['ref', p.ref], ['cand', p.cand]]) photo(w, side, '14_12'); // a late prefetch, the view unchanged
  clock += 16; await frame(p, x, y, r, drawn, 'late photo'); await flush();
  assert.ok(disposed.cand.includes('14_12') && !p.cand.photos.has('14_12'), 'a photo far off is retired at an unchanged view');
});

// ---- 4. Coming back and forth between two views -------------------------------------
await check('return visits', async () => {
  const p = pair({ available: sparse(15) });
  const a = centre(4, 4), b = centre(9, 8), r = 520, drawn = 380;
  await frame(p, ...a, r, drawn, 'a');
  const before = queries(p.cand);
  for (let n = 0; n < 20; n++) {
    clock += 16;
    await frame(p, ...(n % 2 ? a : b), r, drawn, `visit ${n}`);
    await finish(p, 'makes', true, `visit ${n}`); await finish(p, 'draws', true, `visit ${n}`);
    clock += 16;
    await frame(p, ...(n % 2 ? a : b), r, drawn, `visit ${n} again`);
  }
  counts.returnVisits = { frames: 40, selection: queries(p.cand) - before };
});

// ---- How often the very same view comes again in the game ---------------------------
// main.ts: camPos.lerp(look, min(1, dt * 4)) towards the player plus a lead on their
// velocity, and the height eases towards its target (in a car it rises with speed);
// the radii follow the height. Moving at a steady speed, then standing for 2 minutes.
function camera(speed, car) {
  const dt = 1 / 60, a = Math.min(1, dt * 4), fov = 50, aspect = 16 / 9, moving = 1800, still = 7200;
  const view = (h) => h * Math.tan((fov / 2) * Math.PI / 180) * Math.hypot(1, aspect) + 15;
  let px = 1500.25, cx = px, cy = 400.75, height = car ? 120 : 100, last = null, whileMoving = 0, standing = 0, first = null;
  for (let n = 0; n < moving + still; n++) {
    const v = n < moving ? speed : 0;
    px += v * dt;
    const want = car ? 120 + v * 3.4 : 100;
    height += (want - height) * Math.min(1, dt * (want > height ? 1.6 : 0.9));
    cx += (px + v * 0.7 - cx) * a; cy += (400.75 - cy) * a;
    const key = [cx, cy, view(height) + 220, view(height) + 100].join();
    if (key === last && v) whileMoving++;
    if (key === last && !v) { standing++; first ??= n - moving; }
    last = key;
  }
  return { whileMoving, standing, of: still, first };
}
counts.camera = { car: camera(12, true), walk: camera(1.4, false) };

console.log(`Tile selection (${baseline ? 'baseline' : 'reuse'}): ${counts.selectionProbes} oracle probes;`
  + ` drive ${counts.drive?.frames} frames, ${counts.drive?.sorted} sorted + ${counts.drive?.unsorted} unsorted selection queries (${counts.drive?.forget} for forgetting);`
  + ` 60 still frames: ${counts.still60?.selection} selection queries, ${counts.still60?.made} builds and ${counts.still60?.dressed} draws dispatched;`
  + ` return visits: ${counts.returnVisits?.selection} queries in ${counts.returnVisits?.frames} frames;`
  + ` camera model: the view repeats in ${counts.camera.car.whileMoving}/1800 frames driving, ${counts.camera.walk.whileMoving}/1800 walking;`
  + ` standing, in ${counts.camera.car.standing}/${counts.camera.car.of} after a drive (from frame ${counts.camera.car.first}) and ${counts.camera.walk.standing}/${counts.camera.walk.of} after a walk (from frame ${counts.camera.walk.first});`
  + ` ${quiet} expected failure messages hidden.`);
if (failures.length) { console.log(`Failed: ${failures.join(', ')}`); process.exit(1); }
