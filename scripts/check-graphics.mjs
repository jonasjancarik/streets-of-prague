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
