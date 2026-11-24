import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PlayerFooting } from '../src/playerFooting.ts';

const root=new THREE.Group(), feet=[];
for(const [side,offset] of [['L',.13],['R',-.13]]) {
  const leg=[];
  let parent=root;
  for(const [name,xyz] of [['Thigh',[offset,.91,0]],['Calf',[0,-.43,.08]],['Foot',[0,-.395,-.095]],['Toe0',[0,-.065,.15]]]) {
    const joint=new THREE.Bone(); joint.name='Bip01_'+side+'_'+name; joint.position.fromArray(xyz);
    parent.add(joint); leg.push(joint); parent=joint;
  }
  feet.push(leg);
}
const rig=new PlayerFooting(root), vector=()=>new THREE.Vector3();
const lengths = () => feet.map(([hip,knee,foot]) => [hip.getWorldPosition(vector()).distanceTo(knee.getWorldPosition(vector())),
  knee.getWorldPosition(vector()).distanceTo(foot.getWorldPosition(vector()))]);
const before=lengths();
const rotations=()=>feet.flatMap(leg=>leg.map(j=>j.quaternion.clone()));
const base=rotations();
rig.apply(1/30,()=>0,0,1);
assert(rotations().every((q,i)=>q.angleTo(base[i])<1e-7),'flat paving keeps the captured keys');
const slope=(x,z)=>.19*x+.23*z, normal=new THREE.Vector3(-.19,1,-.23).normalize();
for(let i=0;i<45;i++){rig.restore();rig.apply(1/30,slope,0,1);}
for(const [i,leg] of feet.entries()){
  const foot=leg[2],up=new THREE.Vector3(0,1,0).applyQuaternion(foot.getWorldQuaternion(new THREE.Quaternion()));
  assert(up.dot(normal)>.997,'a planted shoe follows a continuous uphill surface');
  assert(lengths()[i].every((v,k)=>Math.abs(v-before[i][k])<1e-7),'leg segments retain their length');
}
const held=rotations();
for(let i=0;i<15;i++){rig.restore();rig.apply(0,slope,0,1);}
assert(rotations().every((q,i)=>q.angleTo(held[i])<1e-6),'a paused stance does not gain rotation');
rig.restore();rig.apply(1/30,()=>NaN,0,1);
assert(rotations().every((q,i)=>q.angleTo(base[i])<1e-7),'a missing floor releases the adjustment');
rig.release();rig.apply(1/30,()=>-3,0,1);
assert(rotations().every((q,i)=>q.angleTo(base[i])<1e-7),'a foot does not reach down a high drop');
console.log('Grounded soles, unchanged bone lengths, frozen poses, missing floors and ledges passed');
