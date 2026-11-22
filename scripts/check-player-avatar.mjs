// Check the real avatar selection without loading models or starting a GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import * as THREE from 'three';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.self = globalThis;
globalThis.location = { search: '' };
const { LifeSize } = await import('../src/rocketbox.ts');

function selected(seed, firstGroup = 0) {
  const avatars = new LifeSize(new THREE.Scene(), null);
  avatars.on = true;
  avatars.ids_ = firstGroup;
  // Distinct loaded indices also catch confusing catalogue and load order.
  avatars.baseKinds = Array.from({ length: 14 }, (_, i) => 13 - i);
  avatars.kinds = avatars.baseKinds.map(() => ({ template: new THREE.Group(), standing: ['idle'], clips: { idle: { duration: 1 }, umbrella: { duration: 1 } } }));
  avatars.pose = () => {};
  let choice;
  avatars.take = kind => {
    choice = kind;
    return { kind, pos: new THREE.Vector3(), last: new THREE.Vector3(), turn: new THREE.Quaternion(), t: {}, w: {}, want: {} };
  };
  const fig = { self: true, avatarSeed: seed };
  const claim = () => assert.equal(avatars.claim(fig, 0, new THREE.Matrix4(), { name: 'idle', phase: 0 }, -1), true);
  claim();
  const initial = choice;
  // Leaving a camera view releases the live model; returning claims it again.
  avatars.live.clear();
  avatars.ids = new WeakMap();
  avatars.ids_ += 5;
  claim();
  assert.equal(choice, initial, 'camera switches retain the chosen avatar');
  avatars.live.clear();
  avatars.dispose();
  return choice;
}

const choices = new Set();
for (let seed = 0; seed < 14; seed++) {
  const choice = selected(seed);
  assert.equal(selected(seed, 9), choice, 'render order and model reloads preserve identity');
  choices.add(choice);
}
assert.equal(choices.size, 14, 'session seeds can select every avatar');
console.log('Player avatar: all 14 choices, camera switches, render order and model reloads passed.');
