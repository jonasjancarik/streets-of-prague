#!/usr/bin/env node
// Exercise the real form handlers with inert DOM, controlled time and mocked requests.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const names = ['VITE_SUBSCRIBE_URL', 'VITE_FEEDBACK_URL', 'VITE_TURNSTILE_SITE_KEY', 'VITE_TELEMETRY_URL'];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.VITE_SUBSCRIBE_URL = '/fixture/subscribe';
process.env.VITE_FEEDBACK_URL = '/fixture/feedback';
process.env.VITE_TURNSTILE_SITE_KEY = process.env.VITE_TELEMETRY_URL = '';
globalThis.location = { search: '?lang=en', origin: 'http://fixture.invalid', pathname: '/' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = new EventTarget();
window.setTimeout = (...args) => globalThis.setTimeout(...args);
globalThis.requestAnimationFrame = () => 1;
globalThis.matchMedia = () => ({ matches: false });
Object.assign(globalThis, { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, __APP_VERSION__: 'fixture', __APP_BUILT__: 'fixture', __DATA_VERSION__: '' });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', userAgent: 'offline fixture' } });
class Element {
  children = []; listeners = new Map(); value = ''; hidden = false; disabled = false; style = {}; classList = { toggle() {} };
  constructor(tag = 'div') { this.tag = tag; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute() {}
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  emit(type) { return this.listeners.get(type)?.({ preventDefault() {} }); }
  getContext() { return null; }
}
class Dialog extends Element {
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
}
globalThis.HTMLDialogElement = Dialog;
const body = new Element('body');
globalThis.document = { body, documentElement: {}, querySelectorAll: () => [], getElementById: () => null, createElement: tag => tag === 'dialog' ? new Dialog(tag) : new Element(tag) };
const all = el => [el, ...el.children.flatMap(all)];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const clock = () => {
  const original = { setTimeout, clearTimeout };
  let now = 0, id = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; };
  globalThis.clearTimeout = key => timers.delete(key);
  return { timers, async advance(ms) { now += ms; for (const [key, t] of [...timers]) if (t.at <= now) { timers.delete(key); t.fn(); } await flush(); }, restore() { Object.assign(globalThis, original); } };
};
const server = await createServer({ root: process.cwd(), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
let serial = 0;
try {
  const { signupFields } = await server.ssrLoadModule('/src/newsletter.ts');
  const { setLang } = await server.ssrLoadModule('/src/i18n.ts');
  const fixture = async kind => {
    let root;
    if (kind === 'newsletter') { root = new Element(); signupFields(root); }
    else {
      const { feedbackLink } = await server.ssrLoadModule(`/src/feedback.ts?fixture=${++serial}`);
      feedbackLink(new Element(), 'fixture')();
      root = body.children.at(-1);
    }
    const nodes = all(root), form = nodes.find(el => el.tag === 'form'), email = nodes.find(el => el.name === 'email'), message = nodes.find(el => el.name === 'message');
    email.value = 'fixture@example.invalid';
    if (message) message.value = 'Keep this typed report.';
    return { form, email, message, go: nodes.find(el => el.type === 'submit'), status: nodes.find(el => el.className === 'news-status'), submit: () => form.emit('submit') };
  };
  for (const kind of ['newsletter', 'feedback']) {
    for (const mode of ['headers-stall', 'ok-body-stall', 'error-body-stall', 'known-error', 'body-abort', 'malformed-body', 'network-error']) {
      const f = await fixture(kind), time = clock(), pending = deferred(), calls = [];
      let reads = 0;
      const ok = { ok: true, body: { cancel: async () => {} }, json: () => { reads++; return pending.promise; } };
      globalThis.fetch = async (url, init) => {
        assert.match(url, /^\/fixture\/(subscribe|feedback)$/);
        calls.push({ url, ...init });
        if (mode === 'headers-stall') return pending.promise;
        if (mode === 'network-error') throw new TypeError('Offline fixture');
        if (mode === 'ok-body-stall') return ok;
        return { ok: false, json: async () => {
          reads++;
          if (mode === 'error-body-stall') return pending.promise;
          if (mode === 'body-abort') throw new DOMException('Fixture body aborted', 'AbortError');
          if (mode === 'malformed-body') throw new SyntaxError('Fixture bad JSON');
          return { error: 'busy' };
        } };
      };
      try {
        let settled = false;
        const task = f.submit().then(() => { settled = true; });
        await flush();
        if (mode.endsWith('stall') && mode !== 'ok-body-stall') {
          await f.submit();
          assert.equal(calls.length, 1, 'a repeated submit while pending sends nothing');
          await time.advance(29999);
          assert.equal(f.go.disabled, true, `${kind}/${mode}: stays pending before deadline`);
          await time.advance(1);
        }
        assert.equal(settled, true, `${kind}/${mode}: handler settles`);
        await task;
        assert.equal(f.go.disabled, false, `${kind}/${mode}: retry is enabled`);
        assert.equal(calls.length, 1, `${kind}/${mode}: no automatic retry`);
        const sent = JSON.parse(calls[0].body);
        assert.equal(sent.email, 'fixture@example.invalid');
        if (f.message) assert.equal(sent.message, 'Keep this typed report.');
        assert.equal(time.timers.size, 0, `${kind}/${mode}: deadline timer cleared`);
        assert.equal(f.email.value, 'fixture@example.invalid');
        if (f.message) assert.equal(f.message.value, 'Keep this typed report.');
        if (mode === 'ok-body-stall') {
          assert.equal(f.form.hidden, true, `${kind}: successful headers finish immediately`);
          assert.equal(reads, 0, `${kind}: success does not wait for a body`);
        } else {
          assert.equal(f.form.hidden, false, `${kind}/${mode}: typed fields remain available`);
          if (mode === 'headers-stall') {
            assert.match(f.status.textContent, /couldn't confirm/);
            const english = f.status.textContent;
            setLang('cs');
            assert.match(f.status.textContent, /Nepodařilo/);
            setLang('en');
            assert.equal(f.status.textContent, english, 'timeout status follows the selected language');
            assert.equal(calls[0].signal.aborted, true);
          } else if (mode === 'known-error') assert.match(f.status.textContent, /Too many tries/);
          else assert.match(f.status.textContent, /didn't work this time/);
          if (mode.endsWith('stall')) {
            assert.equal(calls[0].signal.aborted, true);
            const note = f.status.textContent;
            pending.resolve(mode === 'headers-stall' ? ok : { error: 'email' });
            await flush();
            assert.equal(f.status.textContent, note, 'late completion cannot overwrite timeout status');
            assert.equal(f.form.hidden, false);
          }
          globalThis.fetch = async (url, init) => { calls.push({ url, ...init }); return ok; };
          await f.submit();
          assert.equal(calls.length, 2, 'one explicit retry sends once');
          assert.equal(f.form.hidden, true, 'explicit retry can succeed');
          assert.equal(time.timers.size, 0);
        }
        console.log(`${kind}/${mode} passed`);
      } finally { time.restore(); }
    }
  }
} finally {
  await server.close();
  for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
}
