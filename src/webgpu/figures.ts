// The people in TSL (vatMaterial in figures.ts): each vertex reads its place and normal
// from the animation textures (two frames of two clips, blended), and the parts are tinted
// by what the person wears. Registered as a port of the colour material ('figures-true').
// Shadows use the same position (see castShadowPositionNode).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { float, floor, vec2, vec3, vec4, int, ivec2, attribute, vertexIndex, texture, positionLocal, positionGeometry, normalLocal, diffuseColor, mix, normalize, select, varying } from 'three/tsl';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { lampLit } from './lamps.ts';
import { instanceMatrix, shareInstances } from './trees.ts';
import { type N, addPort, follow } from './common.ts';
import { FIGURE_SIZE, PEOPLE_SHADOWS } from '../figures.ts';

addPort(/^figures-true$/, (node, legacy) => {
  const proto = Object.getPrototypeOf(node);
  const { pos, nrm } = legacy.userData.vat as { pos: THREE.DataTexture; nrm: THREE.DataTexture };
  const animA: N = attribute('aAnimA', 'vec4'), animB: N = attribute('aAnimB', 'vec4'), part: N = attribute('aPart', 'float');
  const vat = (t: N): N => {
    const id: N = int(vertexIndex as N);
    const fetch = (row: N) => t.load(ivec2(id, int(row))).xyz;
    const a = mix(fetch(animA.x), fetch(animA.y), animA.z), b = mix(fetch(animB.x), fetch(animB.y), animB.z);
    return mix(a, b, animA.w);
  };
  const positions = texture(pos), normals = texture(nrm);
  // Anyone drawn bigger than FIGURE_SIZE is shrunk to it (life size in first person).
  const shrink: N = float(1).min(follow(FIGURE_SIZE).div(instanceMatrix().mul(vec4(1, 0, 0, 0)).xyz.length()));
  const position = vat(positions).mul(shrink);

  // The instance's own transform goes on afterwards (setupPosition).
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    positionLocal.assign(position);
    normalLocal.assign(normalize(vat(normals)));
    return proto.setupPosition.call(this, builder);
  };
  node.castShadowPositionNode = instanceMatrix().mul(vec4(position, 1)).xyz;

  const aSkin: N = attribute('aSkin', 'vec3'), aShirt: N = attribute('aShirt', 'vec3'), aTrousers: N = attribute('aTrousers', 'vec3'), aHair: N = attribute('aHair', 'vec3');
  const tint: N = varying(
    select(part.lessThan(0.5), aSkin,
      select(part.lessThan(1.5), aShirt,
        select(part.lessThan(2.5), select(animB.w.greaterThan(0.5), aShirt, aSkin),
          select(part.lessThan(3.5), aTrousers,
            select(part.lessThan(4.5), vec3(0.02, 0.018, 0.016), aHair))))),
    'vTint',
  );
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    diffuseColor.assign(vec4(diffuseColor.rgb.mul(tint), diffuseColor.a));
  };
  lampLit(node);
});

// Two reads animate a textured middle-distance walker. Each half-float texel
// contains its position and a ten-bit octahedral normal (assets/rocketbox/crowd.mjs).
addPort(/^street-crowd(-dye)?$/, (node, legacy) => {
  const proto = Object.getPrototypeOf(node);
  const vat: N = texture(legacy.userData.crowdPoses), pose: N = attribute('crowdPose', 'vec3');
  const fetch = (row: N) => vat.load(ivec2(int(vertexIndex as N), int(row))).toVar();
  const a = fetch(pose.x), b = fetch(pose.y), position: N = mix(a.xyz, b.xyz, pose.z);
  const normal = (word: N) => {
    const p: N = vec2(word.mod(32), floor(word.div(32))).mul(2 / 31).sub(1);
    const z = p.x.abs().add(p.y.abs()).oneMinus();
    return vec3(select(z.lessThan(0), p.yx.abs().oneMinus().mul(p.sign()), p), z);
  };
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    positionLocal.assign(position);
    normalLocal.assign(normalize(mix(normal(a.w), normal(b.w), pose.z)));
    return proto.setupPosition.call(this, builder);
  };
  node.castShadowPositionNode = instanceMatrix().mul(vec4(position, 1)).xyz;
  lampLit(node);
});

// The people's stand-in in the sun's shadow map (PEOPLE_SHADOWS in ../figures.ts): drawn
// only there, so all it needs is where its vertices are. One material for every group.
let standIn: THREE.Material | null = null;
PEOPLE_SHADOWS.make = () => {
  if (standIn) return standIn;
  const m = new MeshBasicNodeMaterial() as N;
  m.name = 'figures-shadow';
  // (As the people themselves: no bigger than FIGURE_SIZE.)
  const shrink: N = float(1).min(follow(FIGURE_SIZE).div(instanceMatrix().mul(vec4(1, 0, 0, 0)).xyz.length()));
  m.castShadowPositionNode = instanceMatrix().mul(vec4((positionGeometry as N).mul(shrink), 1)).xyz;
  return (standIn = m);
};
