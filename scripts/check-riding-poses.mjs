// Verify the shipped contact points, including between the 24 Hz baked keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { glbSkeleton } from '../assets/rocketbox/format.mjs';
import { AVATARS, readClips } from '../src/rocketboxClips.ts';

const bytes=fs.readFileSync(new URL('../public/rocketbox/actions.bin',import.meta.url));
const library=readClips(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
let maxHand=0, maxFoot=0;
for (const [name,sex] of AVATARS) {
  const {root}=glbSkeleton(new URL('../public/rocketbox/'+name+'.glb',import.meta.url));
  root.rotation.y=Math.PI/2;
  const height=root.getObjectByName('Bip01').position.y;
  const position=n=>root.getObjectByName(n).getWorldPosition(new THREE.Vector3());
  for (const vehicle of ['bike','moto']) for (const stopped of [false,true]) {
    const bike=vehicle==='bike', clip=library[vehicle+(stopped?'Stand':'')+(sex==='m'?'Male':'')].clone();
    const pelvis=clip.tracks[0];
    pelvis.values=pelvis.values.map(x=>x*height);
    const mixer=new THREE.AnimationMixer(root), action=mixer.clipAction(clip).play();
    for (let i=0;i<96;i++) {
      const phase=i/96;
      action.time=phase*clip.duration; mixer.update(0);
      for (const [side,sign] of [['L',1],['R',-1]]) {
        const n='Bip01_'+side+'_', angle=Math.PI/2-2*Math.PI*phase+(sign<0?Math.PI:0);
        const palm=position(n+'Hand').lerp(position(n+'Finger2'),.82);
        const grip=bike?new THREE.Vector3(.37,1.052,-sign*.25):new THREE.Vector3(.33,1.042,-sign*.32);
        const sole=position(n+'Foot').lerp(position(n+'Toe0'),.55);
        const target=bike?new THREE.Vector3(-.03+.17*Math.cos(angle),.345+.17*Math.sin(angle),-sign*.11)
                         :new THREE.Vector3(-.12,.425,-sign*.19);
        if (stopped && sign===1) target.set(bike?-.035:-.20,.045,bike?-.255:-.30);
        maxHand=Math.max(maxHand,palm.distanceTo(grip)); maxFoot=Math.max(maxFoot,sole.distanceTo(target));
        assert(palm.distanceTo(grip)<.008 && sole.distanceTo(target)<.009,name+' '+clip.name+' '+side+' phase '+phase);
      }
    }
    mixer.stopAllAction();
  }
}
console.log('All 14 riding rigs: worst palm error '+(maxHand*1000).toFixed(1)+' mm, shoe error '+(maxFoot*1000).toFixed(1)+' mm.');
