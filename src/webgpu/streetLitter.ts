/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { attribute, positionGeometry, cameraPosition, uv, vertexColor, float, vec4, distance, smoothstep, mix, abs, fract } from 'three/tsl';
import { SEASON } from '../shading.ts';
import { LITTER_REACH, setLitterMaterial } from '../streetLitter.ts';
import { type N, followVec, uWet, uSnow, vnoise } from './common.ts';
import { lampLit } from './lamps.ts';

const season: N = followVec(SEASON);
function material() {
  const m = new MeshLambertNodeMaterial({side:THREE.DoubleSide,vertexColors:false});
  m.name = 'street-fallen-leaves';
  const leaf: N = attribute('leaf','vec2'), corner: N = attribute('corner','vec3');
  const far: N = distance(cameraPosition,positionGeometry);
  const amount: N = season.x.mul(2).sub(.8).clamp(0,1);
  const kept: N = smoothstep(leaf.y.mul(.95),leaf.y.mul(.95).add(.05),amount)
    .mul(float(1).sub(smoothstep(LITTER_REACH-5,LITTER_REACH,far)))
    .mul(float(1).sub(smoothstep(.12,.55,uSnow)));
  m.positionNode = positionGeometry.add(corner.mul(kept));
  const p: N = uv();
  // A midrib and paired, slanting side veins. All lengths are within a real leaf,
  // so a close look resolves veins instead of enlarging the overhead clump pattern.
  const rib: N = float(1).sub(smoothstep(.006,.022,abs(p.x)));
  const side: N = abs(fract(p.y.mul(9).sub(abs(p.x).mul(6))).sub(.5));
  const vein: N = float(1).sub(smoothstep(.015,.065,side));
  const edge: N = smoothstep(.15,.44,abs(p.x));
  const shade: N = mix(.78,1.18,leaf.x).mul(float(1).sub(edge.mul(.15)))
    .mul(float(1).sub(rib.mul(.2).add(vein.mul(.1)).mul(float(1).sub(smoothstep(2,6,far)))));
  const mottled: N = mix(.76,1.12,vnoise(p.mul(18).add(leaf.x.mul(73))));
  const c: N = vertexColor().rgb.mul(shade).mul(mottled).mul(float(1).sub(uWet.mul(.32)));
  m.colorNode = vec4(c,1);
  lampLit(m);
  return m;
}
setLitterMaterial(material);
