// The lamps' light (LAMP_GLSL and lampLit in ../lamps.ts) in TSL: the pools drawn into
// the light map, and a lookup that adds what the map holds to a material.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, int, ivec2, vec2, vec3, vec4, texture, attribute, positionGeometry, positionWorld, normalView, cameraViewMatrix, diffuseColor,
  dot, smoothstep, abs, select, min, max, step, length,
} from 'three/tsl';
import { LAMP_MAP, LAMP_MAP_HIGH, LAMP_BOX, LAMP_REF, LAMP_ON, LAMP_SHADOWS, setPools } from '../lamps.ts';

const LUMA = vec3(0.3, 0.59, 0.11);
import { type N, follow, followVec } from './common.ts';

// The pools of light, one instanced quad each (the ShaderMaterial in the Lamps constructor,
// where `cover` is explained too). `cars`: the texture of the boxes in the way; `layer`:
// which of the two maps it draws (0 the ground's, 1 the bridges').
function poolsMaterial(view: { value: THREE.Vector4 }, cars: THREE.Texture, layer: number) {
  const m = new NodeMaterial();
  const carTex = texture(cars), uShadow = follow(LAMP_SHADOWS), uRef = followVec(LAMP_REF);
  const cover = (id: N, p: N, lamp: N, gy: N): N => {
    const out = float(0).toVar();
    If(id.greaterThan(-0.5), () => {
      const i = int(id.add(0.5));
      const a = carTex.load(ivec2(i, int(0))).toVar(), b = carTex.load(ivec2(i, int(1))).toVar();
      const fw = a.zw, sd = vec2(a.w.negate(), a.z);
      If(uShadow.lessThan(1.5), () => {
        const o = p.sub(a.xy), l = vec2(dot(o, fw), dot(o, sd));
        const d = length(max(abs(l).sub(b.xy), 0));
        out.assign(smoothstep(0, 1.2, d).oneMinus().mul(smoothstep(1.5, 3, abs(gy.sub(b.w))).oneMinus()).mul(0.55));
      }).Else(() => {
        const o = lamp.xz.sub(a.xy), e = p.sub(a.xy);
        const from = vec3(dot(o, fw), lamp.y.sub(b.w), dot(o, sd));
        const D = vec3(dot(e, fw), gy.sub(b.w), dot(e, sd)).sub(from).toVar();
        D.addAssign(step(0, D).mul(2).sub(1).mul(1e-4));
        const t1 = vec3(b.x.negate(), 0.12, b.y.negate()).sub(from).div(D), t2 = vec3(b.x, b.z.sub(b.w), b.y).sub(from).div(D);
        const tn = min(t1, t2), tf = max(t1, t2);
        const t0 = max(max(max(tn.x, tn.y), tn.z), 0), t3 = min(min(min(tf.x, tf.y), tf.z), 1).toVar();
        // The edge is softer the further the shadow falls behind the box (and never sharper than the map's texels).
        const len = length(D), soft = max(uRef.z, t3.oneMinus().mul(len).mul(0.06).add(0.2));
        out.assign(smoothstep(0, soft, t3.sub(t0).mul(len)).mul(0.92));
      });
    });
    return out;
  };
  const carsA = attribute('iCarsA', 'vec4'), carsB = attribute('iCarsB', 'vec4'), carsC = attribute('iCarsC', 'vec4');
  const uView = followVec(view);
  const at = attribute('iAt', 'vec4'), shape = attribute('iShape', 'vec4'), colour = attribute('iColour', 'vec4');
  const q = positionGeometry.xy, dir = shape.xy, side = vec2(dir.y.negate(), dir.x);
  // (4 added: a spot, a round pool whose light comes from the point `dir` away from its centre.)
  const spot = at.w.greaterThan(3.5), w2 = at.w.sub(select(spot, 4, 0));
  const high = w2.greaterThan(1.5), beam = w2.sub(select(high, 2, 0)).greaterThan(0.5);
  const l = select(beam, vec2(q.x.mul(0.5).add(0.5), q.y), q);
  const off = select(spot, q.mul(shape.z), select(beam, dir.mul(l.x).mul(shape.z).add(side.mul(q.y).mul(shape.w)), dir.mul(q.x).add(side.mul(q.y)).mul(shape.z)));
  // (A light of the other map is put outside the picture.)
  const mine = layer ? high : high.not();
  m.vertexNode = select(mine, vec4(at.xy.add(off).sub(uView.xy).mul(uView.zw), 0, 1), vec4(2, 2, 2, 1));
  const vP = at.xy.add(off).toVarying('vP'), vLamp = vec3(at.x.add(select(spot, dir.x, 0)), at.z.add(colour.a), at.y.add(select(spot, dir.y, 0))).toVarying('vLamp');
  const vCa: N = carsA.toVarying('vCa'), vCb: N = carsB.toVarying('vCb'), vCc: N = carsC.toVarying('vCc');
  const vL = l.toVarying('vL'), vC = colour.rgb.toVarying('vC'), vH = at.z.toVarying('vH'), vBeam = select(spot, 2, select(beam, 1, 0)).toVarying('vBeam');
  m.fragmentNode = Fn(() => {
    const f = float(0).toVar();
    If(vBeam.greaterThan(1.5), () => {
      const e = smoothstep(0.45, 1, length(vL)).oneMinus();
      f.assign(e.mul(e));
    }).ElseIf(vBeam.greaterThan(0.5), () => {
      const t = vL.x, a = abs(vL.y).div(t.mul(0.75).add(0.25));
      f.assign(t.oneMinus().mul(t.oneMinus()).mul(smoothstep(0.35, 1, a).oneMinus()).mul(smoothstep(0, 0.1, t)));
    }).Else(() => {
      const d = dot(vL, vL);
      f.assign(select(d.lessThan(1), d.oneMinus().mul(d.oneMinus()), 0));
    });
    If(f.lessThan(0.002), () => { Discard(); });
    If(uShadow.greaterThan(0.5).and(vCa.x.greaterThan(-0.5)), () => {
      const c = float(0).toVar();
      for (const k of ['x', 'y', 'z', 'w']) c.assign(max(c, max(cover(vCa[k], vP, vLamp, vH), cover(vCb[k], vP, vLamp, vH))));
      If(vCc.x.greaterThan(-0.5), () => {
        for (const k of ['x', 'y', 'z', 'w']) c.assign(max(c, cover(vCc[k], vP, vLamp, vH)));
      });
      f.mulAssign(c.oneMinus());
    });
    // The height the light falls at, weighted by its brightness (see lampLight).
    return vec4(vC.mul(f), vH.sub(uRef.x).mul(dot(vC, LUMA)).mul(f));
  })();
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneFactor;
  Object.assign(m, { depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false });
  return m;
}
setPools(poolsMaterial);

export const uLampOn = follow(LAMP_ON);
const uLampBox = followVec(LAMP_BOX), uLampRef = followVec(LAMP_REF);
let map: N = null, mapHigh: N = null;

// The lamps' light at a point in the world (0 by day and off the map); with a normal,
// what faces up and is well above the lamp gets none (lampLightOn).
// Each map's light reaches the walls a few metres up from the ground it falls on. The
// ground's own lights also reach down (a floodlit square, a cutting); a bridge's don't,
// so the street under a deck isn't lit from it.
export function lampLight(w: N, n?: N) {
  map ??= texture(LAMP_MAP.value ?? new THREE.Texture());
  mapHigh ??= texture(LAMP_MAP_HIGH.value ?? new THREE.Texture());
  const out = vec3(0).toVar();
  // Worked out here, not first inside the branch below: the lighting after it needs the normal too.
  const nv = n ? n.toVar() : null;
  const uv = w.xz.sub(uLampBox.xy).mul(uLampBox.zw).mul(0.5).add(0.5).toVar();
  const inside = uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.lessThanEqual(1));
  If(uLampOn.greaterThan(0.005).and(inside), () => {
    const at = vec2(uv.x, uv.y.oneMinus()).toVar();
    const up = nv ? smoothstep(0.5, 0.8, dot(nv, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)).toVar() : null;
    const from = (tex: N, low: [number, number]) => {
      const l = tex.sample(at).level(float(0)).toVar();
      const dy = w.y.sub(l.a.div(max(dot(l.rgb, LUMA), 1e-4)).add(uLampRef.x)).toVar();
      const k = smoothstep(3, 11, dy).oneMinus().mul(smoothstep(low[0], low[1], dy)).toVar();
      if (up) k.mulAssign(up.mul(smoothstep(3.5, 5.5, dy)).oneMinus());
      return l.rgb.mul(k);
    };
    out.assign(from(map, [-22, -16]));
    If(uLampRef.y.greaterThan(0.5), () => { out.addAssign(from(mapHigh, [-5, -2.5])); });
    out.mulAssign(uLampOn);
  });
  return out;
}

// Cache by both graph inputs. In particular, a converted material's own emissive
// graph may differ even when its port key is the same.
const litGraphs = new WeakMap<N, WeakMap<N, N>>();
const unlitGraphs = new WeakMap<N, N>();
const applied = new WeakMap<N, { graph: N }>();

// Adds the lamps' light to what a material already gives out, over its own diffuse colour.
export function lampLit(node: N, world: N = positionWorld) {
  const previous = applied.get(node);
  if (previous && node.emissiveNode === previous.graph) return;
  const emissive = node.emissiveNode ?? null;
  let byWorld = emissive === null ? unlitGraphs : litGraphs.get(emissive);
  if (!byWorld) litGraphs.set(emissive, (byWorld = new WeakMap()));
  let graph = byWorld.get(world);
  if (!graph) graph = Fn(() => {
    const e = vec3(emissive ?? 0).toVar();
    e.addAssign(diffuseColor.rgb.mul(lampLight(world, normalView)));
    return e;
  })();
  byWorld.set(world, graph);
  node.emissiveNode = graph;
  applied.set(node, { graph });
}
