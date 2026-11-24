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
  const seats=[];
  for (const [doorNumber,occupied,shared] of [[1,false,false],[1,true,false],[2,false,false],[2,true,false],[2,true,true]]) {
    const car=new Car('sedan',()=>.5,0,0,0), door=car.doors.find(d=>d.n===doorNumber);
    const [x,y]=car.beside(door), walker={x,y,h:0,anim:new Anim({clips}),base:new THREE.Matrix4(),sync(){}};
    const events=[], phases=[];
    const entry=new GetIn({walker,evict:(c,pulled)=>{events.push(pulled?'pulled':'left');return shared;},seated:()=>events.push('seated')});
    entry.enter(car,door,occupied);
    entry.update(1/60);
    assert.equal(walker.anim.name,doorNumber===1?'latchLeft':'latchRight');
    assert.equal(car.entryDriver,occupied);
    assert(!car.door,'the hand reaches a closed door');
    for (let i=0;i<150 && entry.active;i++) {
      entry.update(1/60); phases.push(walker.anim.name);
      if (shared) assert(!car.door?.[4],'the obstructed driver door stays shut');
    }
    assert(phases.includes(doorNumber===1?'seatLeft':'seatRight'));
    if (doorNumber===2 && occupied) seats.push(phases.indexOf('seatRight'));
    assert.equal(phases.includes('pull'),occupied && doorNumber===1);
    assert.deepEqual(events,occupied?[doorNumber===1?'pulled':'left','seated']:['seated']);
    assert(!car.entryDriver && !entry.active);
    entry.enter(car,door,true);entry.cancel();assert(!car.entryDriver && !entry.active);
  }
  assert(seats[1]-seats[0]>=23,'the player lets the driver clear a shared opening');
  const {DriverExit}=await server.ssrLoadModule('/src/driverExit.ts');
  const seat=new THREE.Matrix4().compose(new THREE.Vector3(5,2,-3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(.05,.4,-.1)),new THREE.Vector3(.87,.87,.87));
  const exit=new DriverExit(seat,5,-1,true), hips=new THREE.Vector3(-.05,.43,.02);
  const front=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);
  const person=new THREE.Group(), landing=new THREE.Vector3(7,1,-1);
  person.position.copy(landing);exit.place(person,hips,front);person.quaternion.multiply(front);
  assert(person.localToWorld(hips.clone()).distanceTo(new THREE.Vector3().setFromMatrixPosition(seat))<1e-6,'hips begin at the rendered seat');
  exit.elapsed=exit.duration;person.position.copy(landing);person.quaternion.identity();exit.place(person,hips,front);
  assert(person.position.distanceTo(landing)<1e-6 && person.scale.distanceTo(new THREE.Vector3(1,1,1))<1e-6,'the pedestrian takes over at full size');
  console.log('Left and right handle, driver handoff, seat entry, cancellation and both baked rigs passed.');
} finally {await server.close();}
