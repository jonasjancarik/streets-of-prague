// The people in TSL (vatMaterial in figures.ts): each vertex reads its place and normal
// from the animation textures (two frames of two clips, blended), and the parts are tinted
// by what the person wears. Registered as a port of the colour material ('figures-true').
// Shadows use the same position (see castShadowPositionNode).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { vec3, vec4, int, ivec2, attribute, vertexIndex, texture, positionLocal, normalLocal, diffuseColor, mix, normalize, select, varying } from 'three/tsl';
import { lampLit } from './lamps.ts';
import { instanceMatrix, shareInstances } from './trees.ts';
import { type N, addPort } from './common.ts';

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
  const position = vat(positions);

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
