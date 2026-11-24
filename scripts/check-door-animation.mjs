// The ordinary door state machine and the clips shipped in both figure kits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import * as THREE from 'three';

globalThis.location={search:''};
globalThis.ProgressEvent ??= class extends Event {
  constructor(type,init) { super(type); Object.assign(this,init); }
};
const server=await createServer({configFile:false,server:{middlewareMode:true,hmr:false,ws:false}});
try {
  const { GetIn }=await server.ssrLoadModule('/src/getin.ts');
  const { Car, loadCars }=await server.ssrLoadModule('/src/car.ts');
  await loadCars('data:model/gltf-binary;base64,'+fs.readFileSync('public/cars.glb').toString('base64'));
  const { Anim }=await server.ssrLoadModule('/src/figures.ts');
  const glb=fs.readFileSync('public/figures.glb'), doc=JSON.parse(glb.subarray(20,20+glb.readUInt32LE(12)));
  const actions=fs.readFileSync('public/rocketbox/actions.bin');
  const street=JSON.parse(actions.subarray(4,4+actions.readUInt32LE(0))).clips;
  const clips=Object.fromEntries(doc.animations.map(a=>[a.name,{duration:Math.max(...a.samplers.map(s=>doc.accessors[s.input].max[0])),loop:false}]));
  for (const name of ['latchLeft','latchRight','seatLeft','seatRight','pull']) {
    assert(clips[name].duration>0 && street.some(c=>c.name===name && c.frames>=8),name);
  }
  for (const doorNumber of [1,2]) for (const occupied of [false,true]) {
    const car=new Car('sedan',()=>.5,0,0,0), door=car.doors.find(d=>d.n===doorNumber);
    const [x,y]=car.beside(door), walker={x,y,h:0,anim:new Anim({clips}),base:new THREE.Matrix4(),sync(){}};
    const events=[], phases=[];
    const entry=new GetIn({walker,evict:(c,pulled)=>events.push(pulled?'pulled':'left'),seated:()=>events.push('seated')});
    entry.enter(car,door,occupied);
    entry.update(1/60);
    assert.equal(walker.anim.name,doorNumber===1?'latchLeft':'latchRight');
    assert.equal(car.entryDriver,occupied);
    assert(!car.door,'the hand reaches a closed door');
    for (let i=0;i<150 && entry.active;i++) {entry.update(1/60);phases.push(walker.anim.name);}
    assert(phases.includes(doorNumber===1?'seatLeft':'seatRight'));
    assert.equal(phases.includes('pull'),occupied && doorNumber===1);
    assert.deepEqual(events,occupied?[doorNumber===1?'pulled':'left','seated']:['seated']);
    assert(!car.entryDriver && !entry.active);
    entry.enter(car,door,true);entry.cancel();assert(!car.entryDriver && !entry.active);
  }
  console.log('Left and right handle, driver handoff, seat entry, cancellation and both baked rigs passed.');
} finally {await server.close();}
