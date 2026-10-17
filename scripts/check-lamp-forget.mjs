#!/usr/bin/env node
// CPU lifecycle checks, using the production fill/forget/gather methods without a renderer.
//   node scripts/check-lamp-forget.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as THREE from 'three';

registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
const { Lamps } = await import('../src/lamps.ts');
const { posts } = await import('../src/posts.ts');
const { TileWorld } = await import('../src/tiles.ts');

function fixture() {
  const cable = new THREE.BufferGeometry();
  cable.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240), 3));
  return Object.assign(Object.create(Lamps.prototype), {
    xy: [], kind: [], seeds: [], free: [], generatedOwners: new Map(), loaded: true, surveyed: 0, lit: null,
    surveyCables: new Map(), waiting: new Map(), tiles: new Map(), hung: new Map(),
    grid: new Map(), streets: new Map(), facing: new Map(), posts: [], spots: [],
    rise: [], high: [], near: [], nearAt: { x: Infinity, y: Infinity, r: 0, asked: 0, t: 0 },
    height: () => 0, deck: () => null, falling: 0, models: [],
    dummy: new THREE.Object3D(), c: new THREE.Color(), tilt: new THREE.Quaternion(), axis: new THREE.Vector3(),
    cables: { geometry: cable }, glows: { instanceMatrix: { count: 0 }, count: 0 },
  });
}
const road = (x = 0, y = 0, extra = {}) => ({ hw: 'residential', pts: [[x, y], [x + 90, y]], width: 6, ...extra });
const walls = (x = 0, y = 0) => [[[x - 5, y - 10], [x + 95, y - 10], [x + 95, y + 10], [x - 5, y + 10]]];
const active = (l) => [...l.grid.values()].flat().map((i) => ({ x: l.xy[i * 2], y: l.xy[i * 2 + 1], kind: l.kind[i], seed: l.seeds[i], hung: l.hung.get(i) })).sort((a, b) => a.x - b.x || a.y - b.y);

// Survey lamps keep their indices and smashed state; their loaded wall anchors are temporary.
const survey = fixture();
survey.add(15, 0, 7); survey.add(15, 6, 0); survey.surveyed = 2;
posts.knock(survey.posts[1], 1);
survey.fill('a', [road()], walls());
assert.ok(survey.hung.has(0), 'survey lamp has cable anchors');
assert.ok(survey.tiles.get('a').lamps.size > 0, 'unsurveyed stretches get generated lamps');
const original = active(survey);
survey.forget(['a']);
assert.equal(survey.hung.size, 0);
assert.equal(survey.surveyCables.size, 0, 'survey anchors retire with their tile');
assert.deepEqual([...survey.grid.values()].flat().sort(), [0, 1]);
assert.ok(survey.posts[1].down, 'survey damage survives forgetting');
assert.equal(survey.streets.size, 0);
survey.fill('a', [road()], walls());
assert.deepEqual(active(survey), original, 'return rebuilds positions, styles and cables despite reused indices');
survey.fill('b', [road()], walls(0, 2));
assert.equal(survey.surveyCables.get(0).size, 2, 'overlapping tiles independently retain valid survey cables');
survey.forget(['a']);
assert.deepEqual(survey.hung.get(0), [15, 12, 15, -8], 'remaining tile supplies its own valid wall anchors');
survey.forget(['b']);
assert.equal(survey.hung.size, 0); assert.equal(survey.surveyCables.size, 0);
posts.remove(survey.posts[1]);

// Two tiles can contribute to the same orientation cell. Removing one preserves the other,
// and cached directions learn about a nearer road when its tile arrives.
const shared = fixture(); shared.add(15, 6, 0); shared.surveyed = 1;
shared.fill('a', [road()], []);
assert.equal(shared.face(0, 15, 6), -Math.PI / 2);
shared.fill('b', [road(0, 7)], []);
assert.equal(shared.face(0, 15, 6), Math.PI / 2, 'newly loaded closer street invalidates cached facing');
shared.forget(['b']);
assert.equal(shared.face(0, 15, 6), -Math.PI / 2, 'retained street still orients the lamp');
shared.forget(['a']);
assert.equal(shared.streets.size, 0); assert.equal(shared.facing.size, 0);
posts.remove(shared.posts[0]);

const overlap = fixture();
overlap.fill('a', [road()], walls());
const overlapLamps = active(overlap);
overlap.fill('b', [road()], walls());
assert.equal(overlap.tiles.get('b').lamps.size, 3, 'shared streets claim the existing generated lamps');
overlap.forget(['a']);
assert.deepEqual(active(overlap), overlapLamps, 'surviving shared tile retains generated lamps and their cables');
overlap.forget(['b']);
assert.equal(overlap.grid.size, 0); assert.equal(overlap.generatedOwners.size, 0);

// A forgotten tile cannot resurrect when the two optional map downloads finally finish.
const queued = fixture(); queued.loaded = false;
queued.fill('a', [road()], walls()); queued.fill('a', [road()], walls());
assert.equal(queued.waiting.size, 1, 'queued repeated fill is coalesced');
queued.forget(['a']); queued.loaded = true;
for (const [key, args] of queued.waiting) queued.fill(key, ...args);
assert.equal(queued.tiles.size, 0); assert.equal(queued.kind.length, 0);

// Bridge candidates wait for a deck, leave with their graph tile, and become owned
// collision posts when a deck arrives. Both deferred and materialized forms retire.
const bridge = fixture();
bridge.fill('a', [road(0, 0, { bridge: true })], []);
assert.equal(bridge.spots.length, 3);
bridge.forget(['a']); assert.equal(bridge.spots.length, 0);
bridge.fill('a', [road(0, 0, { bridge: true })], []);
bridge.fill('b', [road(0, 0, { bridge: true })], []);
bridge.deck = (_x, y) => Math.abs(y) <= 5 ? 8 : null;
bridge.gather(45, 0, 120, performance.now());
assert.equal(bridge.spots.length, 0);
assert.equal(bridge.tiles.get('a').lamps.size, 3);
const bridgePosts = [...bridge.tiles.get('a').lamps].map((i) => bridge.posts[i]);
assert.equal(posts.near(45, 0, 100).filter((p) => bridgePosts.includes(p)).length, 3);
bridge.forget(['a']);
assert.equal(posts.near(45, 0, 100).filter((p) => bridgePosts.includes(p)).length, 3, 'overlapping bridge tile keeps its shared posts');
bridge.forget(['b']);
assert.equal(posts.near(45, 0, 100).filter((p) => bridgePosts.includes(p)).length, 0, 'retired bridge posts leave collision grid');

// A long route must hold only the recent tile data and reuse its generated slots.
const trip = fixture();
let capacity = 0;
for (let n = 0; n < 500; n++) {
  const key = String(n), x = n * 300;
  trip.fill(key, [road(x)], walls(x));
  trip.fill(key, [road(x)], walls(x)); // accidental repeated callbacks are harmless
  if (n >= 3) trip.forget([String(n - 3)]);
  assert.ok(trip.tiles.size <= 3);
  assert.ok(trip.hung.size <= 9);
  assert.ok(trip.streets.size <= 30);
  assert.ok(trip.kind.length <= 12, 'lamp allocation levels off at peak concurrent tiles');
  capacity = Math.max(capacity, trip.kind.length);
}
trip.forget([...trip.tiles.keys()]);
assert.equal(trip.streets.size, 0); assert.equal(trip.grid.size, 0); assert.equal(trip.hung.size, 0);
assert.equal(trip.free.length, trip.kind.length);
assert.ok(trip.posts.every((p) => p === undefined));

// Forget notifications include tile keys even if all graph edges are shared or
// the tile is empty. Meshes, pending builds and remote route anchors still retain it.
const notifications = [];
const world = Object.assign(Object.create(TileWorld.prototype), {
  driveBy: new Map(['empty', 'shared', 'loaded', 'building', 'anchor'].map((key) => [key, []])),
  walkBy: new Map(), loaded: new Map([['loaded', {}]]), builds: new Map([['building', {}]]),
  graphBeyond: 500, anchors: () => [{ x: 2000, y: 0 }],
  around: (x) => x === 2000 ? ['anchor'] : [],
  drive: { remove: () => [] }, walk: { remove: () => [] },
  onForget: (drive, walk, keys) => notifications.push({ drive, walk, keys }),
});
world.forget(0, 0, 300);
assert.deepEqual(notifications, [{ drive: [], walk: [], keys: ['empty', 'shared'] }]);
assert.deepEqual([...world.driveBy.keys()], ['loaded', 'building', 'anchor']);
console.log(`Lamp lifecycle passed: survey state, shared street cells, cached direction refresh, queued cancellation, bridge posts, and 500 tile visits (${capacity} generated slots at peak).`);
