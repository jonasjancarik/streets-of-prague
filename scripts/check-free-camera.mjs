// Free-camera pointer checks with the real handlers and a simulated canvas.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
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
globalThis.document = { pointerLockElement: null };
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
globalThis.requestAnimationFrame = done => { queueMicrotask(() => done(performance.now())); return 0; };
const { setupTestkit } = await import('../src/testkit.ts');

const listeners = new Map();
const t = setupTestkit({
  view0: () => ({ x: 0, y: 0, height: 100 }),
  canvas: { clientHeight: 800, addEventListener: (name, fn) => listeners.set(name, fn) },
  fov: 38,
}, {});
function pointer(name, args) {
  listeners.get(name)({ pointerType: 'mouse', pointerId: 1, button: 0, clientX: 0, clientY: 0, ...args });
}

await t.camera({ height: 100, level: true });
pointer('pointerdown');
pointer('pointermove', { clientX: 80 });
assert.ok(t.cam.x < 0 && Math.abs(t.cam.y) < 1e-10, 'north-up pan follows the horizontal screen axis');
pointer('lostpointercapture');
const pivot = [t.cam.x, t.cam.y];
pointer('pointermove', { clientX: 160 });
assert.deepEqual([t.cam.x, t.cam.y], pivot);
pointer('pointerdown', { shiftKey: true });
pointer('pointermove', { clientX: 360, clientY: -150 });
pointer('pointerup');
assert.equal(t.cam.heading, 90);
assert.equal(t.cam.tilt, 30);
assert.deepEqual([t.cam.x, t.cam.y], pivot);
assert.ok(Math.abs(t.cam.height / Math.cos(Math.PI / 6) - 100) < 1e-10, 'tilt preserves the distance to the pivot');
pointer('pointerdown');
pointer('pointermove', { clientX: 80 });
pointer('pointerup');
assert.ok(Math.abs(t.cam.x - pivot[0]) < 1e-10 && t.cam.y > pivot[1], 'east-up pan follows the rotated screen axis');
console.log('Free camera: screen-aligned panning, capture cleanup, and constant-distance orbit passed.');
