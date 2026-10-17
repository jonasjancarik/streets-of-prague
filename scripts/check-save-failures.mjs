#!/usr/bin/env node
// Execute the production save callbacks and settings controls with failing storage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createServer } from 'vite';

let failure = '';
const storage = new Map();
const access = write => {
  if (failure === 'blocked' || (write && failure === 'quota')) throw new DOMException('Storage unavailable', failure === 'quota' ? 'QuotaExceededError' : 'SecurityError');
};
globalThis.localStorage = {
  get length() { access(false); return storage.size; },
  getItem(key) { access(false); return storage.get(key) ?? null; },
  setItem(key, value) { access(true); storage.set(key, String(value)); },
  removeItem(key) { access(false); storage.delete(key); },
  key(i) { access(false); return [...storage.keys()][i] ?? null; },
};
globalThis.location = { search: '?lang=en' };
globalThis.window = { setTimeout: () => 1 };
globalThis.document = { querySelectorAll: () => [], documentElement: {} };
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const api = await server.ssrLoadModule('/src/save.ts');
  const { t, setLang } = await server.ssrLoadModule('/src/i18n.ts');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const autoSource = main.match(/const autosave = \(\) => \{[\s\S]*?\n  \};/)?.[0];
  const callbacksSource = main.match(/const saves = \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(autoSource && callbacksSource, 'locate the production save handlers');
  const game = { v: 1, area: 'test', at: Date.now(), lat: 50, lon: 14, heading: 90, street: null, car: null, money: 1000, ticket: null, health: 100, heat: 0, clock: 3600, weather: { kind: 'clear', fixed: true } };
  const original = { ...game, money: 10 }, selected = { ...game, money: 20 };
  const setup = (overrides = {}) => {
    failure = ''; storage.clear();
    api.writeSave('auto', original); api.writeSave('hand:1', selected);
    const events = [], session = { ...game };
    let restarts = 0;
    const dependencies = {
      ...api, AREA: 'test', newSlot: () => 'hand:new', capture: () => ({ ...session }),
      telemetry: { count: name => events.push(name), did: name => events.push(name) },
      restart: () => { restarts++; }, playing: true, saving: true, wastedT: 0, arrest: { active: false }, health: { dead: false }, inHeli: null,
      ...overrides,
    };
    const handlers = new Function(...Object.keys(dependencies), compile(`${autoSource}\n${callbacksSource}\nreturn { saves, autosave };`))(...Object.values(dependencies));
    return { ...handlers, events, session, get restarts() { return restarts; } };
  };
  for (const mode of ['quota', 'blocked']) {
    const f = setup(); failure = mode;
    assert.equal(api.writeSave('other', game), false);
    assert.equal(f.saves.save(), false);
    assert.equal(f.saves.load('hand:1'), false);
    assert.equal(f.saves.exit(), false);
    if (mode === 'blocked') {
      assert.equal(api.clearSave('auto'), false);
      assert.equal(f.saves.newGame(), false);
      assert.equal(f.saves.remove('hand:1'), false);
    }
    assert.equal(f.restarts, 0, 'failed storage operations never restart the current session');
    assert.deepEqual(f.events, [], 'failed operations do not emit success telemetry');
    assert.deepEqual(f.session, game);
    assert.deepEqual(JSON.parse(storage.get('save:auto')), original, 'failed load/delete leaves the old auto slot intact');
    assert.deepEqual(JSON.parse(storage.get('save:hand:1')), selected);
    assert.equal(storage.has('save:hand:new'), false);
    for (let n = 0; n < 10; n++) assert.equal(f.autosave(), false);
    assert.deepEqual(f.events, [], 'repeated autosave failure stays quiet');
  }
  const fullStorage = setup(); failure = 'quota';
  assert.equal(fullStorage.saves.remove('hand:1'), true, 'full storage still allows deletion to free space');
  assert.equal(fullStorage.saves.newGame(), true, 'starting again works when the old auto slot can be removed');
  assert.equal(fullStorage.restarts, 1);
  for (const skipped of [{ playing: false }, { saving: false }, { wastedT: 1 }, { arrest: { active: true } }, { health: { dead: true } }, { inHeli: {} }]) {
    const f = setup(skipped); failure = 'quota';
    assert.equal(f.autosave(), undefined, 'deliberately skipped autosave is distinct from a failed write');
    assert.equal(f.saves.exit(), true, 'exit still works in intentional skip states, including test runs before playing');
    assert.equal(f.restarts, 1);
  }
  for (const action of ['save', 'load', 'newGame', 'exit']) {
    const f = setup();
    assert.equal(f.saves[action]('hand:1'), true);
    assert.equal(f.restarts, action === 'save' ? 0 : 1);
    if (action === 'load') assert.deepEqual(api.readSave('auto', 'test'), selected);
    if (action === 'save') assert.deepEqual(api.readSave('hand:new', 'test'), game);
    if (action === 'newGame') assert.equal(api.readSave('auto', 'test'), null);
    if (action === 'exit') assert.deepEqual(api.readSave('auto', 'test'), game);
  }

  // Run the real saved-games section, without unrelated settings/media setup.
  class Element {
    children = []; listeners = {}; attributes = {}; hidden = false; text = '';
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text; }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(key, value) { this.attributes[key] = value; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    click() { for (const fn of this.listeners.click ?? []) fn(); }
  }
  const settings = await readFile(new URL('../src/settings.ts', import.meta.url), 'utf8');
  const section = settings.slice(settings.indexOf('  const savesBox ='), settings.indexOf('  const feedback ='));
  assert.ok(section.includes('Saved games'));
  const factory = new Function('el', 'rows', 'relabel', 'refresh', 'saves', 't', 'describe', 'update', compile(`${section}\nreturn { box: savesBox, status: saveStatus };`));
  const controls = saves => {
    const relabel = [], refresh = [], rows = new Element();
    const update = () => { for (const fn of refresh) fn(); };
    const el = (tag, cls, parent, text = '') => { const e = new Element(); e.tag = tag; e.className = cls; e.textContent = text; return parent.appendChild(e); };
    const ui = factory(el, rows, relabel, refresh, saves, t, api.describe, update);
    const label = () => { for (const fn of relabel) fn(); update(); };
    const all = node => [node, ...node.children.flatMap(all)];
    label();
    return { ...ui, label, click(text, confirm = false) { const b = all(rows).find(e => e.tag === 'button' && e.textContent === text); assert.ok(b, text); b.click(); if (confirm) b.click(); } };
  };
  for (const [action, label] of [['save', 'Save game'], ['load', 'Load'], ['remove', 'Delete'], ['newGame', 'New game'], ['exit', 'Exit to main menu']]) {
    const f = setup(), ui = controls(f.saves);
    failure = action === 'remove' || action === 'newGame' ? 'blocked' : 'quota';
    ui.click(label, action !== 'save');
    assert.equal(ui.status.attributes.role, 'status');
    assert.equal(ui.status.hidden, false, `${action}: failure is visible inside the dialog`);
    assert.ok(ui.status.textContent.includes('Try again') || ui.status.textContent.includes('try again'));
    const english = ui.status.textContent;
    setLang('cs'); ui.label();
    assert.notEqual(ui.status.textContent, english, 'the error follows the selected language');
    setLang('en'); ui.label();
    failure = ''; ui.label(); ui.click(label, action !== 'save');
    assert.equal(ui.status.hidden, true, `${action}: a successful retry clears the failure note`);
    assert.equal(ui.status.textContent, '');
  }
  console.log('Save failures: quota/access errors preserve progress and slots, prevent success telemetry/reloads, keep autosave skips quiet, and show localized retry status for all manual actions.');
} finally { await server.close(); }
