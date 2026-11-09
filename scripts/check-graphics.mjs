#!/usr/bin/env node
// Runtime regression checks for graphics switches, using the same Chrome and map
// loading as the benchmark. Run against a dev server: node scripts/check-graphics.mjs
// --url http://localhost:5201/ (also covers the legacy WebGL renderer).
import { spawnSync } from 'node:child_process';
const arg = process.argv.indexOf('--url');
const url = (arg >= 0 ? process.argv[arg + 1] : null) || 'http://localhost:5201/';
const check = `(async () => {
  const d = window.__drive, r = d.renderer, g = d.graphics;
  const { DIRT, LEAVES, ROOF_DETAIL } = await import('/src/shading.ts');
  const { LAMP_SHADOWS } = await import('/src/lamps.ts');
  const { AutoTier } = await import('/src/graphics.ts');
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  for (const [tier, size, samples, look, cars, crowd, blur] of [
    ['lowest',1024,0,0,0,0.5,1], ['high',2048,4,1,2,1,1], ['ultra',4096,4,1,3,1,2],
    ['low',1024,4,1,1,1,1], ['medium',2048,4,1,1,1,1], ['lowest',1024,0,0,0,0.5,1],
  ]) {
    g.set(tier);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert(d.sky.sun.shadow.mapSize.x === size, tier + ': requested shadow size');
    assert(d.sky.sun.shadow.map.width === size, tier + ': actual shadow size');
    assert(d.sky.sun.shadow.radius === blur, tier + ': shadow edge softening');
    assert(DIRT.value === look && LEAVES.value === look && ROOF_DETAIL.value === look, tier + ': detail');
    assert(LAMP_SHADOWS.value === cars && g.crowd === crowd, tier + ': lamps/crowd');
    assert(r.getPixelRatio() === 1, tier + ': fixed DPR');
    if (r.backend?.isWebGPUBackend) {
      const target = r._frameBufferTargets.get(r._canvasTarget);
      assert(r.samples === samples && target.samples === samples, tier + ': canvas MSAA');
      assert(r.backend.get(r._textures.get(target).depthTexture).texture.sampleCount === (samples || 1), tier + ': actual MSAA depth texture');
    } else assert(r.getContext().getContextAttributes().antialias, tier + ': WebGL MSAA');
  }
  const auto = new AutoTier('high', () => false);
  let next;
  for(let i=0;i<60;i++) next=auto.record(35, 1000+i*35);
  assert(next === 'medium', 'Auto steps down');
  auto.hold(4000, 4000);
  for(let i=0;i<60;i++) assert(auto.record(35,4000+i) === null,'Auto warmup');
  for(let i=0;i<60;i++) next=auto.record(35,9000+i*35);
  assert(next === 'low', 'Auto can reach the smaller shadow map');
  // Hitches: a quick mean with every sixth frame frozen for 120 ms. One choppy window
  // holds, the second steps down; a frame of a second or more is a pause.
  const choppy = new AutoTier('high', () => false);
  const run = (t0) => { let n = null; for (let i = 0; i < 60; i++) n = choppy.record(i % 6 ? 16 : 120, t0 + i * 34) ?? n; return n; };
  assert(run(1000) === null, 'Auto waits for a second choppy window');
  assert(run(4000) === 'medium', 'Auto steps down when it keeps hitching');
  // A frame rate held at 30 by the browser or the screen: 33 ms between frames, but
  // each frame's work done in 8. Auto holds; with the work taking 30 ms it steps down.
  const capped = new AutoTier('high', () => false);
  for (let w = 0; w < 4; w++) for (let i = 0; i < 60; i++) { const t = 1000 + (w * 60 + i) * 33; capped.work(8, t); assert(capped.record(33, t) === null, 'Auto holds a capped frame rate'); }
  assert(capped.capped === 4 && capped.stuck === 0, 'Capped windows are counted, not stuck');
  const busy = new AutoTier('high', () => false);
  for (let i = 0; i < 60; i++) { busy.work(30, 1000 + i * 33); next = busy.record(33, 1000 + i * 33); }
  assert(next === 'medium' && busy.capped === 0, 'Auto steps down when the frame was working');

  // A frame over 100 ms is put down to the part that took longest, if it took enough of it.
  const { blame, scriptCause } = await import('/src/hitches.ts');
  const before = (o) => ({ began: 0, ended: 0, work: 10, tiles: 0, joined: false, render: 0, built: false, gpu: 0, ...o });
  assert(blame(150, before({ work: 140, render: 120, built: true }), [], true) === 'shaders', 'A long frame that built a shader is the shaders');
  assert(blame(150, before({ work: 140, render: 120 }), [], true) === 'drawing', 'A long drawing without a build is the drawing');
  assert(blame(150, before({ work: 140, render: 20 }), [], true) === 'game', 'A long frame outside the drawing is the game');
  assert(blame(150, before({ work: 140, render: 120, joined: true }), [], true) === 'tiles', 'Drawing a new tile is the tiles');
  assert(blame(150, before({ work: 140, render: 20, gpu: 150 }), [], true) === 'game', 'The GPU only when the main thread does not explain it');
  assert(blame(150, before({ work: 100, tiles: 90 }), [], true) === 'tiles', 'A long tile update is the tiles');
  assert(blame(150, before({ gpu: 130 }), [], true) === 'gpu', 'A long GPU frame is the GPU');
  assert(blame(150, before(), [{ start: 0, ms: 120, cause: scriptCause({ invoker: 'Worker.onmessage', sourceURL: 'https://x/assets/index-a.js' }) }], true) === 'tiles', 'A worker reply between frames is the tiles');
  assert(blame(150, before(), [{ start: 0, ms: 120, cause: scriptCause({ invoker: 'Promise.then', sourceURL: 'https://x/assets/three.webgpu-b.js' }) }], true) === 'shaders', 'A three.js script between frames is the shaders');
  assert(blame(150, before(), [], true) === 'waiting' && blame(150, before(), [], false) === 'unknown', 'Nothing timed is waiting, or unknown without long animation frames');
  const paused = new AutoTier('high', () => false);
  for (let w = 0; w < 3; w++) for (let i = 0; i < 60; i++) assert(paused.record(i ? 16 : 5000, 1000 + w * 2000 + i * 20) === null, 'A pause is not a hitch');
  g.set('ultra');
  g.set('auto');
  assert(g.tier === 'high', 'Auto goes no higher than High');
  g.set('high');
  return 'Graphics checks passed: ' + (r.backend ? 'WebGPU' : 'WebGL');
})()`;
for (const extra of ['', '&renderer=webgl&dev']) {
  const run = spawnSync(process.execPath, ['scripts/bench.mjs', '--url', url,
    '--scenes','stand','--dpr','1','--seconds','1','--extra',extra,'--eval',check,'--stack', ...(extra ? [] : ['--require-webgpu'])],
  {encoding:'utf8'});
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
}
