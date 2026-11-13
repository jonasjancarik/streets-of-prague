// The trees in TSL (leafy and treeDepth in map/vegetation.ts): every tuft's leaves as
// flat tilted facets with creases, the small leaves on top of them, their colour through
// the year, bare twigs in winter,
// bark, snow on the crowns, and the warm and cool tint of the light through leaves.
// Registered as a port of the 'tufts-cut' material (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, mat4, attribute, instancedBufferAttribute, normalViewGeometry, faceDirection, modelViewMatrix,
  cameraViewMatrix, positionGeometry, positionLocal, positionWorld, diffuseColor, floor, fract, dot, sin, cos, atan, mix, smoothstep, step, length, abs, max, min,
  normalize, cross, sqrt, fwidth, distance, select, clamp, storage, buffer, instanceIndex,
} from 'three/tsl';
import { BARE, LEAVES, SEASON } from '../shading.ts';
import { CROWN, STEM, CROWN_BASE } from '../map/vegetation.ts';
import { lampLit } from './lamps.ts';
import { OLD_GRADE } from '../grade.ts';
import { CANOPY_SHOWN } from '../trees.ts';
import { type N, follow, followVec, addPort, uCut, uWet, uSnow, hash12, detail } from './common.ts';

const uBare = follow(BARE), uLeaves = follow(LEAVES), uSeason = followVec(SEASON);
const uCanopy = follow(CANOPY_SHOWN);
// Under the sprays of leaves laid over a crown (Ultra, from above) its tufts are the shade
// inside it: this much darker, so the sprays stand out against them as leaves in the light do.
const UNDER_SPRAYS = 0.58;
// Gaps in a crown's shadow: this share of every tuft lets the sun through, in patches about
// a fifth of a tuft across. Where tufts overlap the light is mostly stopped by the next, so a
// crown's shadow is dense in the middle and breaks up into flecks towards its edge.
const SHADOW_GAPS = 0.3;
const tuft: N = attribute('tuft', 'vec3'), yearly: N = attribute('yearly', 'float');
const TUFT_RIM = 0.5; // how dark a tuft's rim is (the same in vegetation.ts)
const outlineA: N = attribute('outlineA', 'vec4'), outlineB: N = attribute('outlineB', 'vec4');
// How far the crown reaches towards `p` in its own frame (vegetation.ts, outlineAt): the
// horizontal scale of a point of the crown.
export const outlineAt = (p: N): N => {
  const t = atan(p.z.negate(), p.x).div(Math.PI / 4);
  const near = (k: number) => {
    const d = t.sub(k).add(4);
    return max(0, float(1).sub(abs(d.sub(floor(d.div(8)).mul(8)).sub(4))));
  };
  let s: N = float(0);
  (['x', 'y', 'z', 'w'] as const).forEach((c, k) => { s = s.add(near(k).mul(outlineA[c])).add(near(k + 4).mul(outlineB[c])); });
  return s;
};
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

// bareTwig (BARE_GLSL in vegetation.ts): -1 where there's nothing, else how much of a twig
// it is. `p` is where in the crown, across it.
const bareTwig = Fn(([t, bare, p, above, size]: N[]) => {
  const out = float(0).toVar();
  If(t.z.lessThan(-3.5), () => {
    // Fallen leaves (bare: how many lie there; size: the crown's radius in metres): clumps
    // a foot across, thinning out towards the edge of the crown.
    const leaf = smallLeaves(p.mul(size).mul(3)).toVar();
    out.assign(select(leaf.x.greaterThan(0.12).and(leaf.y.lessThan(bare.mul(float(1.05).sub(dot(p, p).div(1.32))))), fract(leaf.y.mul(7)).mul(0.35), -1));
  }).ElseIf(t.z.lessThan(-1.5), () => { out.assign(1); }).ElseIf(bare.greaterThan(0), () => {
    If(t.z.lessThan(0), () => { out.assign(bare); }).Else(() => {
      const rr = length(p), th = atan(p.y, p.x).add(sin(rr.mul(5).add(t.z.mul(TAU))).mul(0.06));
      const u = fract(th.mul(6 / TAU)).sub(0.5);
      const d = abs(abs(abs(u).sub(smoothstep(0.22, 0.5, rr).mul(0.25))).sub(smoothstep(0.5, 0.85, rr).mul(0.125)));
      const twig = step(d.mul(rr).mul(TAU / 6), float(0.028).sub(min(rr, 1).mul(0.016))).mul(step(rr, mix(0.42, 0.9, above))).toVar();
      const r = length(t.xy);
      const fine = abs(fract(atan(t.y, t.x).mul(11 / TAU).add(t.z.mul(3))).sub(0.5)).mul(r).mul(TAU / 11);
      twig.assign(max(twig, step(fine, 0.009).mul(step(0.3, r)).mul(step(r, 0.7))));
      const c = smallLeaves(t.xy.mul(5).add(t.z.mul(31))).toVar();
      If(twig.lessThan(0.5).and(c.y.lessThan(bare)), () => { out.assign(-1); }).Else(() => { out.assign(twig.mul(bare)); });
    });
  });
  return out;
});

// `yearly` (vegetation.ts): the tree's own timing, whether it changes at all, and above
// that how long its trunk is (STEM).
const year = yearly.mod(STEM.span);
const own = fract(year), changes = float(1).sub(step(0.995, year).mul(step(year, 1.5)));
// (For the fallen leaves it is how many lie there: from early October.)
const litter = tuft.z.lessThan(-3.5), fallen = clamp(uSeason.x.mul(2).sub(0.8), 0, 1).mul(changes);
const vBare = () => select(litter, fallen, clamp(uBare.mul(1.6).sub(own.mul(0.6)), 0, 1).mul(changes));
// Where in the crown (across it), with how fresh and how far turned the leaves are: one
// varying for the four numbers (a fragment takes no more than 16). The fallen leaves
// have all turned, and carry the crown's radius in metres where the others say how fresh.
const crownSize = () => instanceMatrix().mul(vec4(1, 0, 0, 0)).xyz.length();
const crownTurn = () => select(litter, 1, clamp(uSeason.x.mul(1.7).sub(clamp(own.add(tuft.z.sub(0.5).mul(0.3)), 0, 1).mul(0.7)), 0, 1).mul(changes));
const crownMix = (): N => vec4(positionGeometry.xz, select(litter, crownSize(), uSeason.z.mul(changes)), crownTurn()).toVarying('crownMix');
const crownXZ = (): N => crownMix().xy;

// YEAR_VERTEX in vegetation.ts: the leaves' colour through the year. What depends on
// the tree and the tuft alone is worked out at the corners.
const yearColour = (colour: N) => {
  const pick = fract(own.mul(7.31).add(0.13));
  const shade = min(dot(colour, vec3(0.3, 0.59, 0.11)).div(0.15), 1.6);
  const c = colour.mul(mix(vec3(1), vec3(1.3, 1.25, 0.7), select(litter, 0, crownMix().z))).toVar();
  const autumn = mix(mix(vec3(0.58, 0.39, 0.03), vec3(0.32, 0.1, 0.02), smoothstep(0.25, 0.85, pick)), vec3(0.27, 0.03, 0.014), step(0.9, pick)).toVarying('treeAutumn');
  const turn = crownMix().w;
  c.assign(mix(c, autumn.mul(shade).mul(0.7), turn));
  const flower = mix(vec3(0.8, 0.78, 0.72), vec3(0.8, 0.6, 0.62), step(0.6, pick)).toVarying('treeFlower');
  const inFlower = uSeason.y.mul(step(1.5, year)).mul(step(0, tuft.z)).mul(0.85).toVarying('treeInFlower');
  return mix(c, flower.mul(shade).mul(0.7), inFlower);
};

// The tree's instance matrix, for the parts that need the plain crown (a tile's trees
// are one InstancedMesh). Read the way three.js's own instancing reads it: from a uniform
// buffer while the matrices fit in one, else, where the GPU has them, from a storage buffer
// both share (see shareInstances), since as vertex inputs each copy takes four of the 16 a
// pipeline may have (with more than ~1000 trees in a tile, the crowns went undrawn).
const matrixBuffers = new WeakMap<THREE.InstancedBufferAttribute, THREE.InstancedInterleavedBuffer>();
export const instanceMatrix = Fn((builder: N) => {
  shareInstances(builder);
  const m = builder.object.instanceMatrix as THREE.InstancedBufferAttribute & { isStorageInstancedBufferAttribute?: boolean };
  const count = Math.max(m.count, 1);
  if (m.isStorageInstancedBufferAttribute) return storage(m as any, 'mat4', count).element(instanceIndex);
  if (count * 64 <= builder.getUniformBufferLimit()) return (buffer(m.array as any, 'mat4', count) as N).element(instanceIndex);
  let interleaved = matrixBuffers.get(m);
  if (!interleaved) matrixBuffers.set(m, (interleaved = new THREE.InstancedInterleavedBuffer(m.array as Float32Array, 16, 1)));
  const col = (o: number): N => instancedBufferAttribute(interleaved, 'vec4', 16, o);
  return mat4(col(0), col(4), col(8), col(12));
});
// Before three.js's instancing is set up (setupPosition): too many matrices for a uniform
// buffer go in a storage buffer, which it then reads too (it checks this flag).
export const shareInstances = (builder: N) => {
  const m = builder.object.instanceMatrix as (THREE.InstancedBufferAttribute & { isStorageInstancedBufferAttribute?: boolean }) | undefined;
  if (m && !m.isStorageInstancedBufferAttribute && Math.max(m.count, 1) * 64 > builder.getUniformBufferLimit() && builder.isAvailable('storageBuffer')) {
    m.isStorageInstancedBufferAttribute = true;
  }
};
const inView = (v: N) => modelViewMatrix.mul(vec4(instanceMatrix().mul(vec4(v, 0)).xyz, 0)).xyz;

// The crown's lower part drawn out downwards to where the crown begins (CROWN_BASE in
// map/vegetation.ts): `y` in the crown's frame, `stem` how far below its middle the ground
// is. Only trees that have a trunk's length (broadleaf ones), and never squeezed.
export const crownBase = (stem: N): N => {
  const unit: N = instanceMatrix().mul(vec4(0, 1, 0, 0)).xyz.length();
  return max(stem.add(CROWN_BASE.top).mul(CROWN_BASE.share), float(CROWN_BASE.least).div(max(unit, 0.1))).sub(stem);
};
const lowered = (y: N, stem: N): N => {
  const k: N = max(float(CROWN_BASE.from).sub(crownBase(stem)).div(CROWN_BASE.from - CROWN_BASE.low), 1);
  return select(stem.greaterThan(0.3).and(y.lessThan(CROWN_BASE.from)), float(CROWN_BASE.from).sub(float(CROWN_BASE.from).sub(y).mul(k)), y);
};

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
  // Each tuft darker towards its rim (vegetation.ts), and the crown's own sunny and
  // shaded sides and its darker lower edge (CROWN).
  If(tuft.z.greaterThanEqual(0), () => {
    crease.mulAssign(mix(TUFT_RIM, 1.1, float(1).sub(smoothstep(0.35, 0.85, length(tuft.xy)))));
    // (Its round normal and the edge in one varying: a fragment takes no more than 16.)
    const p = positionGeometry;
    const edge = smoothstep(0.7, 1.05, length(p.xz)).mul(float(1).sub(smoothstep(0.1, 0.45, p.y)));
    const crown = vec4(inView(p.sub(vec3(0, 0.1, 0))), edge).toVarying('crown');
    normal.assign(normalize(mix(normal, normalize(crown.xyz), CROWN.round)));
    crease.mulAssign(mix(1, CROWN.rim, crown.w));
  });
  return vec4(normal, crease);
});

addPort(/^tufts-cut$/, (node) => {
  const proto = Object.getPrototypeOf(node);
  const twig = bareTwig(tuft, vBare(), crownXZ(), step(0.5, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).z), crownMix().z).toVar();
  const state = leafState().toVar();

  // A bare tree's core shrinks away, and the foot of the trunk goes down to the ground.
  const shrink = () => select(tuft.z.lessThan(0).and(tuft.z.greaterThan(-1.5)), float(1).sub(vBare().mul(0.85)), float(1));
  // The fallen leaves lie on the ground, and are folded away while there are none.
  const stem = floor(yearly.div(STEM.span)).mul(STEM.step);
  const shaped = (): N => {
    const p: N = positionGeometry.mul(shrink()), o: N = outlineAt(positionGeometry).mul(select(litter, step(0.01, fallen), 1));
    return vec3(p.x.mul(o), select(litter, float(0.02).sub(stem), select(tuft.z.lessThan(-2.5), stem.add(STEM.under).negate(), lowered(p.y, stem))), p.z.mul(o));
  };
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    positionLocal.assign(shaped());
    return proto.setupPosition.call(this, builder);
  };
  node.castShadowPositionNode = instanceMatrix().mul(vec4(shaped(), 1)).xyz;

  node.maskNode = positionWorld.y.greaterThan(uCut.y).and(distance(positionWorld.xz, uCut.xz).lessThan(uCut.w)).not();
  node.maskShadowNode = Fn(() => {
    const gap: N = hash12(floor(tuft.xy.mul(5).add(tuft.z.mul(31.7))).add(3.3)).lessThan(SHADOW_GAPS).and(tuft.z.greaterThanEqual(0));
    return bareTwig(tuft, vBare(), crownXZ(), float(1), crownMix().z).greaterThanEqual(0).and(gap.not());
  })();

  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    If(twig.lessThan(0), () => { Discard(); });
    const c = yearColour(diffuseColor.rgb).mul(state.w).mul(float(1).sub(uWet.mul(0.18))).toVar();
    // (Only while the tree is in leaf: a bare one has no sprays over it.)
    c.mulAssign(mix(1, UNDER_SPRAYS, uCanopy.mul(step(0, tuft.z)).mul(float(1).sub(smoothstep(0, 0.6, vBare())))));
    c.assign(mix(c, vec3(0.23, 0.2, 0.18), twig));
    If(uSnow.greaterThan(0.01), () => {
      const up = dot(state.xyz, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
      c.assign(mix(c, vec3(0.78, 0.8, 0.84), smoothstep(0.35, 0.8, up).mul(smoothstep(0.2, 0.8, uSnow)).mul(float(0.75).sub(twig.mul(0.45)))));
    });
    diffuseColor.assign(vec4(c, diffuseColor.a));
  };
  node.setupNormal = () => normalize(state.xyz);
  node.setupOutput = function (builder: N, out: N) {
    const lum = dot(out.rgb, vec3(0.3, 0.59, 0.11));
    // (With the filmic curve, grade.ts, the sunlit leaves need less of the warm tint and a little
    // less light than with the curve before it, under which these numbers were first set: the
    // crowns came out lime.)
    const tint = OLD_GRADE ? mix(vec3(0.88, 1, 1.06), vec3(1.14, 1.06, 0.7), smoothstep(0.04, 0.3, lum))
      : mix(vec3(0.84, 0.96, 1.04), vec3(0.94, 0.9, 0.7), smoothstep(0.04, 0.34, lum));
    return proto.setupOutput.call(this, builder, vec4(out.rgb.mul(tint), out.a));
  };
  lampLit(node);
});
