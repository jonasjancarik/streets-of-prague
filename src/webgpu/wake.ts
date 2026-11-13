// A boat's wake, seen from above (../boats.ts): a strip of water behind the stern that
// widens as it trails, with the two arms of the V that every hull throws, the churned
// foam of the propeller down the middle, and faint cross waves between them, all fading
// with distance. One flat mesh a boat, white foam lit like everything else (so a bridge's
// shadow falls across it and at night it is dark), see-through by a pattern worked out
// from where the water is in the world: the boat sails on and its wake stays put and fades.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uv, positionWorld, materialOpacity, abs, sin, smoothstep, clamp, pow } from 'three/tsl';
import { setWake } from '../boats.ts';
import { type N, vnoise } from './common.ts';

const LENGTH = 3, LONGEST = 60, SPREAD = 0.16; // how long the wake is in boat lengths and at most (m), and how fast it widens

const pattern: N = Fn(() => {
  const at: N = uv(), across: N = abs(at.x.mul(2).sub(1)), along: N = at.y;
  const fade: N = float(1).sub(along);
  const p: N = vec2(positionWorld.x, positionWorld.z);
  const broken: N = vnoise(p.mul(0.8)).mul(0.6).add(vnoise(p.mul(2.7).add(13)).mul(0.4));
  const arms: N = smoothstep(0.6, 0.86, across).mul(float(1).sub(smoothstep(0.9, 1, across))).mul(pow(fade, 1.3));
  const foam: N = float(1).sub(smoothstep(0.05, 0.34, across.mul(along.mul(1.6).add(0.7)))).mul(fade.mul(fade));
  const waves: N = sin(along.mul(70).sub(across.mul(11))).mul(0.5).add(0.5).mul(float(1).sub(across)).mul(fade).mul(0.16);
  const start: N = smoothstep(0, 0.035, along);
  return clamp(arms.mul(0.5).add(foam.mul(0.95)).add(waves), 0, 1).mul(broken.mul(1.1).add(0.22)).mul(start).mul(materialOpacity);
})();
const colour: N = vec4(vec3(0.9, 0.93, 0.94), 1);

function geometry(length: number, beam: number) {
  const ROWS = 14, pos: number[] = [], uvs: number[] = [], nor: number[] = [], idx: number[] = [];
  const reach = Math.min(length * LENGTH, LONGEST);
  for (let i = 0; i <= ROWS; i++) {
    const t = i / ROWS, x = -length * 0.42 - t * reach, half = beam * 0.5 + t * reach * SPREAD;
    for (const [side, u] of [[-1, 0], [0, 0.5], [1, 1]]) { pos.push(x, 0, side * half); uvs.push(u, t); nor.push(0, 1, 0); }
  }
  for (let i = 0; i < ROWS; i++) for (let j = 0; j < 2; j++) {
    const a = i * 3 + j, b = a + 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1); // (facing up)
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

setWake((length, beam) => {
  // (Each wake its own material, for its own strength; the nodes are shared, so they share a shader.)
  const material = new MeshLambertNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }) as N;
  material.colorNode = colour;
  material.opacityNode = pattern;
  const mesh = new THREE.Mesh(geometry(length, beam), material as THREE.Material);
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
});
