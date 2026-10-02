#!/usr/bin/env node
// Browser regression checks for retained tree pages. Use the game's real renderer:
// node scripts/check-tree-pool.mjs --url http://localhost:5239/ --case all
import { spawnSync } from 'node:child_process';

const get = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const url = get('--url', 'http://localhost:5239/');
const mode = get('--case', 'all');
if (!['lifecycle', 'render', 'all'].includes(mode)) {
  console.error('--case must be lifecycle, render or all');
  process.exit(2);
}

const check = `(async () => {
  const { TreePool } = await import('/src/trees.ts');
  const d = window.__drive;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const make = (b, s, c, offset = 0) => {
    const count = b + s + c;
    const matrices = new Float32Array(count * 16), colours = new Float32Array(count * 3), yearly = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      matrices.set([1,0,0,0, 0,1,0,0, 0,0,1,0, offset+i*2,0,-offset-i*3,1], i*16);
      colours.set([i/1000, (i+1)/1000, (i+2)/1000], i*3);
      yearly[i] = i % 2;
    }
    return { matrices, colours, yearly, count, shrubs: s, conifers: c };
  };
  const hash = (array) => {
    let h = 2166136261;
    for (const value of array) { const n = Math.round(value*100000); h = Math.imul(h ^ n, 16777619) >>> 0; }
    return h;
  };
  const unordered = (array, stride) => hash(Array.from({length: array.length/stride}, (_,i) => hash(array.slice(i*stride,(i+1)*stride))).sort((a,b) => a-b));
  const inspect = (pages, input, capacity) => {
    const starts = [0, input.count-input.shrubs-input.conifers, input.count-input.conifers];
    const ends = [starts[1], starts[2], input.count];
    for (let kind = 0; kind < 3; kind++) {
      const part = pages.filter(p => p.kind === kind);
      assert(part.reduce((sum,p) => sum+p.mesh.count,0) === ends[kind]-starts[kind], 'exact tree count '+kind);
      const gotM = [], gotC = [], gotE = [];
      for (const p of part) {
        gotM.push(...p.mesh.instanceMatrix.array.slice(0,p.mesh.count*16));
        gotC.push(...p.mesh.instanceColor.array.slice(0,p.mesh.count*3));
        gotE.push(...p.mesh.geometry.getAttribute('yearly').array.slice(0,p.mesh.count));
        assert(p.mesh.count <= capacity && p.mesh.visible, 'page capacity and visibility');
        assert(p.mesh.boundingSphere && p.mesh.boundingBox, 'fresh bounds');
      }
      assert(unordered(gotM,16) === unordered(input.matrices.slice(starts[kind]*16,ends[kind]*16),16), 'matrices '+kind);
      assert(unordered(gotC,3) === unordered(input.colours.slice(starts[kind]*3,ends[kind]*3),3), 'colours '+kind);
      assert(unordered(gotE,1) === unordered(input.yearly.slice(starts[kind],ends[kind]),1), 'yearly '+kind);
    }
  };
  const report = [];
  if (${mode !== 'render'}) {
    const pool = new TreePool(d.scene, 4);
    try {
      const empty = make(0,0,0);
      assert(pool.add('empty',empty).length === 0, 'zero trees');
      pool.remove('empty');
      const a = make(7,5,6), b = make(0,5,0,100);
      const ap = pool.add('A',a), bp = pool.add('B',b);
      inspect(ap,a,4); inspect(bp,b,4);
      assert(pool.add('A',a) === ap && pool.leases.size === 2, 'duplicate add');
      const before = pool.pages.map(p => [p.mesh.uuid,p.mesh.instanceMatrix,p.mesh.instanceColor,p.mesh.geometry.getAttribute('yearly')]);
      const versions = pool.pages.map(p => [p.mesh.instanceMatrix.version,p.mesh.instanceColor.version,p.mesh.geometry.getAttribute('yearly').version]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      assert(pool.pages.every((p,i) => versions[i].every((v,j) => v === [p.mesh.instanceMatrix.version,p.mesh.instanceColor.version,p.mesh.geometry.getAttribute('yearly').version][j])), 'unchanged frames do not dirty arrays');
      pool.remove('A');
      inspect(bp,b,4);
      assert(ap.every(p => !p.mesh.visible && p.mesh.count === 0), 'released pages invisible');
      const c = make(6,0,5,10000), cp = pool.add('C',c);
      inspect(cp,c,4); inspect(bp,b,4);
      assert(pool.pages.length === before.length, 'reuse needs no allocation');
      assert(cp.some(p => ap.includes(p)), 'distant C reuses A');
      assert(cp.some(p => p.mesh.boundingSphere.center.length() > 1000), 'reused bounds move');
      assert(pool.pages.every((p,i) => before[i][0] === p.mesh.uuid && before[i][1] === p.mesh.instanceMatrix && before[i][2] === p.mesh.instanceColor && before[i][3] === p.mesh.geometry.getAttribute('yearly')), 'UUID and attributes stable');
      pool.remove('C'); pool.remove('B');
      assert(pool.stats().active.every(n => n === 0), 'all leases released');
      const conifers = make(0,0,7,20000);
      inspect(pool.add('conifers',conifers),conifers,4);
      pool.remove('conifers');
      const sole = pool.pages.find(p => p.kind === 0);
      const old = sole.mesh.computeBoundingSphere;
      sole.mesh.computeBoundingSphere = () => { throw new Error('interrupted registration'); };
      try { pool.add('retry',make(1,0,0)); throw new Error('expected failure'); }
      catch (e) { assert(e.message === 'interrupted registration', 'injected failure'); }
      sole.mesh.computeBoundingSphere = old;
      assert(!pool.leases.has('retry') && pool.stats().active.every(n => n === 0), 'failed registration rolled back');
      pool.remove('retry');
      inspect(pool.add('retry',make(1,0,0)),make(1,0,0),4);
      pool.remove('retry');
      report.push('lifecycle '+JSON.stringify(pool.stats()));
    } finally {
      pool.dispose();
      assert(pool.pages.length === 0 && pool.leases.size === 0 && !pool.group.parent, 'final teardown');
    }
  }
  if (${mode !== 'lifecycle'}) {
    assert(d.renderer.backend?.isWebGPUBackend, 'render case needs WebGPU');
    for (const capacity of [16,2048]) {
      const pool = new TreePool(d.scene,capacity);
      try {
        const x = d.walker.x, y = d.walker.y;
        const input = make(2,0,0);
        input.matrices[12] = x; input.matrices[14] = -y;
        input.matrices[28] = x+4; input.matrices[30] = -y-4;
        const page = pool.add('render',input)[0];
        page.mesh.frustumCulled = false;
        await d.renderer.compileAsync(d.scene,d.camera);
        d.renderer.render(d.scene,d.camera);
        page.mesh.frustumCulled = true;
        const restore = pool.prepare([2,0,0]);
        assert(!page.mesh.frustumCulled, 'active page included in startup preparation '+capacity);
        await d.renderer.compileAsync(d.scene,d.camera);
        d.renderer.render(d.scene,d.camera);
        restore();
        assert(page.mesh.frustumCulled, 'active culling restored '+capacity);
        const warmed = pool.pages.find(p => p.kind === 0 && p.owner === null);
        assert(warmed && !warmed.mesh.visible && warmed.mesh.count === 0, 'empty prepared page hidden '+capacity);
        const beforePreparedUse = d.renderer._nodes.nodeBuilderCache.size;
        pool.add('prepared',input);
        warmed.mesh.frustumCulled = false;
        d.renderer.render(d.scene,d.camera);
        assert(d.renderer._nodes.nodeBuilderCache.size === beforePreparedUse, 'prepared first use adds no builder '+capacity);
        pool.remove('prepared');
        const uuid = page.mesh.uuid, matrices = page.mesh.instanceMatrix;
        const builders = d.renderer._nodes.nodeBuilderCache.size;
        pool.remove('render');
        pool.add('render',input);
        page.mesh.frustumCulled = false;
        d.renderer.render(d.scene,d.camera);
        assert(page.mesh.uuid === uuid && page.mesh.instanceMatrix === matrices, 'render reuse stable '+capacity);
        assert(d.renderer._nodes.nodeBuilderCache.size === builders, 'reuse adds no builder states '+capacity);
        report.push('render '+capacity+' '+JSON.stringify(pool.stats()));
      } finally { pool.dispose(); }
    }
  }
  return report.join('; ');
})()`;

const run = spawnSync(process.execPath, ['scripts/bench.mjs', '--url', url,
  '--scenes', 'woods', '--seconds', '1', '--dpr', '1', '--eval', check,
  '--stack', '--require-webgpu'], { encoding: 'utf8' });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
