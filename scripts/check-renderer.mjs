#!/usr/bin/env node
// Reproduce a pending requestDevice and check startup recovery, including disposal
// of a device that arrives after the timeout. Uses Chrome on a WebGPU-capable host.
import { spawnSync } from 'node:child_process';
const arg = process.argv.indexOf('--url');
const url = (arg >= 0 ? process.argv[arg + 1] : null) || 'http://localhost:5201/';
for (const late of [false, true]) {
  const init = `(() => {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(...args) {
      window.__fixtureRequested = true;
      if (!${late}) return new Promise(() => {});
      const delay = new Promise(resolve => setTimeout(resolve, 18000));
      const device = await request.apply(this, args), destroy = device.destroy.bind(device);
      device.destroy = () => { window.__lateDestroyed = true; destroy(); };
      await delay;
      return device;
    };
  })()`;
  const check = `(() => {
    if (!window.__fixtureRequested || window.__drive.renderer.backend) throw new Error('Pending device did not recover with the legacy renderer');
    if (${late} && !window.__lateDestroyed) throw new Error('Late GPU device was not released');
    return 'Renderer recovery passed: ${late ? 'late device released' : 'pending device'}';
  })()`;
  const run = spawnSync(process.execPath, ['scripts/bench.mjs','--url',url,'--scenes','stand',
    '--seconds','1','--dpr','1','--init',init,'--eval',check,'--load-progress','--stack',
    '--shot',`/tmp/renderer-recovery-${late ? 'late' : 'pending'}.png`], {encoding:'utf8'});
  process.stdout.write(run.stdout || '');
  process.stderr.write(run.stderr || '');
  if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
}
