#!/usr/bin/env node
// Sky refresh failures before worker dispatch must not become a microtask retry loop.
//   node scripts/check-sky-refresh.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
const { TileWorkers } = await import('../src/tileWorkers.ts');
const { SkyRefresh } = await import('../src/skyRefresh.ts');
const tick = () => new Promise((done) => setTimeout(done, 10));

// Cap submissions so a regression reports a failed assertion without starving
// timers forever. The first four submissions use the real failing queue.
function refresh(queue) {
  let attempts = 0;
  const applied = [];
  const sky = new SkyRefresh((started) => {
    attempts++;
    if (attempts > 4) return { promise: new Promise(() => {}), cancel() {} };
    return queue.submit('sky', () => { started(); return {}; }, [], 'optional');
  }, (result) => applied.push(result), 0);
  return { sky, applied, attempts: () => attempts };
}
const absent = new TileWorkers(1, () => { throw new Error('worker construction failed'); });
const failed = refresh(absent);
failed.sky.request(); await tick();
assert.equal(failed.attempts(), 1, 'pre-dispatch rejection waits for another neighbour change');
assert.equal(failed.sky.running, false); assert.equal(failed.sky.applied, 0);
failed.sky.request(); await tick();
assert.equal(failed.attempts(), 2, 'a later request allows one controlled retry');
assert.equal(failed.applied.length, 0);
failed.sky.drop();

let endpoint;
const queue = new TileWorkers(1, () => {
  if (endpoint) throw new Error('replacement failed');
  endpoint = { onmessage: null, onerror: null, onmessageerror: null, postMessage() {}, terminate() {} };
  return endpoint;
});
const blocker = queue.submit('roofs', {});
const lost = refresh(queue);
lost.sky.request(); await tick();
assert.equal(queue.counts.queuedOptional, 1);
lost.sky.request(); // one newer request arrived while this attempt was queued
const blockedFailure = blocker.promise.catch((error) => assert.equal(error.message, 'last worker failed'));
endpoint.onerror({ message: 'last worker failed', preventDefault() {} });
await blockedFailure; await tick();
assert.equal(lost.attempts(), 2, 'one newer request permits one follow-up after the queued attempt fails');
assert.equal(lost.sky.running, false); assert.equal(lost.sky.applied, 0);
assert.equal(lost.applied.length, 0);
lost.sky.drop();
console.log('Sky refresh: missing workers stop after one attempt; explicit later requests retry once; queued worker loss permits one newer follow-up without spinning.');
