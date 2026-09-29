// The ground's soft shading at shores and round buildings (the ShaderMaterial in
// surface.ts) in TSL: a dark, see-through layer that fades out towards its edges.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import { Fn, If, Discard, vec3, vec4, attribute, positionWorld, distance, abs, max, sRGBTransferEOTF, toneMappingExposure } from 'three/tsl';
import { setSoftShade } from '../surface.ts';
import { uDig } from './common.ts';

setSoftShade((opacity: number) => {
  const m = new NodeMaterial();
  const alpha = attribute('alpha', 'float');
  m.fragmentNode = Fn(() => {
    If(distance(positionWorld.xz, uDig.xy).lessThan(uDig.z), () => { Discard(); });
    // WebGL writes this colour as it is, after the tone curve; here the curve comes after the
    // blending, so it is turned back into what goes in before it.
    const colour = (sRGBTransferEOTF(vec3(0.08, 0.07, 0.06)) as any).div(max(abs(toneMappingExposure as any), 0.001));
    return vec4(colour, alpha.mul(alpha).mul(opacity));
  })();
  m.blending = THREE.CustomBlending;
  Object.assign(m, { depthWrite: false, depthTest: false, fog: false, toneMapped: false });
  return m;
});
