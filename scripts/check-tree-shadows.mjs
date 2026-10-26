#!/usr/bin/env node
// Offline topology/lifecycle checks; --url adds real WebGPU/WebGL pass checks and seasonal shots.
// URL policy: --search "?graphics=ultra&treeShadows=full" --expect-full.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as THREE from 'three';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
const searchAt = process.argv.indexOf('--search');
const search = searchAt >= 0 ? process.argv[searchAt + 1] : '';
globalThis.location = { search }; globalThis.self = globalThis;
const { treePageFactory, SIMPLE_TREE_SHADOWS } = await import('../src/map/vegetation.ts');
const initialMode = SIMPLE_TREE_SHADOWS.value;
assert.equal(initialMode, !process.argv.includes('--expect-full'), 'simple by default, full only by explicit override');
const factory = treePageFactory(), camera = new THREE.Camera(), shadowCamera = new THREE.Camera();
const counts = [];
try {
  for (let kind = 0; kind < 4; kind++) {
    const mesh = factory.create(kind, 16), sibling = factory.create(kind, 16);
    const g = mesh.geometry, index = g.index, position = g.getAttribute('position');
    const full = { ...g.drawRange }, simple = g.userData.simpleShadowRange;
    counts.push({ kind, full: Number.isFinite(full.count) ? full.count / 3 : index.count / 3, simple: simple ? simple.count / 3 : null });
    if (simple) {
      assert.ok(simple.count < full.count);
      assert.equal(simple.start, full.count);
      assert.equal(simple.start + simple.count, index.count);
      // The simplified triangles use original vertices, and retain each tuft's
      // coordinate/seed interpolation and winding. The core is unchanged.
      const tuft = g.getAttribute('tuft');
      for (let i = simple.start; i < index.count; i += 3) {
        const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
        assert.ok(ids.every(id => id >= 0 && id < position.count));
        const seeds = ids.map(id => tuft.getZ(id));
        assert.ok(seeds.every(seed => seed === seeds[0]), 'triangle stays within its original tuft/core');
        const [a, b, c] = ids.map(id => new THREE.Vector3().fromBufferAttribute(position, id));
        const face = b.sub(a).cross(c.sub(a));
        assert.ok(face.lengthSq() > 1e-12, 'nondegenerate shadow triangle');
        assert.ok(face.dot(new THREE.Vector3().fromBufferAttribute(g.getAttribute('normal'), ids[0])) > 0, 'outward triangle winding');
      }
      for (const on of [false, true, false, true]) {
        SIMPLE_TREE_SHADOWS.value = on;
        mesh.onBeforeShadow(null, mesh, camera, shadowCamera);
        assert.deepEqual(g.drawRange, on ? simple : full);
        assert.deepEqual(sibling.geometry.drawRange, full, 'another page retains its own range');
        mesh.onBeforeRender(null, null, shadowCamera);
        assert.deepEqual(g.drawRange, on ? simple : full, 'WebGPU before-render hook preserves shadow range');
        mesh.onAfterShadow();
        assert.deepEqual(g.drawRange, full);
        assert.equal(g.index, index, 'no index allocation/swap');
        assert.equal(g.getAttribute('position'), position);
      }
      SIMPLE_TREE_SHADOWS.value = true;
      mesh.onBeforeShadow(null, mesh, camera, shadowCamera);
      mesh.onBeforeRender(null, null, camera); // recovery after an interrupted shadow render
      assert.deepEqual(g.drawRange, full);
    } else {
      SIMPLE_TREE_SHADOWS.value = true;
      mesh.onBeforeShadow(null, mesh, camera, shadowCamera);
      assert.deepEqual(g.drawRange, full, 'shrubs/conifers unchanged');
    }
    g.dispose(); mesh.dispose(); sibling.geometry.dispose(); sibling.dispose();
  }
} finally { SIMPLE_TREE_SHADOWS.value = initialMode; factory.dispose(); }
console.log('Tree shadow topology and range lifecycle passed:', JSON.stringify(counts));

async function browserCheck() {
  const d = window.__drive, t = window.__test;
  const path = '/src/map/vegetation.ts';
  const url = performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === path).at(-1)?.name || path;
  const { SIMPLE_TREE_SHADOWS: toggle } = await import(url);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const webgpu = !!d.renderer.backend?.isWebGPUBackend;
  check(webgpu || d.renderer.isWebGLRenderer, 'WebGPU or legacy WebGL required');
  const was = toggle.value, paused = t.paused, date = t.probe().date;
  const target = webgpu ? d.renderer.backend : d.renderer;
  const method = webgpu ? 'draw' : 'renderBufferDirect';
  const draw = target[method];
  let capture = null;
  const meshes = new Set();
  target[method] = function(...args) {
    const object = webgpu ? args[0].object : args[4];
    if (capture && meshes.has(object)) {
      const camera = webgpu ? args[0].camera : args[0];
      const pass = camera === d.sky.sun.shadow.camera ? 'shadow' : 'main';
      const geometry = webgpu ? args[0].geometry : args[2];
      const params = webgpu ? args[0].getDrawParameters() : { firstVertex: geometry.drawRange.start, vertexCount: Math.min(geometry.drawRange.count, geometry.index.count), instanceCount: object.count };
      capture[pass].push({ id: object.uuid, start: params.firstVertex, count: params.vertexCount, instances: params.instanceCount });
    }
    return draw.apply(this, args);
  };
  const result = [];
  try {
    t.paused = true;
    await t.go('petrin'); t.time('14:00'); t.weather('clear');
    for (const p of d.world.trees.pages) meshes.add(p.mesh);
    for (const season of ['spring', 'summer', 'autumn', 'winter', 'snow']) {
      t.season(season === 'snow' ? 'winter' : season);
      d.weather.set(season === 'snow' ? 'snow' : 'clear', true);
      const states = [];
      for (const on of [false, true, false]) {
        toggle.value = on;
        await t.frames(3); // warm actual shadow pass (render() in the same frame can skip it)
        capture = { main: [], shadow: [] };
        await t.frames(1);
        states.push(capture); capture = null;
        if (states.length < 3) await t.shot(`tree-shadows-${webgpu ? 'gpu' : 'gl'}-${season}-${on ? 'simple' : 'full'}`);
      }
      check(states.every(s => s.main.length && s.shadow.length), 'both passes drew trees');
      check(JSON.stringify(states[0].main) === JSON.stringify(states[1].main), 'main pass unchanged');
      check(JSON.stringify(states[0]) === JSON.stringify(states[2]), 'switching back restores both passes');
      check(states[0].shadow.length === states[1].shadow.length, 'no extra shadow draws');
      const sum = rows => rows.reduce((n, r) => n + r.count * r.instances / 3, 0);
      check(sum(states[1].shadow) < sum(states[0].shadow), 'fewer submitted shadow triangles');
      result.push({ season, mainTriangles: sum(states[0].main), fullShadowTriangles: sum(states[0].shadow), simpleShadowTriangles: sum(states[1].shadow), shadowDraws: states[0].shadow.length });
      for (const p of d.world.trees.pages) check(p.mesh.geometry.drawRange.start === 0, 'visible range restored');
    }
    return result;
  } finally { capture = null; target[method] = draw; toggle.value = was; t.season(date); t.paused = paused; }
}
const at = process.argv.indexOf('--url');
if (at >= 0) {
  const result = spawnSync(process.execPath, ['scripts/scene.mjs', 'eval', `return await (${browserCheck.toString()})()`, '--url', process.argv[at + 1]], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
