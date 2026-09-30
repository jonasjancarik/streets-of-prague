#!/usr/bin/env node
// Check converted WebGPU materials in the running game, with the same Chrome and
// map loading as bench.mjs. Use --case graphs|bindings|all and --url <dev server>.
import { spawnSync } from 'node:child_process';

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const url = option('--url', 'http://localhost:5191/');
const selected = option('--case', 'all');
const layout = option('--layout', 'ipr');
if (!['graphs', 'bindings', 'all'].includes(selected) || !['ipr', 'osm'].includes(layout) || !url) {
  console.error('Usage: check-material-sharing.mjs [--url URL] [--case graphs|bindings|all] [--layout ipr|osm]');
  process.exit(2);
}

const check = `(async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const TSL = await import('/node_modules/.vite/deps/three_tsl.js');
  const { lampLit } = await import('/src/webgpu/lamps.ts');
  const renderer = window.__drive.renderer;
  assert(renderer.backend?.isWebGPUBackend, 'WebGPU is required');
  const converted = (key, options = {}, Material = THREE.MeshLambertMaterial) => {
    const legacy = new Material(options);
    legacy.customProgramCacheKey = () => key;
    const node = renderer.library.fromMaterial(legacy);
    assert(node !== legacy, key + ': conversion failed');
    return { legacy, node };
  };
  if ('${selected}' !== 'bindings') {
    const [a, b] = [converted('buildings-procedural'), converted('buildings-procedural')];
    for (const property of ['colorNode', 'aoNode', 'emissiveNode'])
      assert(a.node[property] === b.node[property], 'building ' + property + ' is duplicated');
    assert(a.node.customProgramCacheKey() === b.node.customProgramCacheKey(), 'building material cache keys differ');
    const [cutA, cutB] = [
      converted('cut-depth-ground', { colorWrite: false, side: THREE.DoubleSide }, THREE.MeshBasicMaterial),
      converted('cut-depth-ground', { colorWrite: false, side: THREE.DoubleSide }, THREE.MeshBasicMaterial),
    ];
    assert(cutA.node.maskNode === cutB.node.maskNode, 'cutaway mask is duplicated');
    assert(cutA.node.emissiveNode === cutB.node.emissiveNode, 'cutaway lighting is duplicated');
    assert(cutA.node.customProgramCacheKey() === cutB.node.customProgramCacheKey(), 'cutaway cache keys differ');
    const [roofA, roofB] = [converted('landmark-roof'), converted('landmark-roof')];
    for (const property of ['maskNode', 'colorNode', 'emissiveNode'])
      assert(roofA.node[property] === roofB.node[property], 'landmark ' + property + ' is duplicated');
    assert(roofA.node.customProgramCacheKey() === roofB.node.customProgramCacheKey(), 'landmark cache keys differ');
    const first = a.node.emissiveNode;
    lampLit(a.node);
    assert(a.node.emissiveNode === first, 'repeated lampLit added the light twice');
    const extraA = converted('lamp-pole').node;
    const extraB = converted('lamp-pole').node;
    const e1 = TSL.vec3(0.11, 0.12, 0.13), e2 = TSL.vec3(0.21, 0.22, 0.23);
    extraA.emissiveNode = e1; extraB.emissiveNode = e2;
    lampLit(extraA); lampLit(extraB);
    assert(extraA.emissiveNode !== extraB.emissiveNode, 'different emissive inputs share lighting');
    const worldA = TSL.positionWorld, worldB = worldA.add(TSL.vec3(1, 0, 0));
    const worldLitA = converted('lamp-pole').node, worldLitB = converted('lamp-pole').node;
    worldLitA.emissiveNode = e1; worldLitB.emissiveNode = e1;
    lampLit(worldLitA, worldA); lampLit(worldLitB, worldB);
    assert(worldLitA.emissiveNode !== worldLitB.emissiveNode, 'different world inputs share lighting');
  }
  if ('${selected}' !== 'graphs') {
    const layouts = new Map();
    window.__drive.scene.traverse((object) => {
      if (!object.isMesh || Array.isArray(object.material) ||
          object.material?.customProgramCacheKey?.() !== 'buildings-procedural') return;
      const key = [Object.keys(object.geometry.attributes).sort().join(','),
        object.material.side, object.material.vertexColors, Boolean(object.material.map)].join('|');
      const materials = layouts.get(key) || [];
      materials.push(object.material);
      layouts.set(key, materials);
    });
    assert([...layouts.values()].some((materials) => materials.length > 1),
      'the loaded ${layout.toUpperCase()} scene has no equivalent building meshes');
    window.__layoutCounts = [...layouts].map(([key, materials]) => [key, materials.length]);
    for (const materials of layouts.values()) {
      if (materials.length < 2) continue;
      const a = renderer.library.fromMaterial(materials[0]);
      const b = renderer.library.fromMaterial(materials[1]);
      assert(a.colorNode === b.colorNode && a.aoNode === b.aoNode && a.emissiveNode === b.emissiveNode,
        'real building meshes with the same layout use different graphs');
      assert(a.customProgramCacheKey() === b.customProgramCacheKey(),
        'real building meshes with the same layout have different cache keys');
    }
    const { WET, SNOW, WINDOWS, CUTAWAY } = await import('/src/shading.ts');
    const { LAMP_ON } = await import('/src/lamps.ts');
    const prior = { wet: WET.value, snow: SNOW.value, windows: WINDOWS.value,
      cut: CUTAWAY.value.clone(), lamp: LAMP_ON.value };
    const gameLoop = renderer.getAnimationLoop();
    await renderer.setAnimationLoop(null);
    await renderer.backend.device.queue.onSubmittedWorkDone();
    const target = new THREE.WebGLRenderTarget(128, 64);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    scene.add(new THREE.DirectionalLight(0xffffff, 0.6));
    const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.1, 20);
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
    const pixels = async () => {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 128, 64);
      const at = (x) => Array.from(data.slice((32 * 128 + x) * 4, (32 * 128 + x) * 4 + 3));
      return [at(32), at(96)];
    };
    const mesh = (material, x, sky) => {
      const geometry = new THREE.PlaneGeometry(1.5, 1.5);
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array(12).fill(1), 3));
      geometry.setAttribute('sky', new THREE.Float32BufferAttribute(Array(4).fill(sky), 1));
      geometry.setAttribute('facade', new THREE.Float32BufferAttribute([
        0.3, 2, 3, 0, 0.3, 2, 3, 0, 0.3, 2, 3, 0, 0.3, 2, 3, 0,
      ], 4));
      const object = new THREE.Mesh(geometry, material);
      object.position.x = x;
      scene.add(object);
      return object;
    };
    const colored = (rgb) => {
      const map = new THREE.DataTexture(new Uint8Array([...rgb, 255]), 1, 1);
      map.colorSpace = THREE.SRGBColorSpace;
      map.needsUpdate = true;
      return map;
    };
    const difference = (a, b) => a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0);
    try {
      const red = colored([220, 50, 30]), blue = colored([30, 70, 220]);
      const left = converted('landmark-roof', { map: red });
      const right = converted('landmark-roof', { map: blue });
      const leftMesh = mesh(left.legacy, -1, 1), rightMesh = mesh(right.legacy, 1, 1);
      const landmarkPixels = await pixels();
      assert(difference(...landmarkPixels) > 35, 'landmark textures were not distinct after rendering: ' + landmarkPixels);
      scene.remove(leftMesh); left.legacy.dispose(); leftMesh.geometry.dispose(); red.dispose();
      const survivor = await pixels();
      assert(difference(landmarkPixels[1], survivor[1]) < 12, 'surviving landmark texture changed after disposal: ' + survivor);
      scene.remove(rightMesh); right.legacy.dispose(); rightMesh.geometry.dispose(); blue.dispose();

      const low = converted('buildings-procedural');
      const high = converted('buildings-procedural');
      const lowMesh = mesh(low.legacy, -1, 0.05), highMesh = mesh(high.legacy, 1, 1);
      const skyPixels = await pixels();
      assert(difference(...skyPixels) > 8, 'building sky attributes were not distinct after rendering: ' + skyPixels);
      scene.remove(lowMesh); low.legacy.dispose(); lowMesh.geometry.dispose();
      const skySurvivor = await pixels();
      assert(difference(skyPixels[1], skySurvivor[1]) < 12, 'surviving building changed after disposal: ' + skySurvivor);

      WET.value = 1;
      const rainPixels = await pixels();
      assert(difference(skySurvivor[1], rainPixels[1]) > 4, 'rain did not change the static building');
      WET.value = 0; SNOW.value = 1;
      highMesh.geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
        0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
      ], 3));
      const snowPixels = await pixels();
      SNOW.value = 0;
      const dryRoofPixels = await pixels();
      assert(difference(dryRoofPixels[1], snowPixels[1]) > 4, 'snow did not change the static roof: ' + JSON.stringify({ snowPixels, dryRoofPixels }));
      highMesh.geometry.setAttribute('facade', new THREE.Float32BufferAttribute([
        0.5, 0.5, 3, 10, 0.5, 0.5, 3, 10, 0.5, 0.5, 3, 10, 0.5, 0.5, 3, 10,
      ], 4));
      const dayPixels = await pixels();
      WINDOWS.value = 0.3; LAMP_ON.value = 1;
      const nightPixels = await pixels();
      assert(difference(dayPixels[1], nightPixels[1]) > 4, 'night did not change the static roof window: ' + JSON.stringify({dayPixels, nightPixels}));
      scene.remove(highMesh); high.legacy.dispose(); highMesh.geometry.dispose();

      WINDOWS.value = 0; LAMP_ON.value = 0;
      const cutMap = colored([90, 160, 90]);
      const cut = converted('landmark-roof', { map: cutMap });
      const cutMesh = mesh(cut.legacy, 1, 1);
      CUTAWAY.value.set(100, 100, 100, 0);
      const uncut = await pixels();
      CUTAWAY.value.set(1, -1, 0, 0.7);
      const cutPixels = await pixels();
      assert(difference(uncut[1], [0, 0, 0]) > 15 && difference(cutPixels[1], [0, 0, 0]) < 5,
        'cutaway did not update on the static landmark: ' + JSON.stringify({uncut, cutPixels}));
      CUTAWAY.value.set(100, 100, 100, 0);
      const restored = await pixels();
      assert(difference(uncut[1], restored[1]) < 12, 'cutaway did not restore the landmark');
      scene.remove(cutMesh); cut.legacy.dispose(); cutMesh.geometry.dispose(); cutMap.dispose();
      window.__bindingPixels = { landmarkPixels, survivor, skyPixels, skySurvivor, rainPixels, snowPixels, dryRoofPixels, dayPixels, nightPixels, uncut, cutPixels, restored };
    } finally {
      WET.value = prior.wet; SNOW.value = prior.snow; WINDOWS.value = prior.windows;
      CUTAWAY.value.copy(prior.cut); LAMP_ON.value = prior.lamp;
      renderer.setRenderTarget(null); target.dispose();
      for (const object of [...scene.children]) if (object.isMesh) {
        scene.remove(object); object.geometry.dispose(); object.material.dispose();
      }
      await renderer.backend.device.queue.onSubmittedWorkDone();
      await renderer.setAnimationLoop(gameLoop);
    }
  }
  return 'Material sharing ${selected} checks passed (${layout.toUpperCase()}): ' +
    JSON.stringify({ layouts: window.__layoutCounts, pixels: window.__bindingPixels });
})()`;

const run = spawnSync(process.execPath, ['scripts/bench.mjs', '--url', url,
  '--scenes', 'stand', '--seconds', '1', '--dpr', '1', '--graphics', 'high',
  ...(layout === 'osm' ? ['--extra', '&osm'] : []),
  '--loading-frames', '--fresh-browser', '--require-webgpu', '--stack', '--eval', check],
{ encoding: 'utf8' });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
