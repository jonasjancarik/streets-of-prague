import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { Scene } from 'three';
import ts from 'typescript';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '?lang=en' };
globalThis.self = globalThis;
globalThis.document = { getElementById: () => null, querySelectorAll: () => [], documentElement: { lang: 'en' } };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };

const { loadCars } = await import('../src/car.ts');
const { DriveGraph, Polyline } = await import('../src/network.ts');
const { byLevel, levelOnLane, roadHint } = await import('../src/roadLevels.ts');
const { TileWorld } = await import('../src/tiles.ts');
const { Traffic } = await import('../src/traffic.ts');
const model = readFileSync(new URL('../public/cars.glb', import.meta.url)).toString('base64');
await loadCars('data:model/gltf-binary;base64,' + model);

function street(more = {}) {
  return { id: 'a>b>0', u: 'a', v: 'b', pts: [[0, 0], [80, 0]], width: 7,
    lanes: 1, oneway: true, hw: 'primary', ...more };
}
const level = (level, at, sample) => ({ level, grid: { at }, sample: () => sample });
const onDeck = (x) => x >= 20 && x < 60;
function fixture(raws = [street({ levels: [[0, 0], [20, 1], [60, 0]] })], r = () => 0.5) {
  const graph = new DriveGraph(), edges = graph.add(raws);
  const tile = { levels: [level(1, onDeck, 10), level(2, onDeck, 12), level(-1, onDeck, -6)], grid: { at: () => 0 } };
  const world = Object.assign(Object.create(TileWorld.prototype), { tileAt: () => tile, terrainAt: () => 4, terrainRevision: 1 });
  return { world, tile, traffic: new Traffic(graph, new Scene(), r, 0), edges };
}

test('a curved lane uses its own distances and the painted split keeps raw stations', () => {
  const raw = street({ pts: [[0, 0], [20, 0], [20, 20]], oneway: false,
    levels: [[0, 0], [20, 1], [32, 0]] });
  const [edge] = new DriveGraph().add([raw]);
  assert.deepEqual(raw.levels, [[0, 0], [20, 1], [32, 0]]);
  assert.equal(edge.levels, raw.levels);
  const [first, middle, last] = byLevel(edge);
  assert.deepEqual([first.level, middle.level, last.level], [0, 1, 0]);
  assert.deepEqual([middle.pts[0], middle.pts.at(-1)], [[20, 0], [20, 12]]);
  const laneTurn = edge.path.cum[1];
  assert.notEqual(laneTurn, 20);
  assert.equal(levelOnLane(edge, laneTurn - 0.01), 0);
  assert.equal(levelOnLane(edge, laneTurn), 1);
  assert.equal(levelOnLane(edge, laneTurn + 0.6 * (edge.path.length - laneTurn) + 0.01), 0);
  const one = street({ levels: [[0, 2]] });
  assert.equal(byLevel(one)[0].level, 2);
  assert.equal(roadHint(new DriveGraph().add([one])[0], 10), 2);
});

test('spawns resolve the named bridge, ground, or tunnel against the real tracking and collision methods', () => {
  for (const [raw, expected, height] of [
    [street({ levels: [[0, 0], [20, 2], [60, 0]] }), 2, 12],
    [street({ pts: [[40, -40], [40, 40]] }), 0, 4],
    [street({ level: -1, tunnel: true }), -1, -6],
  ]) {
    const { world, traffic, edges } = fixture([raw]);
    const a = traffic.spawn(null, edges, 'sedan');
    assert.ok(a);
    assert.equal(world.track(a.car), expected);
    assert.equal(a.car.gz, height);
    assert.equal(world.view(a.car).at(a.car.x, a.car.y), 0);
    assert.equal(world.view(a.car).height(a.car.x, a.car.y), height);
  }
});

test('numeric placement falls back to ground for a missing mask or height and retries an active route intent', () => {
  const { world, tile } = fixture();
  const who = { x: 40, y: 0, roadLevel: 5, hint: 'ground' };
  assert.equal(world.track(who), 0);
  assert.equal(who.gz, 4);
  tile.levels.push(level(5, () => false, 15));
  assert.equal(world.track(who), 0);
  tile.levels[3] = level(5, () => true, NaN);
  assert.equal(world.track(who), 0);
  tile.levels[3] = level(5, () => true, 15);
  assert.equal(world.track(who), 5);
  assert.equal(who.gz, 15);
  tile.levels.pop();
  world.terrainRevision++;
  assert.equal(world.track(who), 0, 'unloading the named level must invalidate a stationary car');
  tile.levels.push(level(5, () => true, 15));
  assert.equal(world.track(who), 5);
  who.roadLevel = 0;
  assert.equal(world.track(who), 0, 'a new route level at the same position must invalidate tracking');
  assert.equal(who.gz, 4);
  who.roadLevel = undefined;
  who.hint = 2;
  assert.equal(world.track(who), 2);
  assert.equal(who.hint, undefined);
  assert.equal(who.gz, 12);
});

test('a traffic car enters and leaves a raised span along a single untagged road', () => {
  const { world, traffic, edges } = fixture(undefined, () => 0.1);
  const a = traffic.spawn(null, edges, 'sedan');
  assert.ok(a);
  const levels = [world.track(a.car)];
  for (let n = 0; n < 600 && a.car.x < 70; n++) {
    traffic.update(1 / 60, () => []);
    const found = world.track(a.car);
    assert.equal(found, a.car.x >= 20 && a.car.x < 60 ? 1 : 0);
    assert.equal(a.car.gz, found === 1 ? 10 : 4);
    if (levels.at(-1) !== found) levels.push(found);
  }
  assert.ok(a.car.x >= 70, 'the car finished beyond both transitions');
  assert.deepEqual(levels, [0, 1, 0]);
});

test('a bus placed on a routed line uses its mixed road span and keeps its height when taken over', () => {
  const raw = street({ pts: [[0, 0], [50, 5], [80, 5]], levels: [[0, 0], [20, 1], [60, 0]] });
  const { world, traffic, edges } = fixture([raw]);
  traffic.busLines = [{ ref: '133', to: 'Centre', path: new Polyline([[29, 2.9], [50, 4.98]]), stops: [] }];
  traffic.buses(() => true, edges, 1);
  const [a] = traffic.agents;
  assert.ok(a?.bus);
  assert.equal(world.track(a.car), 1);
  assert.equal(a.car.gz, 10);
  traffic.update(1 / 60, () => []);
  assert.equal(world.track(a.car), 1);
  assert.equal(a.car.roadLevel, 1);
  traffic.release(a);
  assert.equal(a.car.roadLevel, undefined);
  assert.equal(a.car.grounded, undefined);
  assert.equal(world.track(a.car), 1);
  assert.equal(a.car.gz, 10);
});
