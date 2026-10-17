#!/usr/bin/env node
// Production pause polling with isolated promise/timer fixtures, no server or lock files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = ts.transpileModule((await readFile(new URL('../src/benchpause.ts', import.meta.url), 'utf8')).replace('import.meta.env.DEV', 'enabled'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace('export const benchPause', 'const benchPause').replace(/export \{\};?/g, '');
const load = new Function('enabled', 'window', 'document', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', `${source}\nreturn benchPause;`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const fixture = ({ own = false, enabled = true } = {}) => {
  const requests = [], timers = new Map(), window = own ? { __bench: {} } : {};
  let next = 0;
  const pause = load(enabled, window, { createElement: () => ({ style: {} }), body: { append() {} } },
    (_url, options) => { const request = deferred(); requests.push({ ...request, options }); return request.promise; },
    () => 0, (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, id => timers.delete(id));
  return {
    pause, requests, timers, check: () => window.__benchPause.check(),
    respond(i, body, ok = true) { requests[i].resolve({ ok, json: async () => body }); },
    timeout() {
      const entry = [...timers].find(([, timer]) => timer.ms > 0 && timer.ms <= 5000);
      assert.ok(entry, 'pending status request has a bounded timeout');
      timers.delete(entry[0]); entry[1].fn();
    },
  };
};

{
  const f = fixture(), old = f.check(), latest = f.check();
  f.respond(1, { bench: null }); await latest;
  f.respond(0, { bench: 'finished benchmark' }); await old;
  assert.equal(f.pause.paused, false, 'an older success cannot re-pause after a newer completed response');
  assert.equal(f.timers.size, 0);
}
for (const failure of ['error', 'timeout']) {
  const f = fixture(), old = f.check(), latest = f.check();
  f.respond(1, { bench: 'current benchmark' }); await latest;
  if (failure === 'error') f.requests[0].reject(new Error('old request failed'));
  else f.timeout();
  await old;
  assert.equal(f.pause.paused, true, `an older ${failure} cannot unpause a newer completed benchmark status`);
  if (failure === 'timeout') assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
}
{
  const f = fixture(), old = f.check(), latest = f.check();
  f.respond(0, { bench: 'still running' }); await old;
  assert.equal(f.pause.paused, true, 'slow responses still apply while a newer request is pending');
  f.respond(1, { bench: null }); await latest;
  assert.equal(f.pause.paused, false);
}
for (const waitingOnBody of [false, true]) {
  const f = fixture(), clear = f.pause.clear();
  if (waitingOnBody) {
    f.requests[0].resolve({ ok: true, json: () => new Promise(() => {}) });
    await flush();
  }
  f.timeout(); await clear;
  assert.equal(f.pause.paused, false, 'startup clear settles after a hanging fetch or body');
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.timers.size, 0);
}
for (const body of [null, {}, { bench: false }, { bench: 3 }, { bench: [] }, { bench: '' }]) {
  const f = fixture(), first = f.check();
  f.respond(0, { bench: 'running' }); await first;
  const malformed = f.check(); f.respond(1, body); await malformed;
  assert.equal(f.pause.paused, false, 'malformed status follows the existing unavailable-endpoint policy');
}
{
  const f = fixture(), first = f.check();
  f.respond(0, { bench: 'running' }); await first;
  const failed = f.check(); f.respond(1, { bench: 'stale error body' }, false); await failed;
  assert.equal(f.pause.paused, false, 'HTTP failure is not an active benchmark report');
}
for (const options of [{ own: true }, { enabled: false }]) {
  const f = fixture(options); await f.pause.clear();
  assert.equal(f.pause.paused, false);
  assert.equal(f.requests.length, 0, 'benchmark pages and production builds do not poll the dev endpoint');
  assert.equal(f.timers.size, 0);
}
console.log('Benchmark pause: ordered completions, timeout/abort through body reads, startup recovery, malformed/HTTP failures and own-page bypass passed.');
