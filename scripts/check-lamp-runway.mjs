// CPU checks of lamp and wall impact setups against street collision objects.
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
globalThis.requestAnimationFrame = done => { queueMicrotask(() => done(performance.now())); return 0; };
globalThis.ProgressEvent = class extends Event { constructor(type, init) { super(type); Object.assign(this, init); } };
const { setupTestkit } = await import('../src/testkit.ts');
const { loadCars } = await import('../src/car.ts');
await loadCars('data:model/gltf-binary;base64,' + readFileSync(new URL('../public/cars.glb', import.meta.url)).toString('base64'));

const { Car } = await import('../src/car.ts');
function fixture(circles) {
 const c=new Car('hatch',()=>.5,30,30,1);c.mode='player';
 const g={car:()=>c,grid:{at:()=>0},carsNear:()=>[],tramsNear:()=>circles.length?[{circles}]:[],canvas:{addEventListener(){}}};
 return {c,t:setupTestkit(g,{})};
}
const p={x:0,y:0,z:0,r:.18,tough:9,give:.5,down:null};
const empty=fixture([]);empty.t.aimAt(p,18);assert.equal(empty.c.x,-18);assert.equal(empty.c.y,0);assert.equal(empty.c.h,0);
// A real tram collision is a train of 1.25 m circles. The old helper checked
// only walls/cars and accepted this occupied west approach immediately.
const tram=Array.from({length:10},(_,i)=>[-17+i,0]);
const f=fixture(tram);f.t.aimAt(p,18);assert.notEqual(f.c.h,0,'occupied approach must be rejected');
for(let s=0;s<=18-p.r-f.c.spec.L/2;s+=.1)for(const o of f.c.offsets){
 const x=f.c.x+Math.cos(f.c.h)*(s+o),y=f.c.y+Math.sin(f.c.h)*(s+o);
 assert.ok(tram.every(([tx,ty])=>Math.hypot(x-tx,y-ty)>=f.c.r+1.25),'the complete chosen car body clears the tram');
}
const blocked=fixture([[0,0]]),before={x:blocked.c.x,y:blocked.c.y,h:blocked.c.h};
assert.throws(()=>blocked.t.aimAt(p,18),/No clear run/);assert.deepEqual({x:blocked.c.x,y:blocked.c.y,h:blocked.c.h},before,'failure must not place the car through a rail body');
console.log('Lamp runway: occupied tram approach rejected, whole-body alternate clear, empty approach unchanged, blocked target fails without placement.');

function wallFixture({ solid = (x, y) => Math.abs(x) >= 20 || Math.abs(y) >= 20, cars = [], circles = [] } = {}) {
 const c = new Car('hatch', () => .5, 0, 0, .3); c.mode = 'player';
 const g = { car: () => c, grid: { at: (x, y) => Number(solid(x, y)) }, carsNear: () => cars,
  tramsNear: () => circles.length ? [{ circles }] : [], canvas: { addEventListener() {} } };
 return { c, t: setupTestkit(g, {}) };
}
const clearWall = wallFixture(), run = clearWall.t.wallRun();
assert.ok(run); assert.equal(run.heading, 0); assert.equal(clearWall.c.y, 8);
assert.equal(clearWall.c.vx, 0); assert.equal(clearWall.c.vy, 0); assert.equal(clearWall.c.w, 0);

// A clear grid ray alone is insufficient: a parked vehicle or tram occupies the
// moving body's approach, even when the start and wall points themselves are clear.
const parked = new Car('sedan', () => .5, 0, 13, 0);
const parkedWall = wallFixture({ cars: [parked] }), parkedRun = parkedWall.t.wallRun();
assert.ok(parkedRun); assert.notEqual(parkedRun.heading, 0);
const railWall = wallFixture({ circles: [[0, 13]] }), railRun = railWall.t.wallRun();
assert.ok(railRun); assert.notEqual(railRun.heading, 0);

const { posts } = await import('../src/posts.ts');
const pole = { x: 0, y: 13, z: 0, r: .2, tough: 5, give: .2, down: null };
posts.add(pole);
try {
 const poleWall = wallFixture(), poleRun = poleWall.t.wallRun();
 assert.ok(poleRun); assert.notEqual(poleRun.heading, 0, 'a static post cannot be bypassed by fixture placement');
} finally { posts.remove(pole); }

const { fences } = await import('../src/fences.ts');
const fence = { id: 'wall-fixture', x1: -1.5, y1: 13, x2: 1.5, y2: 13, z: 0, h: 1.2, hedge: false, rail: false, broken: false };
fences.add([fence]);
try {
 const fencedWall = wallFixture(), fencedRun = fencedWall.t.wallRun();
 assert.ok(fencedRun); assert.notEqual(fencedRun.heading, 0, 'a fence in the approach remains a static obstacle');
} finally { fences.remove([fence]); }

for (const options of [
 { solid: (x, y) => Math.abs(x) < .3 && y >= 20 }, // a narrow obstacle is not a broad wall
 { solid: () => true },
 { cars: [{ gap: () => 0 }] }, // every otherwise valid approach is occupied
]) {
 const blockedWall = wallFixture(options);
 Object.assign(blockedWall.c, { vx: 2, vy: 3, w: .4 });
 const before = { x: blockedWall.c.x, y: blockedWall.c.y, h: blockedWall.c.h, vx: 2, vy: 3, w: .4 };
 assert.equal(blockedWall.t.wallRun(), null);
 assert.deepEqual(Object.fromEntries(Object.keys(before).map(key => [key, blockedWall.c[key]])), before,
  'failed setup preserves the complete car pose and motion');
}
console.log('Wall runway: full-body clear placement; parked cars, trams, posts and fences avoided; narrow/blocked targets rejected without moving the car.');
