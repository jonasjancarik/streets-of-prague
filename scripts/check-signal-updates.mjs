#!/usr/bin/env node
// Traffic lights' per-frame buffers (Signals.update in src/signals.ts): what they show
// must match the original writer's arrays every frame, every change must reach the GPU
// through the dirty ranges even when several updates come before one render, and
// unchanged lights must leave the buffers alone. Production class, fake signals.json,
// real three.js attributes, and a stand-in for the renderer's uploads.
//   node scripts/check-signal-updates.mjs              the optimized code: no marks while nothing changes
//   node scripts/check-signal-updates.mjs --baseline   the original code: every buffer marked every frame
//   node scripts/check-signal-updates.mjs --url http://localhost:5191/   the live game, WebGPU and WebGL
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const baseline = process.argv.includes('--baseline');
const url = option('--url');

// The original display writer, kept here as the oracle: what Signals.update wrote
// before it learnt to skip unchanged lights. Fills fresh arrays from the live roster
// and the static matrices gather() wrote.
const ORACLE = `(THREE, light, LAMP_ON, s) => {
  const GREEN = 0, AMBER = 1, RED = 2, READY = 3;
  const COLOURS = [new THREE.Color('#22ff88'), new THREE.Color('#ffae00'), new THREE.Color('#ff2414')];
  const OFF = [new THREE.Color('#0c1a12'), new THREE.Color('#1c150a'), new THREE.Color('#1e0c0a')];
  const n = s.near.length, cars = s.cars, t = s.time();
  const out = { glowM: new Float32Array(n * 16), glowC: new Float32Array(n * 3), beamC: new Float32Array(cars * 3), lampC: new Float32Array(cars * 9), walkC: new Float32Array((n - cars) * 6) };
  const d = new THREE.Object3D(), m = new THREE.Matrix4(), c = new THREE.Color();
  s.near.forEach((h, i) => {
    if (h.walk) {
      const w = i - cars, go = light(h.sig, t) === GREEN;
      (go ? OFF[2] : COLOURS[2]).toArray(out.walkC, w * 6);
      (go ? COLOURS[0] : OFF[0]).toArray(out.walkC, w * 6 + 3);
      s.walkLamps.getMatrixAt(w * 2 + (go ? 1 : 0), m);
      d.position.setFromMatrixPosition(m);
      d.position.y += 0.2;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(1.6);
      d.updateMatrix();
      d.matrix.toArray(out.glowM, i * 16);
      c.copy(COLOURS[go ? 0 : 2]).toArray(out.glowC, i * 3);
      return;
    }
    const show = light(h.sig, t);
    const on = [show === RED || show === READY, show === AMBER || show === READY, show === GREEN];
    for (let k = 0; k < 3; k++) (on[k] ? COLOURS[2 - k] : OFF[2 - k]).toArray(out.lampC, (i * 3 + k) * 3);
    const k = on[2] ? 2 : on[1] ? 1 : 0;
    s.lamps.getMatrixAt(i * 3 + k, m);
    d.position.setFromMatrixPosition(m);
    d.position.y += 0.2;
    d.rotation.set(0, 0, 0);
    d.scale.setScalar(2.6);
    d.updateMatrix();
    d.matrix.toArray(out.glowM, i * 16);
    c.copy(COLOURS[2 - k]).toArray(out.glowC, i * 3);
    c.copy(COLOURS[2 - k]).multiplyScalar(0.22 + 0.3 * LAMP_ON.value).toArray(out.beamC, i * 3);
  });
  return out;
}`;

if (url) {
  // In the running game: hold the clock and the night's brightness, update the lights
  // round the view and render, then compare with the oracle, on WebGPU and on WebGL.
  const checks = `(async () => {
    const d = window.__drive, s = d.traffic.signals, r = d.renderer;
    const loadedModule = (path) => performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === path).at(-1)?.name || path;
    const { light } = await import(loadedModule('/src/signals.ts'));
    const { LAMP_ON } = await import(loadedModule('/src/lamps.ts'));
    const THREE = await import(loadedModule('/node_modules/.vite/deps/three.js'));
    const oracle = (${ORACLE});
    const assert = (ok, message) => { if (!ok) throw new Error(message); };
    const views = [[s.glows.instanceMatrix, 'glowM'], [s.glows.instanceColor, 'glowC'], [s.beams.instanceColor, 'beamC'], [s.lamps.instanceColor, 'lampC'], [s.walkLamps.instanceColor, 'walkC']];
    const report = [];
    for (const [t, on] of [[d.clock.t, LAMP_ON.value], [d.clock.t + 7, 1], [d.clock.t + 31, 0]]) {
      d.clock.t = t; LAMP_ON.value = on;
      const x = d.camera.position.x, y = -d.camera.position.z, now = performance.now();
      for (let i = 0; i < 2; i++) s.update(x, y, 400, now);
      r.render(d.scene, d.camera);
      const want = oracle(THREE, light, LAMP_ON, s);
      for (const [attr, key] of views) {
        const a = attr.array, b = want[key];
        for (let i = 0; i < b.length; i++) assert(a[i] === b[i], key + ' differs at ' + i + ' (t ' + t + ')');
      }
      const lit = [0, 0, 0];
      for (let i = 0; i < s.cars; i++) lit[light(s.near[i].sig, s.time()) === 0 ? 0 : light(s.near[i].sig, s.time()) === 1 ? 1 : 2]++;
      report.push('t ' + t.toFixed(1) + ', brightness ' + on + ': ' + s.cars + ' road heads (' + lit.join('/') + ' green/amber/red), ' + (s.near.length - s.cars) + ' crossing heads, ' + s.glows.count + ' glows');
    }
    report.push(r.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL');
    return report.join('\\n');
  })()`;
  for (const extra of ['', '&renderer=webgl&dev']) {
    const args = ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1', '--graphics', 'high', '--time', '14:00', '--weather', 'clear', '--fresh-browser', '--loading-frames', '--extra', extra, '--eval', checks, '--stack'];
    if (!extra) args.push('--require-webgpu');
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
  }
  process.exit(0);
}

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
const { Signals, light } = await import('../src/signals.ts');
const { LAMP_ON } = await import('../src/lamps.ts');
const oracle = eval(ORACLE);

// A Signals with the given signals.json, its clock in `clock.t`.
async function make(json) {
  const clock = { t: 0 };
  globalThis.fetch = async () => ({ ok: true, json: async () => json });
  const s = new Signals(new THREE.Scene(), 'test', () => clock.t, () => 0);
  for (let i = 0; i < 10 && !s.loaded; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(s.loaded, 'fixture loaded');
  return { s, clock };
}
const edge = (id, x, y) => ({ id, pts: [[x - 30, y], [x, y]], width: 6 });

// The five buffers update writes, with how much of each is drawn.
const dynamic = (s) => [
  ['glow matrices', s.glows.instanceMatrix, 'glowM', s.glows.count * 16],
  ['glow colours', s.glows.instanceColor, 'glowC', s.glows.count * 3],
  ['beam colours', s.beams.instanceColor, 'beamC', s.beams.count * 3],
  ['lamp colours', s.lamps.instanceColor, 'lampC', s.lamps.count * 3],
  ['crossing lamp colours', s.walkLamps.instanceColor, 'walkC', s.walkLamps.count * 3],
];
const versions = (s) => dynamic(s).map(([, a]) => a.version);

// The renderer's side, as three.js does it (WebGLAttributes / WebGPUAttributeUtils):
// a buffer is sent when drawn and its version moved, whole without update ranges,
// else range by range, and the ranges are cleared once sent.
const stats = { marks: 0, floats: 0 };
function render(s, gpu, want) {
  for (const [name, attr, key, live] of dynamic(s)) {
    if (!live) continue; // an empty mesh isn't drawn: its pending ranges wait
    let g = gpu.get(attr);
    if (!g) { gpu.set(attr, g = { array: attr.array.slice(), version: attr.version }); attr.clearUpdateRanges(); }
    else if (g.version !== attr.version) {
      if (!attr.updateRanges.length) { g.array.set(attr.array); stats.floats += attr.array.length; }
      for (const r of attr.updateRanges) { g.array.set(attr.array.subarray(r.start, r.start + r.count), r.start); stats.floats += r.count; }
      attr.clearUpdateRanges();
      g.version = attr.version;
    }
    const b = want[key];
    assert.equal(b.length, live, `${name}: live length`);
    for (let i = 0; i < live; i++) if (g.array[i] !== b[i]) assert.fail(`${name}: the GPU's copy is stale at ${i} (t ${s.time()})`);
  }
}

// One frame: update, compare the CPU arrays with the oracle, and render unless deferred.
function frame(s, gpu, view, draw = true) {
  const before = versions(s);
  s.update(view.x, view.y, view.r, view.now);
  const want = oracle(THREE, light, LAMP_ON, s);
  assert.equal(s.glows.count, s.near.length); assert.equal(s.beams.count, s.cars);
  assert.equal(s.lamps.count, s.cars * 3); assert.equal(s.walkLamps.count, (s.near.length - s.cars) * 2);
  for (const [name, attr, key, live] of dynamic(s)) {
    const a = attr.array, b = want[key];
    for (let i = 0; i < live; i++) if (a[i] !== b[i]) assert.fail(`${name}: differs from the original at ${i} (t ${s.time()})`);
  }
  versions(s).forEach((v, i) => { stats.marks += v - before[i]; });
  if (draw) render(s, gpu, want);
  return want;
}

// --- Two heads, nothing changing: 60 frames ---
{
  const { s, clock } = await make({ junctions: [[20, 15, 0]], edges: { a: [5, 0, 0, 0, 3] }, walk: { a: [0, 1, 4, 6, 90] } });
  s.add([edge('a', 0, 0)]);
  const gpu = new Map(), view = { x: 0, y: 0, r: 100, now: 1000 };
  clock.t = 4; LAMP_ON.value = 0.4;
  frame(s, gpu, view);
  assert.equal(s.cars, 1); assert.equal(s.near.length, 2);
  const start = versions(s), arrays = dynamic(s).map(([, a]) => a.array.slice());
  for (let i = 0; i < 60; i++) frame(s, gpu, view);
  const deltas = versions(s).map((v, i) => v - start[i]);
  dynamic(s).forEach(([name, a], i) => assert.deepEqual(a.array, arrays[i], `${name} unchanged`));
  assert.deepEqual(deltas, Array(5).fill(baseline ? 60 : 0), `version deltas over 60 unchanged frames (${deltas.join(', ')})`);
  console.log(`Two heads, 60 unchanged frames: version deltas ${dynamic(s).map(([name], i) => `${name} ${deltas[i]}`).join(', ')}.`);
}

// --- Many junctions: transitions, clock jumps, brightness, roster changes ---
const junctions = [], edges = {}, walk = {};
for (let j = 0; j < 12; j++) junctions.push([15 + j * 3, 12 + (j % 5) * 4, j * 7.3]);
let ids = 0;
const place = (n, x0, y0, walks = true) => {
  const list = [];
  for (let i = 0; i < n; i++) {
    const id = `e${ids++}`, j = ids % junctions.length, x = x0 + (i % 30) * 4, y = y0 + Math.floor(i / 30) * 4;
    edges[id] = [5, j, ids % 2, x, y];
    if (walks && i % 3 === 0) walk[id] = [j, (ids + 1) % 2, x + 1, y + 1, 45, (j + 1) % junctions.length, ids % 2, x - 1, y - 1, 225];
    list.push(edge(id, x, y));
  }
  return list;
};
const town = place(60, 0, 0), extra = place(12, 20, 40), crowd = place(900, 2000, 0, false);
const crowdWalks = place(30, 2000, 200);
{
  const { s, clock } = await make({ junctions, edges, walk });
  const gpu = new Map(), view = { x: 50, y: 10, r: 120, now: 0 };
  s.add(town);
  clock.t = 0; LAMP_ON.value = 0;
  frame(s, gpu, view);
  const heads = s.near.length;
  assert.ok(s.cars > 20 && heads > s.cars, 'road and crossing heads round the view');

  // Every phase, stepping through two full cycles of the longest junction.
  const seen = new Set();
  for (let t = 0; t < 2 * (51 + 10); t += 0.25) {
    clock.t = t; frame(s, gpu, view);
    for (let i = 0; i < s.cars; i++) seen.add(light(s.near[i].sig, t));
  }
  assert.equal(seen.size, 4, 'saw green, amber, red, and red with amber');

  // Exactly on each junction's phase edges, and either side of them.
  for (const [g0, g1, offset] of junctions) {
    const cycle = g0 + g1 + 10;
    for (const start of [0, g0 + 5]) {
      const green = start ? g1 : g0;
      for (const k of [0, green, green + 3, cycle - 1.5]) {
        for (const e of [-1e-6, 0, 1e-6]) { clock.t = 3 * cycle + start + k - offset + e; frame(s, gpu, view); }
      }
    }
  }

  // The clock jumping back and forth, and running fast (a ride, a skipped night).
  for (const t of [5000, 12, 11.9, 86400 * 3 + 0.5, 0, 77.7]) { clock.t = t; frame(s, gpu, view); }
  for (let i = 0; i < 300; i++) { clock.t += 7.3; frame(s, gpu, view); }

  // Brightness changing with the phases held: only the beams change.
  clock.t = 33; frame(s, gpu, view);
  for (const on of [0.25, 0.25, 0.9, 1, 0, 0]) {
    const before = versions(s), was = LAMP_ON.value;
    LAMP_ON.value = on; frame(s, gpu, view);
    const moved = versions(s).map((v, i) => v - before[i]);
    if (!baseline) assert.deepEqual(moved, [0, 0, on === was ? 0 : 1, 0, 0], 'brightness alone marks only the beams, once');
  }

  // Several updates before one render, the lights changing in different slots in each.
  for (let i = 0; i < 400; i++) { clock.t += 0.37; LAMP_ON.value = (i % 50) / 49; frame(s, gpu, view, i % 4 === 3); }
  frame(s, gpu, view);

  // The camera moving and zooming, and the three-second regather.
  for (const [dx, r] of [[30, 120], [30, 60], [0, 200], [-60, 120], [0, 120]]) {
    view.x += dx; view.r = r; view.now += 100; clock.t += 0.5; frame(s, gpu, view);
  }
  view.now += 3500; frame(s, gpu, view);
  view.now += 3500; clock.t += 20; frame(s, gpu, view, false); clock.t += 3; frame(s, gpu, view);

  // Nobody round the view, then back: nothing drawn, then all of it right again.
  const home = { ...view };
  Object.assign(view, { x: -5000, y: -5000, now: view.now + 100 });
  frame(s, gpu, view); assert.equal(s.near.length, 0);
  clock.t += 40; frame(s, gpu, view);
  Object.assign(view, home, { now: view.now + 100 }); frame(s, gpu, view);
  assert.equal(s.near.length, heads);

  // Streets arriving and leaving; the same number of lights in other slots.
  s.add(extra); clock.t += 1; frame(s, gpu, view);
  assert.ok(s.near.length > heads);
  s.forget(extra); frame(s, gpu, view, false); clock.t += 4; frame(s, gpu, view);
  assert.equal(s.near.length, heads);
  const order = s.near.map((h) => h.e.id).join();
  s.forget(town.slice(0, 9)); s.add(town.slice(0, 9)); frame(s, gpu, view);
  assert.equal(s.near.length, heads); assert.notEqual(s.near.map((h) => h.e.id).join(), order, 'same lights, other slots');
  for (let i = 0; i < 20; i++) { clock.t += 1.7; frame(s, gpu, view, i % 2 === 1); }

  // More heads than MAX_HEADS round the view: the road heads fill it, the crossings drop out.
  s.add(crowd); s.add(crowdWalks);
  Object.assign(view, { x: 2060, y: 100, r: 300, now: view.now + 100 });
  frame(s, gpu, view);
  assert.equal(s.near.length, 800); assert.equal(s.cars, 800);
  for (let i = 0; i < 60; i++) { clock.t += 0.9; frame(s, gpu, view, i % 3 === 0); }
  Object.assign(view, { x: 2060, y: 250, r: 80, now: view.now + 100 });
  frame(s, gpu, view); assert.ok(s.near.length > s.cars, 'crossings back below the cap');
  for (let i = 0; i < 30; i++) { clock.t += 0.9; frame(s, gpu, view, i % 2 === 0); }
  frame(s, gpu, view);
}

// --- Two lights changing in two updates before one render ---
{
  const { s, clock } = await make({ junctions: [[10, 10, 0], [10, 10, -1], [30, 30, 0]], edges: { a: [5, 0, 0, 0, 0], f1: [5, 2, 0, 4, 0], f2: [5, 2, 0, 8, 0], f3: [5, 2, 0, 12, 0], b: [5, 1, 0, 16, 0] } });
  s.add(['a', 'f1', 'f2', 'f3', 'b'].map((id, i) => edge(id, i * 4, 0)));
  const gpu = new Map(), view = { x: 8, y: 0, r: 50, now: 0 };
  clock.t = 9.5; frame(s, gpu, view);
  assert.deepEqual(s.near.map((h) => h.e.id), ['a', 'f1', 'f2', 'f3', 'b']);
  assert.deepEqual(s.near.map((h) => light(h.sig, 9.5)), [0, 0, 0, 0, 0]);
  clock.t = 10.5; frame(s, gpu, view, false); // the first changes
  assert.deepEqual(s.near.map((h) => light(h.sig, 10.5)), [1, 0, 0, 0, 0]);
  clock.t = 11.5; const before = versions(s); frame(s, gpu, view); // then the last, and one render
  assert.deepEqual(s.near.map((h) => light(h.sig, 11.5)), [1, 0, 0, 0, 1]);
  if (!baseline) assert.ok(versions(s).every((v, i) => v - before[i] <= 1), 'one mark a frame at most');
}

console.log(`Signal updates passed (${baseline ? 'baseline' : 'optimized'}): every frame matches the original writer, and the GPU's copies stay current through deferred renders. Over the whole run ${stats.marks} buffer marks, ${stats.floats} floats sent.`);
