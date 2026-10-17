#!/usr/bin/env node
// Exercise the production startup flow with controlled imports, promises and timers.
// No browser, WebGL context or GPU is created.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

let source = ts.transpileModule(await readFile(new URL('../src/renderer.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
// Substitute dependency loading only; startup, timeout and cleanup control flow stays intact.
source = source.replace(/^import .*;\n/gm, '').replace('export async function createGameRenderer', 'async function createGameRenderer');
for (const [specifier, loader] of [['three/webgpu', 'loadLibrary'], ['./webgpu.ts', 'loadPorts']]) {
  const token = `import('${specifier}')`;
  assert.ok(source.includes(token), `startup still loads ${specifier}`);
  source = source.replace(token, `${loader}()`);
}
const load = new Function('THREE', 'telemetry', 'navigator', 'document', 'performance', 'requestAnimationFrame',
  'setTimeout', 'clearTimeout', 'loadLibrary', 'loadPorts', 'console', `${source}\nreturn createGameRenderer;`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); await new Promise(setImmediate); };
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);

function fixture(options = {}) {
  const timers = new Map(), listeners = new Set(), frames = new Map(), errors = [], count = { legacy: 0, gpu: 0, disposed: 0, modules: 0, ports: 0 };
  let next = 0, now = 0, configured = 0, frameId = 0;
  const document = { hidden: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn), hasFocus: () => true };
  const frame = () => { const queued = [...frames.values()]; frames.clear(); for (const fn of queued) fn(); };
  class WebGLRenderer {
    constructor() { count.legacy++; if (options.legacyThrows) throw new Error('WebGL unavailable'); }
    getContext() { return { getExtension: () => null }; }
  }
  class WebGPURenderer {
    constructor() { count.gpu++; }
    init() { return options.init?.promise ?? Promise.resolve(); }
    dispose() { count.disposed++; return options.dispose?.() ?? Promise.resolve(); }
  }
  const library = { WebGPURenderer };
  const ports = { configureRenderer(renderer) {
    configured++;
    options.onConfigure?.();
    if (options.configureThrows) throw options.configureThrows;
    return renderer;
  } };
  const create = load({ WebGLRenderer }, { setGpu() {}, error(...args) { errors.push(args); } },
    options.noGpu ? {} : { gpu: { requestAdapter: () => options.adapter?.promise ?? Promise.resolve({}) } },
    document,
    { now: () => now }, fn => { frames.set(++frameId, fn); return frameId; },
    (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, id => timers.delete(id),
    () => { count.modules++; return options.module?.promise ?? Promise.resolve(library); },
    () => { count.ports++; return options.ports?.promise ?? Promise.resolve(ports); },
    { info() {}, warn() {} });
  return {
    count, errors, library, ports, timers, listeners, frame, get configured() { return configured; }, start: query => create(new URLSearchParams(query)),
    visibility(hidden) { document.hidden = hidden; for (const fn of listeners) fn(); },
    fire(ms) {
      const timer = [...timers].find(([, item]) => item.ms === ms);
      assert.ok(timer, `startup has a ${ms} ms timeout`);
      timers.delete(timer[0]); now += ms; timer[1].fn();
    },
    stopped() {
      assert.equal(timers.size, 0, 'settled startup clears its timeouts');
      assert.equal(listeners.size, 0, 'settled startup removes visibility tracking');
      const scheduled = frameId;
      frame();
      assert.equal(frameId, scheduled, 'a stopped watcher never schedules another animation frame');
      assert.equal(frames.size, 0, 'a queued final callback becomes inert after startup stops');
    },
  };
}

const failures = [];
let checked = 0;
const check = async (name, run) => {
  try { await run(); checked++; }
  catch (error) { failures.push(`${name}: ${error.stack}`); }
};

try {
  await check('explicit WebGL bypasses all GPU setup', async () => {
    const f = fixture(); await f.start('renderer=webgl');
    assert.deepEqual(f.count, { legacy: 1, gpu: 0, disposed: 0, modules: 0, ports: 0 }); f.stopped();
  });
  await check('missing GPU uses one legacy renderer', async () => {
    const f = fixture({ noGpu: true }); await f.start();
    assert.equal(f.count.legacy, 1); assert.equal(f.count.modules, 0); f.stopped();
  });
  await check('a null adapter does not retry failed legacy startup', async () => {
    const adapter = deferred(), f = fixture({ adapter, legacyThrows: true });
    const startup = f.start(); adapter.resolve(null);
    await assert.rejects(startup, /WebGL unavailable/);
    assert.equal(f.count.legacy, 1); assert.equal(f.errors.length, 0, 'WebGL failure is not mislabeled as WebGPU failure'); f.stopped();
  });
  await check('adapter timeout falls back and ignores a late adapter', async () => {
    const adapter = deferred(), f = fixture({ adapter }), startup = f.start();
    await flush(); f.fire(5000); await startup;
    adapter.resolve({}); await flush();
    assert.equal(f.count.legacy, 1); assert.equal(f.count.modules, 0); assert.match(f.errors[0][2], /stage adapter/); f.stopped();
  });
  await check('adapter rejection falls back once', async () => {
    const adapter = deferred(), f = fixture({ adapter }), startup = f.start();
    adapter.reject(new Error('adapter refused')); await startup;
    assert.equal(f.count.legacy, 1); assert.match(f.errors[0][1].message, /adapter refused/); f.stopped();
  });
  await check('module timeout falls back without creating a late renderer', async () => {
    const module = deferred(), f = fixture({ module }), startup = f.start();
    try {
      await flush(); f.fire(15000); await startup;
      assert.equal(f.count.legacy, 1); assert.match(f.errors[0][2], /stage module/);
    } finally { module.resolve(f.library); await startup; await flush(); }
    assert.equal(f.count.gpu, 0); assert.equal(f.count.ports, 0); f.stopped();
  });
  await check('module rejection falls back before material ports load', async () => {
    const module = deferred(), f = fixture({ module }), startup = f.start();
    await flush(); module.reject(new Error('chunk unavailable')); await startup;
    assert.equal(f.count.legacy, 1); assert.equal(f.count.gpu, 0); assert.equal(f.count.ports, 0); f.stopped();
  });
  await check('a late device is disposed once and never configured', async () => {
    const init = deferred(), f = fixture({ init }), startup = f.start();
    await flush(); f.fire(15000); await startup;
    assert.equal(f.count.legacy, 1); init.resolve(); await flush();
    assert.equal(f.count.disposed, 1); assert.equal(f.count.ports, 0);
    assert.ok(f.errors.some(([kind]) => kind === 'WebGPU device arrived late')); f.stopped();
  });
  await check('late async disposal rejection is contained and reported', async () => {
    const init = deferred(), f = fixture({ init, dispose: async () => { throw new Error('async dispose failed'); } }), startup = f.start();
    const before = unhandled.length;
    await flush(); f.fire(15000); await startup; init.resolve(); await flush();
    assert.equal(unhandled.length, before, 'cleanup must not leak an unhandled rejection');
    assert.ok(f.errors.some(([kind, error]) => kind === 'WebGPU late cleanup failed' && error.message === 'async dispose failed'));
    assert.equal(f.count.disposed, 1); f.stopped();
  });
  await check('late synchronous disposal failure is contained and reported', async () => {
    const init = deferred(), f = fixture({ init, dispose: () => { throw new Error('sync dispose failed'); } }), startup = f.start();
    const before = unhandled.length;
    await flush(); f.fire(15000); await startup; init.resolve(); await flush();
    assert.equal(unhandled.length, before);
    assert.ok(f.errors.some(([kind, error]) => kind === 'WebGPU late cleanup failed' && error.message === 'sync dispose failed'));
    assert.equal(f.count.disposed, 1); f.stopped();
  });
  await check('initialization rejection retains its original failure', async () => {
    const init = deferred(), f = fixture({ init }), startup = f.start(), error = new Error('device refused');
    await flush(); init.reject(error); await startup;
    assert.equal(f.count.legacy, 1); assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0][1], error); assert.match(f.errors[0][2], /stage device/); f.stopped();
  });
  await check('late initialization failure is not reported as a device arrival', async () => {
    const init = deferred(), f = fixture({ init }), startup = f.start();
    const before = unhandled.length;
    await flush(); f.fire(15000); await startup; init.reject(new Error('late init failure')); await flush();
    assert.equal(unhandled.length, before); assert.equal(f.count.disposed, 0);
    assert.ok(!f.errors.some(([kind]) => kind === 'WebGPU device arrived late')); f.stopped();
  });
  await check('successful initialization configures and retains the GPU renderer', async () => {
    const f = fixture(); await f.start();
    assert.deepEqual(f.count, { legacy: 0, gpu: 1, disposed: 0, modules: 1, ports: 1 }); f.stopped();
  });
  await check('port timeout is fatal and late completion cannot configure or fall back', async () => {
    const pending = deferred();
    let factories = 0;
    const ports = { promise: pending.promise.then(module => { factories++; return module; }) };
    const f = fixture({ ports }), startup = f.start();
    try {
      await flush(); f.fire(15000);
      await assert.rejects(startup, /graphics.*too long/i);
      await flush();
      assert.equal(f.count.disposed, 1); assert.equal(f.count.legacy, 0); assert.equal(f.configured, 0);
    } finally { pending.resolve(f.ports); await startup.catch(() => {}); await flush(); }
    assert.equal(factories, 1, 'late module evaluation can finish but no renderer is configured');
    assert.equal(f.count.legacy, 0); assert.equal(f.configured, 0); assert.equal(f.count.disposed, 1); f.stopped();
  });
  await check('port import rejection preserves its error and releases the initialized renderer', async () => {
    const ports = deferred(), f = fixture({ ports }), startup = f.start(), error = new Error('ports unavailable');
    await flush(); ports.reject(error);
    await assert.rejects(startup, received => received === error);
    await flush();
    assert.equal(f.count.disposed, 1); assert.equal(f.count.legacy, 0); assert.equal(f.configured, 0); f.stopped();
  });
  await check('port failure reaches the error screen without waiting for disposal', async () => {
    const ports = deferred(), cleanup = deferred(), f = fixture({ ports, dispose: () => cleanup.promise }), startup = f.start();
    await flush(); ports.reject(new Error('ports unavailable'));
    await assert.rejects(startup, /ports unavailable/);
    assert.equal(f.count.disposed, 1, 'disposal starts without delaying startup rejection');
    cleanup.resolve(); await flush(); f.stopped();
  });
  for (const async of [false, true]) await check(`port failure contains ${async ? 'async' : 'sync'} disposal errors`, async () => {
    const ports = deferred(), error = new Error('port failure'), cleanup = new Error('setup dispose failed');
    const dispose = async ? async () => { throw cleanup; } : () => { throw cleanup; };
    const f = fixture({ ports, dispose }), startup = f.start(), before = unhandled.length;
    await flush(); ports.reject(error);
    await assert.rejects(startup, received => received === error);
    await flush();
    assert.equal(unhandled.length, before);
    assert.ok(f.errors.some(([kind, received]) => kind === 'WebGPU setup cleanup failed' && received === cleanup));
    assert.equal(f.count.legacy, 0); assert.equal(f.count.disposed, 1); f.stopped();
  });
  await check('configuration failure stays fatal without selecting legacy', async () => {
    const error = new Error('configuration failure'), f = fixture({ configureThrows: error });
    await assert.rejects(f.start(), received => received === error); await flush();
    assert.equal(f.count.disposed, 1); assert.equal(f.count.legacy, 0); f.stopped();
  });
  await check('material loading tracks frames and visibility until fatal completion', async () => {
    const ports = deferred(), f = fixture({ ports, dispose: async () => { throw new Error('cleanup'); } }), startup = f.start();
    await flush();
    const active = f.listeners.size;
    f.frame(); f.frame(); f.visibility(true); f.visibility(false);
    ports.reject(new Error('port failure'));
    await assert.rejects(startup, /port failure/); await flush(); f.stopped();
    assert.equal(active, 1, 'visibility tracking remains installed while materials load');
    const report = f.errors.find(([kind]) => kind === 'WebGPU setup cleanup failed')?.[2];
    assert.match(report, /stage materials/); assert.match(report, /frames 2/);
    assert.match(report, /hidden since true/); assert.match(report, /hidden now false/);
  });
  await check('successful configuration still has an active startup watcher', async () => {
    const ports = deferred();
    let during = 0;
    const f = fixture({ ports, onConfigure: () => { during = f.listeners.size; f.frame(); } }), startup = f.start();
    await flush(); ports.resolve(f.ports); await startup; f.stopped();
    assert.equal(during, 1, 'configuration completes before startup tracking is removed');
  });
  assert.equal(failures.length, 0, failures.join('\n\n'));
  console.log(`Renderer startup: ${checked} controlled promise, timeout, fallback and cleanup checks passed without a GPU.`);
} finally { process.removeListener('unhandledRejection', onUnhandled); }
