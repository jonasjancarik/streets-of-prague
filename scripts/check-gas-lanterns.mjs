import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CloseLanterns } from '../src/closeLanterns.ts';
import { gasPair, gasSingle, wallLantern, parapetLantern } from '../src/lampmodels.ts';

for (const make of [gasPair,gasSingle,wallLantern,detailed=>parapetLantern(1,detailed)]) {
  const simple=make(false), close=make(true);
  assert.equal(simple.groups.length,0,'the original silhouette remains one material');
  assert.equal(close.groups.length,2,'metal and panes have separate draws');
  const [body,glass]=close.groups;
  assert.equal(body.count+glass.count,close.getAttribute('position').count);
  assert(glass.count===36 || glass.count===72,'six two-triangle panes per lantern');
  const uv=close.getAttribute('uv');
  assert(Array.from({length:body.count},(_,i)=>uv.getX(i)).some(u=>u===.75),'mantles have their emissive sample');
  assert(Array.from({length:glass.count},(_,i)=>uv.getX(glass.start+i)).every(u=>u===.25),'glass never reads the mantle emission');
  simple.dispose(); close.dispose();
}
const group=new THREE.Group(), original=new THREE.InstancedMesh(gasSingle(),new THREE.MeshLambertMaterial(),50);
group.add(original);
const batch=new CloseLanterns(), matrix=new THREE.Matrix4();
assert(!batch.add(2,()=>gasSingle(true),matrix,original,4),'overhead does not allocate a batch');
batch.street=true;batch.begin();
assert(!batch.add(2,()=>gasSingle(true),matrix,original,1700),'a distant post keeps its old model');
let built=0;
for(let i=0;i<24;i++) if(batch.add(2,()=>gasSingle(true),matrix,original,4))built++;
batch.finish();assert.equal(built,20);
const near=group.getObjectByName('Close gas lantern 2');
assert(near.visible && near.count===20);
batch.street=false;batch.begin();batch.finish();
assert(!near.visible && !near.count);
console.log('All gas lamp geometries, mantle masks, shared panes, distance, cap and overhead restoration passed');
