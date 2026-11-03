#!/usr/bin/env node
// Building inputs keep their renderer buffers while queued sky jobs clone them once.
//   node scripts/check-sky-copy.mjs
// Optional local IPR input: --map centrum_now --tiles 0_0,7_4,16_6
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '?go' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
if (!isMainThread) {
  // Run the production browser-worker handler with Node's real structured clone
  // and transfer operations. Report ownership after its postMessage has returned.
  let output;
  globalThis.postMessage = (message, transfer = []) => {
    const bytes = transfer.reduce((n, buffer) => n + buffer.byteLength, 0);
    parentPort.postMessage(message, transfer);
    output = { bytes, detached: transfer.every((buffer) => buffer.byteLength === 0) };
  };
  await import('../src/tileWorker.ts');
  parentPort.on('message', async (message) => {
    const before = message.type === 'sky' ? structuredClone(message.data) : null;
    await globalThis.onmessage({ data: message });
    if (before) {
      assert.deepEqual(message.data, before, 'production sky handler does not mutate inputs');
      // This mutation must stay in the worker's cloned input.
      if (message.data.meshes.length) message.data.meshes[0].position[0] += 100;
    }
    parentPort.postMessage({ audit: message.id, ...output });
  });
} else {
const { TileWorld } = await import('../src/tiles.ts');
const { TileWorkers } = await import('../src/tileWorkers.ts');
const { skyView } = await import('../src/map/skyView.ts');

const names = ['position', 'normal', 'facade'];
function building(x) {
  return {
    position: new Float32Array([x, 0, -1, x + 1, 0, -1, x, 1, -1]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    facade: new Float32Array([0, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1]),
    color: new Float32Array(9).fill(0.5),
  };
}

let copies = 0, copiedBytes = 0, vertices = 0;
async function check(mode) {
  const meshes = mode === 'empty' ? [] : [building(1), building(2)];
  vertices += meshes.reduce((n, a) => n + a.position.length / 3, 0);
  const inputs = new Set(meshes.flatMap((a) => names.map((name) => a[name])));
  const before = structuredClone(meshes);
  const unchanged = () => {
    assert.deepEqual(meshes, before, `${mode}: renderer arrays remain unchanged and attached`);
    for (const a of meshes) for (const name of names) assert.ok(a[name].byteLength > 0);
  };
  const posts = [];
  let endpoint;
  const workers = new TileWorkers(1, () => endpoint = {
    onmessage: null, onerror: null, onmessageerror: null, terminate() {},
    postMessage(message, transfer) {
      // Real workers clone even with an empty transfer list. Keep this fixture faithful.
      const cloned = structuredClone(message, { transfer });
      posts.push({ original: message, cloned, transfer });
    },
  });
  const empty = { box: [0, 0, 4, 4], ground: null, shapes: [], meshes: [] };
  const blocker = workers.run('sky', empty);
  const tile = { k: '0_0', i: 0, j: 0, shown: true,
    source: { t: { i: 0, j: 0, box: empty.box }, marks: [], ground: null, shapes: [] } };
  const world = Object.assign(Object.create(TileWorld.prototype), {
    workers, loaded: new Map([[tile.k, tile]]), landmarkModels: new Map(), sky: new Map(),
    neighbourCount: () => 0, shadowersFor: () => [],
  });
  const slice = Float32Array.prototype.slice;
  const warn = console.warn, warnings = [];
  Float32Array.prototype.slice = function(...args) {
    const result = slice.apply(this, args);
    if (inputs.has(this)) { copies++; copiedBytes += result.byteLength; }
    return result;
  };
  console.warn = (...args) => warnings.push(args);
  try {
    const assembly = world.assemble(tile, Promise.resolve([{ layers: [] }, meshes[0] ?? null, meshes[1] ?? null]));
    await new Promise(setImmediate);
    assert.equal(workers.counts.queuedRequired, 1, `${mode}: production assembly queued behind a busy worker`);
    assert.equal(posts.length, 1, 'sky inputs have not been dispatched yet');
    unchanged();
    const replacement = { shown: true };
    if (mode === 'retired') {
      tile.shown = false;
      world.loaded.set(tile.k, replacement);
    }
    endpoint.onmessage({ data: { id: posts[0].cloned.id, result: skyView(empty) } });
    await blocker;
    assert.equal(posts.length, 2, `${mode}: queued sky job dispatches after blocker finishes`);
    const { original, cloned, transfer } = posts[1];
    assert.deepEqual(transfer, [], 'renderer input buffers must never be transferred');
    assert.equal(cloned.data.meshes.length, meshes.length, 'both IPR and roof meshes reach the worker');
    for (let i = 0; i < meshes.length; i++) for (const name of names) {
      assert.notEqual(cloned.data.meshes[i][name].buffer, original.data.meshes[i][name].buffer,
        'worker owns an independent structured clone');
      assert.notEqual(cloned.data.meshes[i][name].buffer, meshes[i][name].buffer);
      assert.deepEqual(cloned.data.meshes[i][name], before[i][name]);
    }
    unchanged(); // Includes the full queue wait and dispatch.
    const workerBefore = structuredClone(cloned.data);
    const result = skyView(cloned.data);
    assert.deepEqual(cloned.data, workerBefore, 'skyView reads its input without mutation');
    assert.deepEqual(result, skyView({ ...empty, meshes }), 'sky output matches the original renderer arrays');
    // Even a worker-side mutation must not affect the later renderer input.
    if (meshes.length) cloned.data.meshes[0].position[0] += 100;
    unchanged();
    // Stop the real assembly at its existing retirement guard, before any GPU work.
    tile.shown = false;
    endpoint.onmessage({ data: mode === 'failure'
      ? { id: cloned.id, error: 'controlled sky failure' } : { id: cloned.id, result } });
    await assembly;
    assert.equal(warnings.length, mode === 'failure' ? 1 : 0);
    if (mode === 'failure') assert.match(String(warnings[0][1]), /controlled sky failure/);
    assert.equal(tile.drawMs.meshes, undefined, 'retired tile does not build or insert meshes');
    if (mode === 'retired') {
      assert.equal(world.loaded.get(tile.k), replacement, 'old assembly leaves the replacement tile alone');
      assert.equal(replacement.shown, true);
    }
    unchanged();
    assert.equal(workers.counts.queuedRequired, 0);
    assert.equal(workers.counts.runningRequired, 0);
  } finally {
    Float32Array.prototype.slice = slice;
    console.warn = warn;
  }
}

for (const mode of ['success', 'empty', 'retired', 'failure']) await check(mode);
// Exercise the actual worker handler too, including its result transfer list.
const thread = new Worker(new URL(import.meta.url));
const posts = new Map();
let endpoint;
const workers = new TileWorkers(1, () => endpoint = {
  onmessage: null, onerror: null, onmessageerror: null,
  terminate() { void thread.terminate(); },
  postMessage(message, transfer) {
    let audited;
    const audit = new Promise((resolve) => { audited = resolve; });
    posts.set(message.id, { message, transfer: [...transfer], audit, audited });
    thread.postMessage(message, transfer);
  },
});
thread.on('message', (message) => {
  if ('audit' in message) posts.get(message.audit).audited(message);
  else endpoint.onmessage({ data: message });
});
thread.on('error', (error) => { throw error; });
async function actual(meshes, box, ground, shapes, label) {
  const before = structuredClone(meshes), job = { box, ground, shapes,
    meshes: meshes.map((a) => Object.fromEntries(names.map((name) => [name, a[name]]))) };
  const baseline = await workers.run('sky', { ...job, meshes: job.meshes.map((a) =>
    Object.fromEntries(names.map((name) => [name, a[name].slice()]))) });
  const result = await workers.run('sky', job), posted = [...posts.values()].at(-1);
  const audit = await posted.audit;
  assert.deepEqual(posted.transfer, [], 'no renderer input is transferred');
  assert.deepEqual(meshes, before, 'real worker dispatch leaves every renderer array attached and unchanged');
  assert.deepEqual(result, baseline, 'production worker output equals the sliced-input baseline');
  assert.deepEqual(result, skyView(job), 'production worker output equals direct computation');
  assert.equal(audit.detached, true, 'production worker transfers its output buffers');
  assert.equal(audit.bytes, result.texels.byteLength + result.walls.reduce((n, a) => n + a.byteLength, 0));
  const bytes = meshes.reduce((n, a) => n + names.reduce((n, name) => n + a[name].byteLength, 0), 0);
  const count = meshes.reduce((n, a) => n + a.position.length / 3, 0);
  assert.equal(bytes, count * 40);
  console.log(`${label}: ${count} vertices, ${bytes} redundant slice bytes removed; ${bytes} mesh bytes still cloned, ${audit.bytes} result bytes transferred; identical sky output.`);
}
try {
  await actual([building(1), building(2)], [0, 0, 4, 4], null, [], 'Real worker fixture');
  await actual([], [0, 0, 4, 4], null, [], 'Real worker empty input');
  const args = process.argv.slice(2), flag = (name) => args[args.indexOf(name) + 1];
  if (args.includes('--map')) {
    const root = new URL(`../public/data/${flag('--map')}/`, import.meta.url);
    const index = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
    const { decodeHeights } = await import('../src/terrain.ts');
    for (const key of (args.includes('--tiles') ? flag('--tiles') : '0_0,7_4,16_6').split(',')) {
      const t = JSON.parse(readFileSync(new URL(`tiles/${key}.json`, root), 'utf8'));
      const binary = (kind) => Uint8Array.from(gunzipSync(readFileSync(new URL(`tiles/${key}.${kind}.bin.gz`, root)))).buffer;
      const ground = { hm: decodeHeights(binary('height'), index.terrain.n, index.iprRef),
        box: t.box, n: index.terrain.n, step: index.terrain.step };
      const ipr = await workers.run('ipr', { buffer: binary('ipr'), box: t.box, absolute: true,
        ground, bbox: index.bbox_wgs84, hide: [], clutter: true, footprints: [] });
      await actual([ipr], t.box, ground, t.buildings.map(({ rings, h }) => ({ rings, h })), `${flag('--map')}/${key}`);
    }
  }
} finally { await thread.terminate(); }
// Keep this last: the baseline must pass all ownership/result checks and fail only
// because it copies the inputs before structured cloning them again.
assert.equal(copies, 0, `sky payload makes no explicit input slices (observed ${copies}, ${copiedBytes} bytes)`);
console.log(`Sky copies: four queued assembly cases passed; ${vertices} building vertices, ${copies} input slices, ${copiedBytes} bytes copied before dispatch. No GPU or frame-rate measurement.`);
}
