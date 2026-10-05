#!/usr/bin/env node
// Real worker/canvas adapter and retained model regressions, without a running game.
import { createRequire } from 'node:module';
import { checkIn } from './game-lock.mjs';
const require = createRequire(import.meta.url);
const pw = require(process.env.PLAYWRIGHT_PATH || `${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
const base = process.argv[2] || 'http://localhost:5203/';
await (await checkIn('game')).take(); // not while another session benchmarks
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(new URL('src/map/furniture.ts', base).href);
  const result = await page.evaluate(async () => {
    const { Geo } = await import('/src/map/geo.ts');
    const { furnitureInstances, YARD } = await import('/src/map/furniture.ts');
    const { furnitureMeshes, disposeFurniture } = await import('/src/furniture.ts');
    const { TileWorkers } = await import('/src/tileWorkers.ts');
    const assert = (v, text) => { if (!v) throw new Error(text); };
    const poly = [[[[0, 0], [100, 0], [100, 100], [0, 100]]]];
    const data = { size: [100, 100], origin: [0, 0], areas: { dtm_yard: poly }, roads: {}, buildings: [], furnitureBuildings: [], walls: [], fences: [], trees: [], walk: [], passages: [], structures: [], reserved: new Float32Array(0), levels: false, furnitureEnabled: true };
    const trees = { matrices: new Float32Array(0), colours: new Float32Array(0), yearly: new Float32Array(0), count: 0, shrubs: 0, conifers: 0 };
    const run = d => furnitureInstances(new Geo(d), trees, () => 0);
    const yard = run(data);
    assert(yard.spots.length > 0 && yard.spots.every(p => p.kind === 2), 'adapter keeps courtyard planters');
    assert(JSON.stringify(run(data).spots) === JSON.stringify(yard.spots), 'canvas placement repeats');
    for (const key of ['water', 'bridge', 'parking', 'pitch', 'wood', 'square', 'ballast']) {
      assert(run({ ...data, areas: { ...data.areas, [key]: poly } }).spots.length === 0, `${key} overlays exclude furniture`);
    }
    assert(run({ ...data, roads: { path: poly } }).spots.length === 0, 'real road polygons exclude furniture');
    assert(run({ ...data, structures: poly }).spots.length === 0, 'elevated bridge decks exclude furniture');
    assert(run({ ...data, buildings: poly.map(rings => ({ rings })) }).spots.length === 0, 'buildings exclude furniture');
    const green = { ...data, areas: { park: poly }, walk: [{ id: 'path', u: 'a', v: 'b', hw: 'footway', pts: [[0, 50], [100, 50]], width: 2 }] };
    const park = run(green);
    assert(park.spots.length > 0, 'benches/bins beside an actual park path');
    assert(run({ ...green, areas: { park: poly, square: poly } }).spots.length === 0, 'paving_stones slab polygon over a park excludes furniture');
    assert(run({ ...green, areas: { park: poly, square_setts: poly } }).spots.length === 0, 'explicit paved square wins over green');
    const trimmedSquare = [[[[0, 0], [100, 0], [100, 20], [0, 20]]]];
    const corrected = run({ ...green, areas: { park: poly, square: trimmedSquare } });
    assert(JSON.stringify(park.spots) === JSON.stringify(corrected.spots), 'corrected named-square geometry leaves its green eligible');
    const p = yard.spots[0], same = other => other.spots.some(q => q.x === p.x && q.y === p.y);
    assert(!same(run({ ...data, reserved: new Float32Array([p.x, p.y]) })), 'surveyed lamps exclude furniture');
    assert(!same(run({ ...data, passages: [{ pts: [[p.x - 10, p.y], [p.x + 10, p.y]], w: 2 }] })), 'entrances remain clear');
    assert(!same(run({ ...data, fences: [{ pts: [[p.x - 10, p.y], [p.x + 10, p.y]] }] })), 'fences remain clear');
    const m = new Float32Array(16); m[0] = m[5] = m[10] = 3; m[12] = p.x; m[14] = -p.y;
    const dense = furnitureInstances(new Geo(data), { ...trees, count: 1, matrices: m }, () => 0);
    assert(!same(dense), 'tree crown clearance');
    const endpoints = [];
    const workers = new TileWorkers(1, () => { const w = new Worker('/src/tileWorker.ts', { type: 'module' }); endpoints.push(w); return w; });
    try {
      const ground = { hm: new Float32Array(121), box: [0, 0, 100, 100], n: 11, step: 10 };
      const land = await workers.run('land', { data, ground, bridges: [], box: [0, 0, 1, 1], structures: [], seeds: new Float64Array([1, 1]) });
      assert(land.furniture.spots.length > 0, 'worker returns furniture');
      const grid = new (await import('/src/map/geo.ts')).Grid(new Geo(data), 2, null, land.cells);
      for (const spot of land.furniture.spots) assert(grid.at(spot.x, spot.y) === 255, 'furniture is solid');
      const absent = await workers.run('land', { data, ground: null, bridges: [], box: [0, 0, 1, 1], structures: [], seeds: new Float64Array([1, 1]) });
      assert(absent.furniture.spots.length === 0, 'no placement without terrain');
      const disabled = await workers.run('land', { data: { ...data, furnitureEnabled: false }, ground, bridges: [], box: [0, 0, 1, 1], structures: [], seeds: new Float64Array([1, 1]) });
      assert(disabled.furniture.spots.length === 0, 'missing lamp survey or explicit baseline disables furniture');
      const first = furnitureMeshes(land.furniture), second = furnitureMeshes(land.furniture);
      assert(first.length === 1 && second.length === 1, 'one instance draw for populated kind');
      assert(first[0].geometry === second[0].geometry && first[0].material === second[0].material, 'shared models and material');
      assert(first[0].boundingSphere && first[0].instanceMatrix.updateRanges.length === 1, 'bounds and active upload range');
      let geometryDisposals = 0, instanceDisposals = 0;
      first[0].geometry.addEventListener('dispose', () => geometryDisposals++);
      first[0].addEventListener('dispose', () => instanceDisposals++);
      disposeFurniture(first);
      assert(instanceDisposals === 1 && geometryDisposals === 0, 'tile disposal preserves shared geometry');
      assert(second[0].count === land.furniture.spots.length, 'remaining tile retains instances');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const all = furnitureMeshes({ matrices: [identity, identity, identity], spots: [] });
      const triangles = all.map(m => m.geometry.attributes.position.count / 3);
      assert(JSON.stringify(triangles) === '[108,36,84]', 'fixed model triangle budgets');
      assert(all[2].geometry === second[0].geometry, 'reloaded kind reuses its model');
      disposeFurniture(all);
      disposeFurniture(second);
      return { courtyard: land.furniture.spots.length, triangles, modelBytes: all.map(m => Object.values(m.geometry.attributes).reduce((s, a) => s + a.array.byteLength, 0)), matrixBytes: land.furniture.matrices.reduce((s, a) => s + a.byteLength, 0), assertions: 'passed' };
    } finally { endpoints.forEach(w => w.terminate()); }
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
