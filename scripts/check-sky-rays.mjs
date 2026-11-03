#!/usr/bin/env node
// Compare sky-ray offsets with the original implementation, including paired CPU times.
// node scripts/check-sky-rays.mjs [--baseline b35c0ca] [--pairs 6] [--warmup 3]
// Uses real local map data; does not start a game or measure FPS/worker arrival latency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const flag = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const revision = flag('--baseline', 'b35c0ca');
const pairs = Number(flag('--pairs', 6)), warmup = Number(flag('--warmup', 3));
assert(pairs > 0 && warmup >= 1);
const baselineURL = new URL('../src/map/skyView.baseline.ts', import.meta.url).href;
const baselineSource = execFileSync('git', ['show', `${revision}:src/map/skyView.ts`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === baselineURL) return { url: baselineURL, shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = (url === baselineURL ? baselineSource : readFileSync(new URL(url), 'utf8')).replaceAll('import.meta.env', '({})');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText };
} });
globalThis.location ??= { search: '' };
const { skyView: baseline } = await import(baselineURL);
const { skyView: candidate, SKY_MARGIN, SKY_STEP } = await import('../src/map/skyView.ts');
const { decodeHeights, heightSampler } = await import('../src/terrain.ts');
const { buildBuildings } = await import('../src/map/buildings.ts');

// Independently enumerate both axis indices for every cell, direction and distance.
// At most 59 cells of displacement: even the first/last query has a cell to spare.
const reach = [1.5, 3, 4.5, 6, 8, 10, 13, 16, 20, 25, 30, 37, 45, 52, 60];
const origins = [0, 0.1, -0.1, -563.84, 180.67, -17313.84, 13069.33, 1e6 + 0.123456789, -1e6 - 0.999999999];
let indices = 0, maxOffset = 0, closestEdge = 1;
for (const origin of origins) for (const n of [2, 31, 250, 251]) {
  const w = n + 2 * SKY_MARGIN, o = origin - SKY_MARGIN;
  for (let k = 0; k < 16; k++) for (const dir of [Math.cos((k + 0.5) * 2 * Math.PI / 16), Math.sin((k + 0.5) * 2 * Math.PI / 16)]) for (const d of reach) {
    const delta = 0.5 + dir * d / SKY_STEP, offset = Math.floor(delta);
    maxOffset = Math.max(maxOffset, Math.abs(offset));
    closestEdge = Math.min(closestEdge, Math.abs(delta - Math.round(delta)));
    for (let cell = 0; cell < n; cell++) {
      const original = Math.floor((origin + (cell + 0.5) * SKY_STEP + dir * d - o) / SKY_STEP);
      const indexed = cell + SKY_MARGIN + offset;
      assert.equal(indexed, original, `origin ${origin}, n ${n}, cell ${cell}, direction ${k}, distance ${d}`);
      assert(indexed >= 0 && indexed < w);
      indices++;
    }
  }
}
console.log(JSON.stringify({ indices, origins, maxOffset, closestEdge }));

function same(a, b, label) {
  assert.equal(a.n, b.n, label);
  assert.deepEqual(a.texels, b.texels, `${label}: texels`);
  assert.equal(a.walls.length, b.walls.length, label);
  for (let i = 0; i < a.walls.length; i++) {
    assert.deepEqual(Buffer.from(a.walls[i].buffer), Buffer.from(b.walls[i].buffer), `${label}: wall bytes ${i}`);
  }
}
function digest(out) {
  const h = createHash('sha256').update(out.texels);
  for (const wall of out.walls) h.update(Buffer.from(wall.buffer));
  return h.digest('hex');
}
function meshProbes(box) {
  const p = [], normal = [], facade = [];
  for (const x of [box[0] - 2, box[0], box[0] + 0.5, box[2] - 0.5, box[2], box[2] + 2]) {
    for (const y of [box[1], (box[1] + box[3]) / 2, box[3]]) for (const h of [0, 0.3, 9, 18, 24]) {
      p.push(x, h, -y); normal.push(1, 0, 0); facade.push(0, h, 1, 0);
    }
  }
  p.push(box[0], 2, -box[1]); normal.push(0, 1, 0); facade.push(0, 2, 0, 0);
  const mesh = { position: new Float32Array(p), normal: new Float32Array(normal), facade: new Float32Array(facade) };
  return [mesh, { ...mesh, facade: null }];
}
const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
let synthetic = 0;
for (const [x, y] of [[0, 0], [-60.125, 0.375], [1e6 + 0.123456789, -1e6 - 0.999999999]]) for (const n of [2, 17, 63]) {
  const box = [x, y, x + n - 0.25, y + n - 1.25];
  const shapes = [
    { rings: [rectangle(x - 60, y - 60, 4, 120)], h: 50 },
    { rings: [rectangle(x + 1, y + 1, 10, 10), rectangle(x + 3, y + 3, 4, 4)], h: 12 },
    { rings: [rectangle(x + n + 58, y - 10, 4, n + 20)], h: 100 },
  ];
  for (const ground of [null, { box, n: 4, step: n / 3, hm: Float32Array.from({ length: 16 }, (_, i) => i === 9 ? NaN : (i % 4) * 0.7 + Math.floor(i / 4) * 3) }]) {
    const job = { box, ground, shapes, meshes: meshProbes(box) };
    same(baseline(job), candidate(job), `synthetic ${synthetic++}`);
  }
}
console.log(`${synthetic} synthetic jobs: byte-identical texels and wall factors (holes, margin edges, terrain NaNs, facade and terrain-based heights).`);

const root = new URL('../public/data/praha_now/', import.meta.url);
const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
const tile = (key) => JSON.parse(readFileSync(new URL(`tiles/${key}.json`, root), 'utf8'));
const cases = [];
for (const key of ['67_53', '66_51', '63_53', '70_59', '55_56', '86_65']) {
  const t = tile(key), [i, j] = key.split('_').map(Number), shapes = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    // Include the whole halo in both versions; shadower filtering is a separate experiment.
    for (const b of tile(`${i + di}_${j + dj}`).buildings) if ((b.minh ?? 0) < 3) shapes.push({ rings: b.rings, h: b.h });
  }
  const raw = gunzipSync(readFileSync(new URL(`tiles/${key}.height.bin.gz`, root)));
  const ground = { box: t.box, n: index.terrain.n, step: index.terrain.step,
    hm: decodeHeights(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), index.terrain.n, 200) };
  const terrain = heightSampler(ground.hm, ground.box, ground.n, ground.step);
  const meshes = meshProbes(t.box);
  // Actual extruded building vertices/normals, lifted by each outline's lowest ground.
  for (const b of t.buildings) {
    const built = buildBuildings({ buildings: [b], size: [index.tile, index.tile], origin: [-t.box[0], -t.box[1]], areas: t.areas });
    const base = Math.min(...b.rings[0].map(([x, y]) => terrain(x, y)));
    const g = built.mesh.geometry, position = g.attributes.position.array;
    for (let v = 1; v < position.length; v += 3) position[v] += base;
    meshes.push({ position, normal: g.attributes.normal.array, facade: null });
    g.dispose(); built.mesh.material.dispose();
  }
  const job = { box: t.box, ground, shapes, meshes };
  const a = baseline(job), b = candidate(job); same(a, b, key);
  const counts = { key, box: t.box, n: a.n, terrainSamples: ground.hm.length, shapes: shapes.length,
    rings: shapes.reduce((n, s) => n + s.rings.length, 0), vertices: meshes.reduce((n, m) => n + m.position.length / 3, 0),
    darkTexels: a.texels.reduce((n, v) => n + (v < 255 ? 1 : 0), 0), sha256: digest(a) };
  console.log(JSON.stringify({ ...counts, equal: true }));
  cases.push({ key, job });
}
for (let w = 0; w < warmup; w++) for (const { job } of cases) { baseline(job); candidate(job); }
const rows = [];
for (let pair = 0; pair < pairs; pair++) {
  const row = { pair: pair + 1, order: pair % 2 ? 'candidate/baseline' : 'baseline/candidate', tiles: [] };
  for (const { key, job } of cases) {
    const timing = {};
    for (const name of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const cpuBefore = process.cpuUsage();
      const before = performance.now();
      (name === 'baseline' ? baseline : candidate)(job);
      timing[name] = performance.now() - before;
      const cpu = process.cpuUsage(cpuBefore);
      timing[`${name}CPU`] = (cpu.user + cpu.system) / 1000;
    }
    row.tiles.push({ key, ...timing });
  }
  row.baseline = row.tiles.reduce((sum, t) => sum + t.baseline, 0);
  row.candidate = row.tiles.reduce((sum, t) => sum + t.candidate, 0);
  row.baselineCPU = row.tiles.reduce((sum, t) => sum + t.baselineCPU, 0);
  row.candidateCPU = row.tiles.reduce((sum, t) => sum + t.candidateCPU, 0);
  rows.push(row); console.log(JSON.stringify(row));
}
const mean = (name) => rows.reduce((sum, row) => sum + row[name], 0) / rows.length;
console.log(JSON.stringify({ baseline: revision, warmup, pairs, totalBaselineMs: mean('baseline'), totalCandidateMs: mean('candidate'),
  totalBaselineCPUMs: mean('baselineCPU'), totalCandidateCPUMs: mean('candidateCPU'),
  reductionPercent: 100 * (1 - mean('candidate') / mean('baseline')), node: process.version, arch: process.arch }));
