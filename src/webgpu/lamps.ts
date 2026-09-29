// The lamps' light (LAMP_GLSL and lampLit in ../lamps.ts) in TSL: the pools drawn into
// the light map, and a lookup that adds what the map holds to a material.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, texture, attribute, positionGeometry, positionWorld, normalView, cameraViewMatrix, diffuseColor,
  dot, smoothstep, abs, select,
} from 'three/tsl';
import { LAMP_MAP, LAMP_BOX, LAMP_ON, setPools } from '../lamps.ts';
import { type N, follow, followVec } from './common.ts';

// The pools of light, one instanced quad each (the ShaderMaterial in the Lamps constructor).
function poolsMaterial(view: { value: THREE.Vector4 }) {
  const m = new NodeMaterial();
  const uView = followVec(view);
  const at = attribute('iAt', 'vec4'), shape = attribute('iShape', 'vec4'), colour = attribute('iColour', 'vec3');
  const q = positionGeometry.xy, dir = shape.xy, side = vec2(dir.y.negate(), dir.x);
  const beam = at.w.greaterThan(0.5);
  const l = select(beam, vec2(q.x.mul(0.5).add(0.5), q.y), q);
  const off = select(beam, dir.mul(l.x).mul(shape.z).add(side.mul(q.y).mul(shape.w)), dir.mul(q.x).add(side.mul(q.y)).mul(shape.z));
  m.vertexNode = vec4(at.xy.add(off).sub(uView.xy).mul(uView.z), 0, 1);
  const vL = l.toVarying('vL'), vC = colour.toVarying('vC'), vH = at.z.toVarying('vH'), vBeam = at.w.toVarying('vBeam');
  m.fragmentNode = Fn(() => {
    const f = float(0).toVar();
    If(vBeam.greaterThan(0.5), () => {
      const t = vL.x, a = abs(vL.y).div(t.mul(0.75).add(0.25));
      f.assign(t.oneMinus().mul(t.oneMinus()).mul(smoothstep(0.35, 1, a).oneMinus()).mul(smoothstep(0, 0.1, t)));
    }).Else(() => {
      const d = dot(vL, vL);
      f.assign(select(d.lessThan(1), d.oneMinus().mul(d.oneMinus()), 0));
    });
    If(f.lessThan(0.002), () => { Discard(); });
    return vec4(vC.mul(f), vH.add(500));
  })();
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  m.blendEquationAlpha = THREE.MaxEquation;
  Object.assign(m, { depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false });
  return m;
}
setPools(poolsMaterial);

const uLampOn = follow(LAMP_ON), uLampBox = followVec(LAMP_BOX);
let map: N = null;

// The lamps' light at a point in the world (0 by day and off the map); with a normal,
// what faces up and is well above the lamp gets none (lampLightOn).
export function lampLight(w: N, n?: N) {
  map ??= texture(LAMP_MAP.value ?? new THREE.Texture());
  const out = vec3(0).toVar();
  const uv = w.xz.sub(uLampBox.xy).mul(uLampBox.z).mul(0.5).add(0.5).toVar();
  const inside = uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.lessThanEqual(1));
  If(uLampOn.greaterThan(0.005).and(inside), () => {
    const l = map.sample(vec2(uv.x, uv.y.oneMinus())).level(float(0)).toVar();
    const dy = w.y.sub(l.a.sub(500));
    const k = smoothstep(3, 11, dy).oneMinus().mul(smoothstep(-5, -2.5, dy)).toVar();
    if (n) {
      const up = smoothstep(0.5, 0.8, dot(n, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz));
      k.mulAssign(select(up.lessThan(0.01), float(1), up.mul(smoothstep(3.5, 5.5, dy)).oneMinus()));
    }
    out.assign(l.rgb.mul(uLampOn).mul(k));
  });
  return out;
}

// Adds the lamps' light to what a material already gives out, over its own diffuse colour.
export function lampLit(node: N, world: N = positionWorld) {
  const emissive = node.emissiveNode;
  node.emissiveNode = Fn(() => {
    const e = vec3(emissive ?? 0).toVar();
    e.addAssign(diffuseColor.rgb.mul(lampLight(world, normalView)));
    return e;
  })();
}
