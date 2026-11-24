// Lamp reflections must not become floating ground overlays, even on wet ground.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
const { LightFx, setBeamShade, setGlintShade } = await import('../src/lightfx.ts');
setBeamShade(() => new THREE.MeshBasicMaterial());
setGlintShade(() => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
const scene = new THREE.Scene(), fx = new LightFx(scene);
const eye = new THREE.Vector3(10, 4, 0), colour = new THREE.Color('white');
const glints = scene.children.find(m => m.geometry.type === 'PlaneGeometry');
assert.ok(glints);
for (const wet of [0, 0.5, 1]) {
  fx.begin(eye, 1, wet, 0);
  fx.lamp(0, 0, 0, 7.5, colour, 1, new Map(), new Float32Array(), [], []);
  fx.commit();
  assert.equal(glints.count, 0, `wet=${wet}: ground reflections belong to surface materials`);
}
// A car roof at the reflected ray's intersection still catches its small glint.
const x = 10 * 6 / 8.5;
const car = { x, y: 0, h: 0, spec: { L: 4, W: 2, H: 1.5 } };
fx.begin(eye, 1, 0, 0);
fx.lamp(0, 0, 0, 7.5, colour, 1, new Map([[0, [0]]]), new Float32Array([x, 0, 0]), [car], [0]);
fx.commit();
assert.equal(glints.count, 1, 'car roof retains its glint');
assert.equal(glints.instanceMatrix.array[13], Math.fround(1.55), 'glint stays on the roof');
assert.equal(glints.material.depthTest, true, 'foreground geometry can hide a roof glint');
console.log('Lamp glints: no ground overlays; car-roof highlight retained.');
