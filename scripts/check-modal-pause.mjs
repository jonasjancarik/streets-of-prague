#!/usr/bin/env node
// Real credits/newsletter dialogs and the production pause getter, with inert DOM.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const names = ['VITE_SUBSCRIBE_URL', 'VITE_TURNSTILE_SITE_KEY', 'VITE_TELEMETRY_URL'];
const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
process.env.VITE_SUBSCRIBE_URL = '/fixture/subscribe';
process.env.VITE_TURNSTILE_SITE_KEY = process.env.VITE_TELEMETRY_URL = '';
globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
class Element extends EventTarget {
  children = []; style = {}; classList = { toggle() {} }; textContent = '';
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, right: 100, top: 0, bottom: 100 }; }
  click() { this.dispatchEvent(new Event('click')); }
}
class Dialog extends Element {
  open = false;
  showModal() { this.open = true; }
  close() { this.open = false; }
}
globalThis.HTMLDialogElement = Dialog;
const creditsButton = new Element(), creditsBox = new Dialog(), privacy = new Element(), body = new Element();
let queries = 0;
globalThis.document = {
  body, documentElement: {}, querySelectorAll: () => [],
  getElementById(id) { queries++; return { credits: creditsButton, 'credits-box': creditsBox, privacy }[id] ?? null; },
  createElement: tag => tag === 'dialog' ? new Dialog() : new Element(),
};
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { creditsOpen, privacyLink } = await server.ssrLoadModule('/src/credits.ts');
  const { newsletterOpen, newsletterLink } = await server.ssrLoadModule('/src/newsletter.ts');
  const settings = await readFile(new URL('../src/settings.ts', import.meta.url), 'utf8');
  const expression = settings.match(/const api = (\{ get open\(\) \{[^\n]*\}, show \});/)?.[1];
  assert.ok(expression, 'locate the existing settings pause getter');
  let feedback = false;
  const box = { open: false };
  const api = new Function('box', 'feedbackOpen', 'newsletterOpen', 'creditsOpen', 'show', `return ${expression}`)(box, () => feedback, newsletterOpen, creditsOpen, () => {});
  assert.equal(api.open, false);
  creditsButton.click();
  assert.equal(creditsBox.open, true);
  assert.equal(api.open, true, 'desktop credits pauses the game through the existing getter');
  const escape = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(escape, 'code', { value: 'Escape' });
  creditsBox.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false, 'native Escape cancellation remains allowed');
  creditsBox.close();
  assert.equal(api.open, false, 'closing credits resumes the game');

  // The phone closes settings before opening credits through the same button.
  box.open = true;
  box.open = false; creditsButton.click();
  assert.equal(api.open, true, 'settings-to-credits handoff keeps the game paused');
  creditsBox.close();
  const parent = new Element();
  newsletterLink(parent, 'fixture-link', { before: () => { box.open = false; } });
  box.open = true; parent.children[0].click();
  const newsletter = body.children.find(child => child instanceof Dialog);
  assert.equal(box.open, false);
  assert.equal(newsletter.open, true);
  assert.equal(api.open, true, 'settings-to-newsletter handoff keeps the game paused');
  const newsletterEscape = new Event('keydown', { cancelable: true });
  newsletter.dispatchEvent(newsletterEscape);
  assert.equal(newsletterEscape.defaultPrevented, false);
  const privacyParent = new Element(); privacyLink(privacyParent); privacyParent.children[0].click();
  assert.equal(creditsBox.open, true);
  creditsBox.close();
  assert.equal(api.open, true, 'closing stacked privacy keeps the underlying newsletter paused');
  newsletter.close(); assert.equal(api.open, false);
  feedback = true; assert.equal(api.open, true, 'existing feedback pause remains intact');
  feedback = false;
  const before = queries;
  for (let n = 0; n < 10000; n++) assert.equal(api.open, false);
  assert.equal(queries, before, 'frame-time pause checks do not query the DOM');

  // The actual release handler still runs at window capture, including inside modals.
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const release = main.match(/window\.addEventListener\('keyup',[\s\S]*?\}, \{ capture: true \}\);/)?.[0];
  assert.ok(release);
  let keyup;
  const input = { up: true, run: true }, horns = [];
  const cannon = new Function('window', 'input', 'keymap', 'honk', `let cannonHeld = true; ${release}; return () => cannonHeld;`)(
    { addEventListener: (type, fn, options) => { assert.equal(type, 'keyup'); assert.equal(options.capture, true); keyup = fn; } },
    input, { KeyW: 'up' }, on => horns.push(on),
  );
  creditsButton.click();
  keyup({ code: 'KeyW', shiftKey: false });
  keyup({ code: 'KeyQ', shiftKey: false });
  keyup({ code: 'KeyF', shiftKey: false });
  assert.deepEqual(input, { up: false, run: false });
  assert.deepEqual(horns, [false]); assert.equal(cannon(), false);
  creditsBox.close();
  console.log('Modal pause: credits/privacy/newsletter handoffs, stacked dialogs, Escape defaults, captured releases and cached pause checks passed.');
} finally {
  await server.close();
  for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
}
