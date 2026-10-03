// CPU checks of impact setup against actual tram collision circles.
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
