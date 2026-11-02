#!/usr/bin/env node
// Deterministic input lifecycle checks using the real touch/gamepad modules.
// No game, GPU, map files or browser permissions needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });

class Element extends EventTarget {
  style = {};
  dataset = {};
  hidden = false;
  clicked = 0;
  items = [];
  classes = new Set();
  classList = {
    add: name => this.classes.add(name),
    remove: name => this.classes.delete(name),
    contains: name => this.classes.has(name),
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  rect = { left: 0, top: 0, width: 96, height: 96, right: 96, bottom: 96 };
  getBoundingClientRect() { return this.rect; }
  getClientRects() { return this.hidden ? [] : [this.rect]; }
  closest(selector) { return selector === 'dialog[open]' && dialogs.includes(this.dialog) ? this.dialog : null; }
  querySelectorAll() { return this.items; }
  querySelector() { return null; }
  setPointerCapture() {}
  focus() { document.activeElement = this; }
  click() { this.clicked++; }
}
globalThis.HTMLInputElement = class extends Element {};
globalThis.HTMLSelectElement = class extends Element {};
globalThis.HTMLDialogElement = class extends Element { close() { dialogs = dialogs.filter(dialog => dialog !== this); } };
globalThis.KeyboardEvent = class extends Event {
  constructor(type, init) { super(type, init); Object.assign(this, { code: init.code, shiftKey: init.shiftKey }); }
};
globalThis.window = new EventTarget();
const elements = new Map();
const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
let dialogs = [];
globalThis.document = Object.assign(new EventTarget(), {
  hidden: false, body: new Element(), documentElement: {}, activeElement: null,
  getElementById: el,
  querySelectorAll: selector => selector === 'dialog[open]' ? dialogs : [],
  querySelector: () => null,
});
globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null };
globalThis.matchMedia = () => ({ matches: false });
let pads = [];
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'en', getGamepads: () => pads } });
let frame;
globalThis.requestAnimationFrame = fn => { frame = fn; return 1; };
const pointer = (target, type, id = 1, x = 48, y = 48) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });
  el(target).dispatchEvent(event);
};
const hide = () => { document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); };
const show = () => { document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); };

const { setupTouch } = await import('../src/touch.ts');
let horn = false, cannon = false, shooting = false, zooms = 0;
const touch = setupTouch({
  action() {}, backOnRoad() {}, zoomBy() { zooms++; }, horn: on => { horn = on; },
  steal() {}, cannon: on => { cannon = on; }, shoot: on => { shooting = on; }, doors() {}, jump() {}, force: true,
});
const update = () => touch.update({ car: null, canEnter: false, engine: true });
update();
el('t-brake').rect = { left: 100, top: 0, width: 96, height: 96, right: 196, bottom: 96 };
pointer('t-steer', 'pointerdown');
pointer('t-steer', 'pointermove', 1, 96, 48);
update();
assert(touch.aim?.mag > .9);
pointer('t-steer', 'lostpointercapture');
update();
assert.equal(touch.aim, null, 'lost stick capture stops walking');
pointer('t-steer', 'pointerdown', 2);
pointer('t-steer', 'pointermove', 2, 96, 48);
pointer('t-steer', 'lostpointercapture', 1);
update();
assert(touch.aim, 'an old pointer cannot release the current stick');

for (const [id, held] of [
  ['t-hand', () => touch.brake], ['t-fast', () => touch.fast],
  ['t-horn', () => horn], ['t-cannon', () => cannon], ['t-shoot', () => shooting],
]) {
  pointer(id, 'pointerdown');
  assert(held(), id + ' is held');
  pointer(id, 'lostpointercapture');
  assert.equal(held(), false, id + ' releases when capture is lost');
}

for (const suspend of [() => window.dispatchEvent(new Event('blur')), hide]) {
  show();
  pointer('t-steer', 'pointerdown', 3);
  pointer('t-steer', 'pointermove', 3, 96, 48);
  pointer('t-pedals', 'pointerdown');
  for (const id of ['t-hand', 't-fast', 't-horn', 't-cannon', 't-shoot']) pointer(id, 'pointerdown');
  pointer('app', 'pointerdown', 1, 0, 0);
  pointer('app', 'pointerdown', 2, 100, 0);
  update();
  assert.equal(touch.move, 1);
  suspend();
  assert.deepEqual([touch.move, touch.brake, touch.fast, touch.aim, horn, cannon, shooting], [0, false, false, null, false, false, false]);
  show();
  pointer('app', 'pointermove', 2, 150, 0);
  assert.equal(zooms, 0, 'an interrupted pinch cannot zoom on return');
  pointer('t-pedals', 'pointermove');
  assert.equal(touch.move, 0, 'an interrupted pedal needs a fresh press');
}

const { setupGamepad } = await import('../src/gamepad.ts');
const keys = new Set();
window.addEventListener('keydown', e => keys.add(e.code));
window.addEventListener('keyup', e => keys.delete(e.code));
const pad = { connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
pads = [pad];
const state = setupGamepad({ settings() {}, menu: () => false, zoomBy() {} });
let now = performance.now();
const tick = () => { now += 16; frame(now); };
const button = (index, pressed) => { pad.buttons[index] = { pressed, value: pressed ? 1 : 0 }; };
button(3, true); button(7, true); pad.axes[0] = 1;
tick();
assert(keys.has('KeyQ'));
assert.equal(state.move, 1);
assert(state.aim);
for (const suspend of [() => window.dispatchEvent(new Event('blur')), hide]) {
  suspend();
  assert.equal(keys.size, 0, 'background game releases synthetic keys immediately');
  assert.deepEqual([state.move, state.turn, state.aim], [0, 0, null]);
  tick(); tick();
  assert.equal(keys.size, 0, 'background animation frames cannot re-press buttons');
  assert.equal(state.move, 0);
  show(); tick();
  assert.equal(keys.size, 0, 'held buttons need release before resuming in the focused game');
  assert.equal(state.move, 0);
  button(3, false); button(7, false); tick();
  button(3, true); button(7, true); tick();
  assert(keys.has('KeyQ'), 'focused game accepts a fresh press');
}
pads = []; tick();
assert.equal(keys.size, 0, 'disconnect releases held buttons');
assert.equal(state.active, false);

pads = [pad];
for (let i = 0; i < pad.buttons.length; i++) button(i, false);
window.dispatchEvent(new Event('blur'));
button(2, true); // pressed while the player was in another window
show(); tick();
assert.equal(keys.size, 0, 'a button first pressed in the background also needs release');
button(2, false); tick(); button(2, true); tick();
assert(keys.has('KeyE'));

pads = [pad];
pad.axes[0] = 0;
for (let i = 0; i < pad.buttons.length; i++) button(i, false);
const dialog = new HTMLDialogElement(), first = new Element(), outside = new Element();
first.dialog = dialog;
dialog.items = [first]; dialogs = [dialog]; outside.focus();
button(0, true); tick();
assert.equal(outside.clicked, 0, 'confirm cannot click outside the current dialog');
assert.equal(first.clicked, 1);
button(0, false); tick();
const select = new HTMLSelectElement();
select.dialog = dialog;
select.selectedIndex = 0;
select.options = [{ disabled: false }, { disabled: true }, { disabled: false }];
dialog.items = [first, select]; select.focus();
let changes = 0;
select.addEventListener('change', () => changes++);
button(15, true); tick();
assert.equal(select.selectedIndex, 2, 'right selects the next enabled option');
assert.equal(changes, 1);
button(15, false); tick(); button(15, true); tick();
assert.equal(changes, 1, 'end of list does not emit a false change');
button(15, false); tick(); button(14, true); tick();
assert.equal(select.selectedIndex, 0);
assert.equal(changes, 2);
// Credits exists earlier in the DOM than a lazily created newsletter, but opening
// Privacy from that form puts Credits above it and moves native focus there.
button(14, false); tick();
const credits = new HTMLDialogElement(), newsletter = new HTMLDialogElement();
const creditsButton = new Element(), newsletterButton = new Element();
creditsButton.dialog = credits; newsletterButton.dialog = newsletter;
credits.items = [creditsButton]; newsletter.items = [newsletterButton];
dialogs = [credits, newsletter]; creditsButton.focus();
button(0, true); tick();
assert.equal(creditsButton.clicked, 1, 'confirm follows the focused top dialog, not DOM creation order');
assert.equal(newsletterButton.clicked, 0, 'the covered dialog cannot receive confirm');
button(0, false); tick(); button(1, true); tick();
assert.deepEqual(dialogs, [newsletter], 'back closes only the focused top dialog');
button(1, false); button(0, true); tick();
assert.equal(newsletterButton.clicked, 1, 'the remaining dialog accepts input after the top one closes');
console.log('Controls: lost capture, interrupted holds/pinches, background gamepad polling, disconnect, dialog focus and select navigation passed');

// Use the production wheel registration with a minimal DOM propagation model:
// overlay events bubble to window, while the canvas is their sibling.
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const wheelSource = main.match(/(?:window|renderer\.domElement)\.addEventListener\('wheel',[\s\S]*?\}, \{ passive: true \}\);/)?.[0];
assert.ok(wheelSource, 'locate the game wheel handler');
const wheelWindow = new EventTarget(), canvas = new EventTarget(), kit = { cam: null };
let viewZoom = 1;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
new Function('window', 'renderer', 'testkit', 'clamp', 'zoomBy', wheelSource)(
  wheelWindow, { domElement: canvas }, kit, clamp, factor => { viewZoom = clamp(viewZoom * factor, 0.5, 4); },
);
const wheel = (target, deltaY = 120) => {
  target.dispatchEvent(Object.assign(new Event('wheel'), { deltaY }));
  if (target !== wheelWindow) wheelWindow.dispatchEvent(Object.assign(new Event('wheel'), { deltaY }));
};
for (const name of ['settings dialog', 'developer panel', 'metro list']) {
  wheel(new EventTarget());
  assert.equal(viewZoom, 1, `${name}: scrolling an overlay leaves game zoom unchanged`);
}
wheel(canvas);
assert.equal(viewZoom, Math.exp(120 * 0.0012), 'canvas scroll retains ordinary game zoom');
const ordinaryZoom = viewZoom;
kit.cam = { height: 100 };
for (const name of ['settings dialog', 'developer panel', 'metro list']) {
  wheel(new EventTarget());
  assert.equal(kit.cam.height, 100, `${name}: scrolling an overlay leaves free-camera height unchanged`);
}
wheel(canvas);
assert.equal(kit.cam.height, 100 * Math.exp(120 * 0.0012), 'canvas scroll retains free-camera zoom');
assert.equal(viewZoom, ordinaryZoom, 'free-camera scrolling does not also zoom the player view');
wheel(canvas, 1e6); assert.equal(kit.cam.height, 1500);
wheel(canvas, -1e6); assert.equal(kit.cam.height, 5);
console.log('Wheel scope: panel scrolling leaves both cameras unchanged; canvas scrolling preserves zoom and free-camera limits.');
