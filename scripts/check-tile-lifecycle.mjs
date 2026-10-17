#!/usr/bin/env node
// CPU checks of overlapping mesh work, recovered builds and abandoned photo loads.
//   node scripts/check-tile-lifecycle.mjs
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
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
const { TileWorld } = await import('../src/tiles.ts');

function fixture() {
  const jobs = [];
  const world = Object.assign(Object.create(TileWorld.prototype), {
    loaded: new Map(), byIndex: new Map(), sky: new Map(), photos: new Map(), pending: new Map(),
    builds: new Map(), retry: new Map(), jsons: new Map(), buildTimes: [],
    dressing: new Set(), inFlight: new Set(), drawTimes: [], last: { i: NaN },
    onDrop() {}, assemble: () => new Promise((resolve, reject) => jobs.push({ resolve, reject })),
  });
  const tile = () => ({ k: '0_0', i: 0, j: 0, shown: false, drawn: null, dressing: null,
    drawAfter: 0, furniture: [], fixtures: [], poles: [], fences: [] });
  const place = (t) => { world.loaded.set(t.k, t); world.byIndex.set(0, t); };
  return { world, jobs, tile, place };
}

// A successful rebuilt tile clears its earlier failure cooldown. A failed attempt
// retains the cooldown and evicts files so an explicit retry fetches fresh data.
{
  const { world, tile, place } = fixture();
  const recovered = tile();
  world.make = async () => { throw new Error('land job failed'); };
  await assert.rejects(world.build(recovered.k, {}), /land job failed/);
  assert.ok(world.retry.get(recovered.k) > performance.now());
  world.make = async () => { place(recovered); return recovered; };
  await world.build(recovered.k, {});
  assert.equal(world.retry.has(recovered.k), false, 'successful recovery removes obsolete retry state');
}

// Prefetched orthophotos may finish after their files were abandoned, without any
// loaded tile for drop() to visit. Keep photos only for the camera or live work.
{
  const { world } = fixture();
  Object.assign(world, { workers: { size: 0 }, building: 0, T: 250, ox: 0, oy: 0,
    jsonRange: null, trimmed: performance.now(), driveBy: new Map(), walkBy: new Map(),
    around: () => ['near', 'loaded'], fetchTile: () => Promise.resolve({}), shown: new Set(), anchors: () => [] });
  const disposed = [];
  let resolveLate;
  const protectedKeys = ['near', 'loaded', 'in-flight', 'building'];
  world.loaded.set('loaded', {}); world.inFlight.add('in-flight'); world.builds.set('building', Promise.resolve({}));
  for (const key of protectedKeys) world.photos.set(key, Promise.resolve({ dispose: () => disposed.push(key) }));
  for (let n = 0; n < 100; n++) {
    const key = `old${n}`;
    world.photos.set(key, Promise.resolve({ dispose: () => disposed.push(key) }));
    world.pending.set(key, Promise.resolve({}));
  }
  world.photos.set('late', new Promise((resolve) => { resolveLate = resolve; }));
  world.update(0, 0, 300);
  await Promise.resolve();
  assert.deepEqual([...world.photos.keys()].sort(), protectedKeys.sort(), 'photo cache keeps camera and live build work only');
  assert.equal(disposed.length, 100, 'already decoded abandoned photos are disposed');
  const replacement = Promise.resolve({ dispose: () => disposed.push('replacement') });
  world.photos.set('late', replacement); // the camera returned before the old image finished
  resolveLate({ dispose: () => disposed.push('late') });
  await Promise.resolve();
  assert.ok(disposed.includes('late'), 'late photo response is disposed after cache retirement');
  assert.equal(world.photos.get('late'), replacement, 'retired response cannot evict a replacement photo');
  assert.ok(!disposed.includes('replacement'), 'replacement texture is not disposed with the old response');
  assert.equal(world.pending.size, 0);
}
for (const failed of [false, true]) {
  const { world, jobs, tile, place } = fixture();
  const old = tile(); place(old);
  const oldDraw = world.dress(old, Promise.resolve([]));
  world.drop(old.k);
  assert.equal(old.shown, false, 'dropping cancels visibility of the old tile');
  const replacement = tile(); place(replacement);
  const newDraw = world.dress(replacement, Promise.resolve([]));
  assert.equal(world.dressing.size, 2, 'both generations still have outstanding mesh work');
  assert.equal(world.busy, true);
  const warn = console.warn;
  try {
    console.warn = () => {};
    if (failed) jobs[0].reject(new Error('old worker failed')); else jobs[0].resolve();
    await oldDraw;
  } finally { console.warn = warn; }
  assert.ok(replacement.dressing, 'replacement still awaits its own worker');
  assert.equal(world.dressing.size, 1, 'old completion does not remove the replacement from scheduling');
  assert.equal(world.busy, true, 'auto graphics still sees streaming in progress');
  assert.equal(replacement.drawAfter, 0, 'old failure does not impose replacement cooldown');
  jobs[1].resolve(); await newDraw;
  assert.equal(world.dressing.size, 0); assert.equal(world.busy, false);
}
console.log('Tile lifecycle: recovery clears old retry state; abandoned photos dispose on completion; overlapping same-key mesh work retains correct busy/scheduler counts.');
