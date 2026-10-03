#!/usr/bin/env node
// Tram obstruction recovery uses a straight track so traffic/map randomness cannot
// hide a deadlock. The DOM harness also verifies the mobile board toggle survives updates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (url.includes('/src/') && url.endsWith('.ts')) {
    const source = 'import.meta.env = {};\n' + fs.readFileSync(new URL(url), 'utf8');
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  }
  return next(url, context);
} });
globalThis.location = { search: '?lang=en' };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'en' }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { querySelectorAll: () => [], documentElement: { lang: 'en' } };
const { Trams, HALF } = await import('../src/trams.ts');
const { StopBoard } = await import('../src/board.ts');
const THREE = await import('three');
const trams = new Trams([], new THREE.Scene(), { clock: { hour: 14, kind: 'weekday' }, rng: () => .5 });
const path = { length: 1000, wrap: s => (s + 1000) % 1000, ahead: (a, b) => (b - a + 1000) % 1000, at: s => ({ x: s, y: 0, ang: 0 }) };
const line = { path, halts: [{ s: 500, name: 'Test stop', dwell: 18 }], limitS: [0], limitV: [10], ref: '22', from: 'Start', to: 'End', ends: [0, 900], trams: [] };
for (const [mode, visible, seconds] of [['loose', true, 16], ['traffic', false, 13], ['traffic', true, 31], ['player', false, 65]]) {
  const car = { x: HALF + 1, y: 0, r: 1, mode };
  const v = { line, s: 0, speed: 0, dwell: 0, halt: 0, held: 0, blocker: null, shove: null, ghost: 0, spotted: 0, stuck: 0, parts: [{}, { x: 0, y: 0 }] };
  const near = () => [{ kind: mode === 'player' ? 'player' : 'car', ...car, car }];
  for (let n = 0; n < (seconds - 2) * 60; n++) trams.step(v, 1 / 60, near, () => visible);
  assert.equal(v.shove, null, `${mode}: wait before recovery`);
  for (let n = 0; n < 180; n++) trams.step(v, 1 / 60, near, () => visible);
  if (mode === 'player') assert.equal(v.shove, null, 'never push a player car as recovery');
  else { assert.equal(v.shove, car, `${mode}: blocker selected for recovery`); assert(v.s > 0, 'tram resumes movement'); }
}
const classes = new Set();
const toggle = { setAttribute(key, value) { this[key] = value; } };
const el = { innerHTML: '', hidden: true, classList: { toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, remove(k) { classes.delete(k); } }, querySelector: () => toggle, addEventListener(name, fn) { this[name] = fn; } };
globalThis.Element = class { closest() { return toggle; } };
const board = new StopBoard({ lines: [line] }, el);
board.render('Test stop', []);
assert(el.innerHTML.includes('aria-expanded="false"'));
el.click({ target: new Element() });
assert(classes.has('expanded'));
board.render('Test stop', []);
assert(el.innerHTML.includes('aria-expanded="true"'), 'expansion survives render');
board.t = 0; board.update(.3, 9000, 0, true);
assert(el.hidden, 'board disappears away from stops');
board.t = 0; board.update(.3, 500, 0, true);
assert(!classes.has('expanded') && !board.expanded, 'new stop starts compact');
console.log('Transit feedback: parked/traffic blocker recovery, visible queue patience, player safety, timetable expansion and reset passed');
