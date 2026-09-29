// The trees in TSL (leafy and treeDepth in map/vegetation.ts): every tuft's leaves as
// flat tilted facets with creases, the small leaves on top of them, bare twigs in winter,
// bark, snow on the crowns, and the warm and cool tint of the light through leaves.
// Registered as a port of the 'tufts-cut' material (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, mat4, attribute, instancedBufferAttribute, normalViewGeometry, faceDirection, modelViewMatrix,
  cameraViewMatrix, positionGeometry, positionLocal, positionWorld, diffuseColor, floor, fract, dot, sin, cos, atan, mix, smoothstep, step, length, abs, max, min,
  normalize, cross, sqrt, fwidth, distance, select,
} from 'three/tsl';
import { BARE, LEAVES } from '../shading.ts';
import { lampLit } from './lamps.ts';
import { type N, follow, addPort, uCut, uWet, uSnow, hash12, detail } from './common.ts';

const uBare = follow(BARE), uLeaves = follow(LEAVES);
const tuft: N = attribute('tuft', 'vec3'), evergreen: N = attribute('evergreen', 'float');
const TAU = 6.2832;

// smallLeaves in vegetation.ts: x = gap to the next leaf, y = random, zw = from the leaf's middle.
const smallLeaves = (p: N) => {
  const i = floor(p.sub(0.5)), f = p.sub(i);
  const d1 = float(8).toVar(), d2 = float(8).toVar(), o1 = vec2(0).toVar(), c1 = vec2(0).toVar();
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const g = vec2(x, y);
    const r = g.add(vec2(hash12(i.add(g)), hash12(i.add(g).add(17.3))).mul(0.75)).add(0.125).sub(f);
    const d = dot(r, r);
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); o1.assign(r); c1.assign(i.add(g)); })
      .ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  }
  return vec4(sqrt(d2).sub(sqrt(d1)), hash12(c1.add(5.1)), o1.negate());
};

// bareTwig: -1 where there's nothing, else how much of a twig it is.
const bareTwig = Fn(([t, bare]: N[]) => {
  const out = float(0).toVar();
  If(bare.greaterThan(0), () => {
    If(t.z.lessThan(0), () => { out.assign(bare); }).Else(() => {
      const r = length(t.xy), s = t.z.mul(TAU);
      const a = atan(t.y, t.x).add(sin(r.mul(9).add(s)).mul(0.25));
      const bough = abs(fract(a.mul(7 / TAU).add(t.z.mul(3))).sub(0.5)).mul(r).mul(TAU / 7);
      const fork = abs(fract(a.mul(14 / TAU).add(t.z.mul(5))).sub(0.5)).mul(r).mul(TAU / 14);
      const twig = max(step(bough, float(0.045).sub(r.mul(0.025))), step(fork, float(0.025).sub(r.mul(0.012))).mul(step(0.45, r))).toVar();
      const c = smallLeaves(t.xy.mul(5).add(t.z.mul(31))).toVar();
      twig.assign(max(twig, step(c.x, 0.06).mul(step(0.5, r)).mul(step(0.4, hash12(floor(t.xy.mul(9).add(t.z.mul(17))))))));
      If(twig.lessThan(0.5).and(c.y.lessThan(bare)), () => { out.assign(-1); }).Else(() => { out.assign(twig.mul(bare)); });
    });
  });
  return out;
});

const vBare = () => uBare.mul(float(1).sub(evergreen));

// The tree's instance matrix, for the parts that need the plain crown (a tile's trees
// are one InstancedMesh; three.js keeps its own copy of the node inside).
const matrixBuffers = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>();
export const instanceMatrix = Fn((builder: N) => {
  const m = builder.object.instanceMatrix as THREE.InstancedBufferAttribute;
  let buffer = matrixBuffers.get(m);
  if (!buffer) matrixBuffers.set(m, (buffer = new THREE.InstancedInterleavedBuffer(m.array as Float32Array, 16, 1)));
  const col = (o: number): N => instancedBufferAttribute(buffer, 'vec4', 16, o);
  return mat4(col(0), col(4), col(8), col(12));
});
const inView = (v: N) => modelViewMatrix.mul(vec4(instanceMatrix().mul(vec4(v, 0)).xyz, 0)).xyz;

// The leaves' layout: returns (normal, crease) in view space. tw and sd are the
// footprint of the tuft and of its small leaves (derivatives, so worked out first).
const leafState = Fn(() => {
  const tw = fwidth(length(tuft.xy)).toVar();
  const sd = detail(tuft.xy.mul(8), 1.5);
  const normal = normalize(normalViewGeometry).mul(faceDirection).toVar();
  const crease = float(1).toVar();
  If(uLeaves.greaterThan(0.5).and(tuft.z.greaterThanEqual(0)).and(tw.lessThan(0.3)), () => {
    const r = length(tuft.xy), s = tuft.z.mul(TAU), k = TAU / 5;
    const a0 = atan(tuft.y, tuft.x);
    const topEdge = float(0.44).add(cos(a0.add(s).mul(5).add(3.1416)).mul(0.1));
    const top = step(r, topEdge);
    const a = a0.add(s).add(top.mul(k * 0.5)).add(r.mul(0.7));
    const f = a.div(k).add(0.5), leaf = floor(f);
    const mid = leaf.mul(k).sub(s).sub(top.mul(k * 0.5));
    const T = normalize(inView(attribute('across', 'vec3')).toVarying('leafAcross'));
    const B = normalize(inView(attribute('along', 'vec3')).toVarying('leafAlong'));
    const N0 = normalize(cross(T, B));
    const N = select(dot(N0, normal).lessThan(0), N0.negate(), N0);
    const rnd = fract(sin(leaf.mul(12.9).add(s.mul(7))).mul(43758.5));
    const tilt = mix(0.95, 0.45, top).mul(rnd.mul(0.8).add(0.6)).mul(smoothstep(0.08, 0.22, r));
    const ln = normalize(N.add(T.mul(cos(mid.add(rnd).sub(0.5))).add(B.mul(sin(mid.add(rnd).sub(0.5)))).mul(tilt)));
    normal.assign(normalize(mix(normal, ln, 0.6)));
    const fr = fract(f);
    const gap = min(fr, float(1).sub(fr)).mul(k).mul(r);
    const w = tw.add(0.008);
    crease.assign(mix(0.78, 1, smoothstep(0, w.mul(1.5), gap).add(float(1).sub(smoothstep(0.1, 0.2, r))))
      .mul(mix(0.75, 1, smoothstep(0, w.mul(1.5), abs(r.sub(topEdge))))));
    If(sd.greaterThan(0.01), () => {
      const sl = smallLeaves(tuft.xy.mul(8));
      const jit = vec2(hash12(sl.yy.mul(91)), hash12(sl.yy.mul(37).add(3))).sub(0.5);
      normal.assign(normalize(normal.add(T.mul(sl.z.mul(1.3).add(jit.x.mul(0.7))).add(B.mul(sl.w.mul(1.3).add(jit.y.mul(0.7)))).mul(sd))));
      crease.mulAssign(mix(1, float(0.78).add(sl.y.mul(0.38)).mul(mix(0.7, 1, smoothstep(0, 0.12, sl.x))), sd));
    });
  });
  return vec4(normal, crease);
});

addPort(/^tufts-cut$/, (node) => {
  const proto = Object.getPrototypeOf(node);
  const twig = bareTwig(tuft, vBare()).toVar();
  const state = leafState().toVar();

  // Twigs alone are left of a bare tree's core, which shrinks to its thicker branches.
  const shrink = () => select(tuft.z.lessThan(0), float(1).sub(vBare().mul(0.5)), float(1));
  node.setupPosition = function (builder: N) {
    positionLocal.mulAssign(shrink());
    return proto.setupPosition.call(this, builder);
  };
  node.castShadowPositionNode = instanceMatrix().mul(vec4(positionGeometry.mul(shrink()), 1)).xyz;

  node.maskNode = positionWorld.y.greaterThan(uCut.y).and(distance(positionWorld.xz, uCut.xz).lessThan(uCut.w)).not();
  node.maskShadowNode = bareTwig(tuft, vBare()).greaterThanEqual(0);

  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    If(twig.lessThan(0), () => { Discard(); });
    const c = diffuseColor.rgb.mul(state.w).mul(float(1).sub(uWet.mul(0.18))).toVar();
    c.assign(mix(c, vec3(0.3, 0.27, 0.24), twig));
    If(uSnow.greaterThan(0.01), () => {
      const up = dot(state.xyz, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
      c.assign(mix(c, vec3(0.78, 0.8, 0.84), smoothstep(0.35, 0.8, up).mul(smoothstep(0.2, 0.8, uSnow)).mul(float(0.75).sub(twig.mul(0.45)))));
    });
    diffuseColor.assign(vec4(c, diffuseColor.a));
  };
  node.setupNormal = () => normalize(state.xyz);
  node.setupOutput = function (builder: N, out: N) {
    const lum = dot(out.rgb, vec3(0.3, 0.59, 0.11));
    const tint = mix(vec3(0.88, 1, 1.06), vec3(1.14, 1.06, 0.7), smoothstep(0.04, 0.3, lum));
    return proto.setupOutput.call(this, builder, vec4(out.rgb.mul(tint), out.a));
  };
  lampLit(node);
});
