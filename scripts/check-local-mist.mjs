#!/usr/bin/env node
// Actual WebGPU rendering, including depth/stencil and live MSAA changes.
// Uses the existing bench loader; run against an idle dev server.
import { spawnSync } from 'node:child_process';
const index = process.argv.indexOf('--url');
const url = index < 0 ? 'http://localhost:5191/' : process.argv[index + 1];
const check = `(async () => {
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { RenderTarget } = await import('/node_modules/.vite/deps/three_webgpu.js');
  // Vite can version an edited dependency. Use the URL already loaded by the
  // game so this fixture shares its registered WebGPU material factory.
  const mistURL = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/localmist.ts')?.name;
  if (!mistURL) throw new Error('The game did not load localmist.ts');
  const { LocalMistVolume, LOCAL_MIST, MIST_MODE } = await import(mistURL);
  const renderer = window.__drive.renderer;
  const assert = (ok, text) => { if (!ok) throw new Error(text); };
  assert(renderer.backend?.isWebGPUBackend, 'WebGPU is required');
  const saved = { ...LOCAL_MIST }, mode = MIST_MODE.value;
  const paused = window.__test.paused;
  window.__test.paused = true;
  MIST_MODE.value = 'volume';
  Object.assign(LOCAL_MIST, { density: 1.5, width: 40, length: 28, spacing: 64, low: 0.15, high: 2.2 });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  const fog = { value: new THREE.Color(1, 1, 1) }, time = { value: 0 };
  const mist = new LocalMistVolume(scene, time, fog);
  assert(mist.mesh, 'The loaded module has no WebGPU mist factory');
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(0, 1, -30); camera.lookAt(0, 1, 0);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshBasicMaterial({ color: 0, side: THREE.DoubleSide }));
  wall.position.y = 1;
  scene.add(wall);
  const target = new RenderTarget(64, 64, { depthBuffer: true, stencilBuffer: true, samples: 4 });
  const pixel = async (z, on = true) => {
    wall.position.z = z;
    mist.update(on ? 1 : 0, 0, 0, 0, 30, () => 0);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    const bytes = await renderer.readRenderTargetPixelsAsync(target, target.width / 2 - 2, target.height / 2 - 2, 4, 4);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += bytes[i * 4];
    return sum / 16;
  };
  const results = [];
  try {
    for (const samples of [4, 0, 4, 0]) {
      target.samples = samples;
      const clear = await pixel(-20, false);
      const occluded = await pixel(-20);
      const within = await pixel(0);
      const behind = await pixel(20);
      assert(Math.abs(occluded - clear) < 2, 'mist leaks through a foreground wall: ' + [clear, occluded]);
      assert(within > clear + 10, 'mist in front of a wall is missing: ' + [clear, within]);
      assert(behind >= within - 3, 'a longer path through mist is thinner: ' + [within, behind]);
      camera.position.z = 0; camera.lookAt(0, 1, 20);
      const inside = await pixel(20);
      assert(inside > clear + 10, 'mist disappears inside a volume: ' + inside);
      camera.position.z = -30; camera.lookAt(0, 1, 0);
      results.push({ samples: samples || 1, clear, occluded, within, behind, inside });
    }
    target.setSize(80, 80);
    assert(await pixel(0) > 10, 'mist disappears after resize');
    mist.update(1, 0, 0, 0, 30, () => 0);
    const geometry = mist.mesh.geometry, positions = geometry.attributes.position;
    const centres = Array.from(geometry.attributes.mistCentre.array);
    mist.update(1, 0.1, 2, 2, 30, () => 0);
    assert(mist.mesh.geometry === geometry && geometry.attributes.position === positions, 'moving the view replaces mist buffers');
    assert(centres.every((v, i) => v === geometry.attributes.mistCentre.array[i]), 'banks follow the camera instead of staying in the world');
    mist.update(0, 0.2, 2, 2, 30, () => 0);
    assert(!mist.mesh.visible, 'mist remains visible in clear weather');
    return { message: 'Local mist depth, inside-volume, MSAA, resize and world-placement checks passed', results };
  } finally {
    renderer.setRenderTarget(null);
    target.dispose(); wall.geometry.dispose(); wall.material.dispose();
    mist.mesh.geometry.dispose(); mist.mesh.material.dispose();
    Object.assign(LOCAL_MIST, saved); MIST_MODE.value = mode;
    window.__test.paused = paused;
  }
})()`;
const run = spawnSync(process.execPath, ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1',
  '--weather', 'clear', '--time', '14:00', '--graphics', 'high', '--require-webgpu', '--eval', check, '--stack'], { encoding: 'utf8' });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
