#!/usr/bin/env node
// Offline main-thread country-worker lifecycle checks. No map downloads or browser.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('/src/data.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });

const workers = [];
class WorkerFixture {
  static creationError = null;
  messages = []; terminated = 0; postError = null;
  onmessage = null; onerror = null; onmessageerror = null;
  constructor() { if (WorkerFixture.creationError) throw WorkerFixture.creationError; workers.push(this); }
  postMessage(message) { if (this.postError) throw this.postError; this.messages.push(message); }
  terminate() { this.terminated++; }
  reply(result) { this.onmessage?.({ data: { id: this.messages.at(-1).id, ...result } }); }
}
const oldWorker = globalThis.Worker, oldLocation = globalThis.location, oldWarn = console.warn;
globalThis.Worker = WorkerFixture;
globalThis.location = { href: 'https://game.invalid/' };
const warnings = [];
console.warn = (...args) => warnings.push(args);
const { CountrysideTiles } = await import('../src/countrysideTiles.ts');
const index = { bbox_wgs84: [14, 50, 15, 51], size: [100, 100], origin: [0, 0], tile: 100, cols: 1, rows: 1 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const watch = promise => {
  const result = { state: 'pending' };
  promise.then(value => Object.assign(result, { state: 'fulfilled', value }), error => Object.assign(result, { state: 'rejected', error }));
  return result;
};
const open = async () => {
  const country = new CountrysideTiles(index, 'test'), worker = workers.at(-1);
  worker.reply({ box: [-1000, -1000, 1000, 1000] }); await country.opened;
  assert.equal(country.covers(2, 2), true);
  return { country, worker };
};
const stopped = (country, worker) => {
  assert.equal(country.box, null);
  assert.equal(country.covers(2, 2), false);
  assert.equal(country.waiting.size, 0, 'all outstanding worker requests are released');
  assert.equal(worker.terminated, 1);
  assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null); assert.equal(worker.onmessageerror, null);
};
try {
  // A tile's ordinary fetch/build error is retryable on the same healthy worker.
  {
    const { country, worker } = await open();
    const failed = watch(country.tile(2, 2)); worker.reply({ error: 'Tile fetch failed (503)' }); await flush();
    assert.equal(failed.state, 'rejected'); assert.match(failed.error.message, /503/);
    assert.equal(country.covers(2, 2), true); assert.equal(worker.terminated, 0);
    const tile = { i: 2, j: 2 }, retried = watch(country.tile(2, 2)); worker.reply({ tile, ms: 4 }); await flush();
    assert.equal(retried.state, 'fulfilled'); assert.equal(retried.value, tile); assert.deepEqual(country.times, [4]);
    country.placeAt(250, 250); worker.reply({ places: [{ name: 'Village', kind: 'village', at: [250, 250] }] }); await flush();
    assert.equal(country.placeAt(250, 250), 'Village');
  }

  for (const event of ['error', 'messageerror']) {
    const { country, worker } = await open();
    country.placeAt(250, 250);
    const tile = watch(country.tile(2, 2)), hills = watch(country.heights(2, 2));
    assert.equal(country.waiting.size, 3);
    let prevented = false;
    if (event === 'error') worker.onerror({ message: 'Worker crashed', preventDefault() { prevented = true; } });
    else worker.onmessageerror({});
    await flush(); stopped(country, worker);
    assert.equal(tile.state, 'rejected'); assert.equal(hills.state, 'fulfilled'); assert.equal(hills.value, null);
    if (event === 'error') assert.equal(prevented, true);
    const posts = worker.messages.length, logs = warnings.length;
    for (let frame = 0; frame < 30; frame++) { assert.equal(country.placeAt(250, 250), null); await flush(); }
    assert.equal(worker.messages.length, posts); assert.equal(warnings.length, logs, 'terminal failure cannot create a per-frame name retry storm');
    const after = watch(country.tile(3, 3)); await flush(); assert.equal(after.state, 'rejected');
  }

  // A crash while idle still reports its terminal reason once, even though no
  // rejected tile/name caller is present to report it.
  {
    const { country, worker } = await open(), before = warnings.length;
    const lateError = worker.onerror;
    worker.onerror({ message: 'Idle worker crashed', preventDefault() {} });
    await flush(); stopped(country, worker);
    assert.equal(warnings.length, before + 1);
    assert.match(warnings.at(-1)[1].message, /Idle worker crashed/);
    lateError({ message: 'Duplicate error' });
    for (let frame = 0; frame < 30; frame++) { country.placeAt(250, 250); await flush(); }
    assert.equal(warnings.length, before + 1, 'one terminal diagnostic, no per-frame retry warnings');
  }

  // A resolved response's queued .then must not resurrect coverage or cached names
  // when a terminal failure is delivered in the same turn.
  {
    const country = new CountrysideTiles(index, 'test'), worker = workers.at(-1);
    worker.reply({ box: [-1000, -1000, 1000, 1000] }); worker.onerror({ message: 'Open race' });
    await country.opened; stopped(country, worker);
  }
  {
    const { country, worker } = await open();
    country.placeAt(250, 250); worker.reply({ places: [{ name: 'Stale', kind: 'town', at: [250, 250] }] });
    worker.onerror({ message: 'Names race' }); await flush(); stopped(country, worker);
    assert.equal(country.places, null); assert.equal(country.placeAt(250, 250), null);
  }
  for (const kind of ['error', 'messageerror', 'open-response']) {
    const country = new CountrysideTiles(index, 'test'), worker = workers.at(-1), opened = watch(country.opened);
    if (kind === 'open-response') worker.reply({ error: 'Archive unavailable' });
    else if (kind === 'error') worker.onerror({ message: 'Worker script unavailable' });
    else worker.onmessageerror({});
    await flush(); assert.equal(opened.state, 'fulfilled', 'optional countryside failure cannot hang game startup'); stopped(country, worker);
  }
  {
    WorkerFixture.creationError = new Error('Worker construction blocked');
    const country = new CountrysideTiles(index, 'test'); await country.opened;
    assert.equal(country.box, null); assert.equal(country.worker, null);
    WorkerFixture.creationError = null;
  }
  {
    const { country, worker } = await open(); worker.postError = new Error('DataCloneError');
    const failed = watch(country.tile(2, 2)); await flush();
    assert.equal(failed.state, 'rejected'); assert.equal(country.waiting.size, 0, 'synchronous dispatch failure removes its waiter');
    worker.postError = null;
    const next = watch(country.tile(2, 2)); worker.reply({ tile: { i: 2, j: 2 }, ms: 1 }); await flush();
    assert.equal(next.state, 'fulfilled'); assert.equal(worker.terminated, 0);
  }
  console.log('Countryside worker: terminal failure/cleanup, startup fallback, same-turn response races, no retry storm and ordinary tile retries passed');
} finally {
  globalThis.Worker = oldWorker; globalThis.location = oldLocation; console.warn = oldWarn;
}
