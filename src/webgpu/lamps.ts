// The lamps' light (LAMP_GLSL and lampLit in ../lamps.ts) in TSL: the pools drawn into
// the light map, and a lookup that adds what the map holds to a material.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, int, ivec2, vec2, vec3, vec4, texture, attribute, positionGeometry, positionWorld, normalView, normalWorld, cameraViewMatrix, diffuseColor,
  dot, smoothstep, abs, select, min, max, step, length, mix, sqrt, inverseSqrt, uniform, renderGroup, normalize, floor, fract, clamp,
} from 'three/tsl';
import './lampShadows.ts'; // (the nearest lamps' shadow maps: CLOSE)
import { CLOSE, CLOSE_MAP, CLOSE_ON, CLOSE_SLOTS, CLOSE_ROI, CLOSE_NORMAL } from '../lamps.ts';
import { LAMP_MAP, LAMP_MAP_HIGH, LAMP_MAP_OPEN, LAMP_MAP_NEAR, LAMP_NEAR, OPEN_ABOVE, LAMP_BOX, LAMP_REF, LAMP_ON, LAMP_SHADOWS, POOL, setPools, CAR_SHAPED, PERSON_SHAPED } from '../lamps.ts';

const LUMA = vec3(0.3, 0.59, 0.11);
import { type N, follow, followVec } from './common.ts';

// The pools of light, one instanced quad each (the ShaderMaterial in the Lamps constructor,
// where `cover` is explained too). `cars`: the texture of the boxes in the way; `layer`:
// which of the two maps it draws (0 the ground's, 1 the bridges'; 2 the ground's, but the
// light the boxes keep off instead of what gets past them: the right half of LAMP_MAP_NEAR).
function poolsMaterial(view: { value: THREE.Vector4 }, cars: THREE.Texture, layer: number) {
  const m = new NodeMaterial();
  const carTex = texture(cars), uShadow = follow(LAMP_SHADOWS), uRef = followVec(LAMP_REF);
  // How far the ray runs through a box, its corners in plan rounded off by r, and where it
  // leaves (`through` in the GLSL); and the light a stretch that long keeps off (`blocked`).
  const through = (from: N, D: N, lo: N, hi: N, r: N): N => {
    const t1: N = lo.sub(from).div(D), t2: N = hi.sub(from).div(D);
    const tn: N = min(t1, t2), tf: N = max(t1, t2);
    const t0: N = max(max(max(tn.x, tn.y), tn.z), 0), t3: N = min(min(min(tf.x, tf.y), tf.z), 1);
    const m: N = from.add(D.mul(t0.add(t3).mul(0.5)));
    const half: N = hi.xz.sub(lo.xz).mul(0.5), c: N = abs(m.xz.sub(hi.xz.add(lo.xz).mul(0.5)));
    const keep = select(r.greaterThan(0), smoothstep(-0.06, 0.06, length(max(c.sub(half).add(r), 0)).sub(r)).oneMinus(), float(1));
    return vec2(max(t3.sub(t0), 0).mul(length(D)).mul(keep), t3);
  };
  // (The edge is softer the further the shadow falls behind the box, and never sharper than the map's texels.)
  const blocked = (s: N, len: N): N => smoothstep(0, max(uRef.z, s.y.oneMinus().mul(len).mul(0.06).add(0.2)), s.x).mul(0.92);
  const cover = (id: N, p: N, lamp: N, gy: N): N => {
    const out = float(0).toVar();
    If(id.greaterThan(-0.5), () => {
      const i = int(id.add(0.5));
      const a = carTex.load(ivec2(i, int(0))).toVar(), b = carTex.load(ivec2(i, int(1))).toVar();
      const fw = a.zw, sd = vec2(a.w.negate(), a.z);
      // (A car's box comes with its half length negative: CAR_SHAPED; a person's with its
      // half width, and a two-wheeler's frame with both: PERSON_SHAPED.)
      const frame = step(b.x, 0).mul(step(b.y, 0)), car = step(b.x, 0).sub(frame), person = step(b.y, 0).sub(frame);
      const hl = abs(b.x), hw = abs(b.y), r = car.mul(CAR_SHAPED.corner).add(person.mul(min(hl, hw)));
      // (The open map: only what stands taller than the light, see LAMP_MAP_OPEN.)
      If(uShadow.lessThan(-1.5).and(lamp.y.greaterThanEqual(b.z)), () => {
        out.assign(0);
      }).ElseIf(abs(uShadow).lessThan(1.5), () => {
        const o = p.sub(a.xy), l = vec2(dot(o, fw), dot(o, sd));
        const d = length(max(abs(l).sub(vec2(hl, hw)).add(r), 0)).sub(r);
        out.assign(smoothstep(0, 1.2, d).oneMinus().mul(smoothstep(1.5, 3, abs(gy.sub(b.w))).oneMinus()).mul(0.55));
      }).Else(() => {
        const o = lamp.xz.sub(a.xy), e = p.sub(a.xy);
        const from = vec3(dot(o, fw), lamp.y.sub(b.w), dot(o, sd));
        const D = vec3(dot(e, fw), gy.sub(b.w), dot(e, sd)).sub(from).toVar();
        D.addAssign(step(0, D).mul(2).sub(1).mul(1e-4));
        const H = b.z.sub(b.w), len = length(D);
        // A car: the body up to the windows, and the cabin on it, shorter and narrower; a
        // person: the body up to the shoulders, and the head. The ray's stretches through
        // the two add up, as through one solid car or person. Anything else is the body
        // alone, the whole box (`belt` at its top, nothing on it).
        const shaped = car.add(person), [headL, headW] = PERSON_SHAPED.head;
        const belt = H.mul(mix(float(1), mix(float(CAR_SHAPED.belt), float(PERSON_SHAPED.shoulders), person), shaped));
        const body: N = through(from, D, vec3(hl.negate(), person.oneMinus().mul(0.12), hw.negate()), vec3(hl, belt, hw), r);
        const back = mix(float(CAR_SHAPED.cabin[0]), float(headL), person), front = mix(float(CAR_SHAPED.cabin[1]), float(headL), person);
        const across = mix(float(CAR_SHAPED.narrow), float(headW), person);
        const top: N = through(from, D, vec3(hl.mul(back).negate(), belt, hw.mul(across).negate()), vec3(hl.mul(front), H, hw.mul(across)), select(person.greaterThan(0.5), min(hl.mul(headL), hw.mul(headW)), r.mul(0.6)));
        const kept = blocked(vec2(body.x.add(top.x.mul(shaped)), max(body.y, top.y.mul(shaped))), len);
        out.assign(kept.mul(frame.mul(PERSON_SHAPED.frame - 1).add(1)));
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
  const off = select(spot, q.mul(shape.z), select(beam, dir.mul(l.x).mul(shape.z).add(side.mul(q.y).mul(shape.w)), dir.mul(q.x).mul(shape.z).add(side.mul(q.y).mul(shape.w))));
  // (A light of the other map is put outside the picture.)
  const mine = layer === 1 ? high : high.not(), kept = layer === 2;
  m.vertexNode = select(mine, vec4(at.xy.add(off).sub(uView.xy).mul(uView.zw), 0, 1), vec4(2, 2, 2, 1));
  const vP = at.xy.add(off).toVarying('vP'), vLamp = vec3(at.x.add(select(spot, dir.x, 0)), at.z.add(colour.a), at.y.add(select(spot, dir.y, 0))).toVarying('vLamp');
  const vCa: N = carsA.toVarying('vCa'), vCb: N = carsB.toVarying('vCb'), vCc: N = carsC.toVarying('vCc');
  // A street lamp's pool (one up on a head, see POOL): its reach over the head's height.
  const vU = select(spot.or(beam).not().and(colour.a.greaterThan(2.9)), sqrt(shape.z.mul(shape.w)).div(colour.a.mul(POOL.height)), 0).toVarying('vU');
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
      If(vU.greaterThan(0), () => {
        const e = d.mul(vU).mul(vU).add(1);
        f.assign(inverseSqrt(e).div(e).mul(smoothstep(0.5, 1, d).oneMinus()).mul(POOL.peak));
      }).Else(() => {
        f.assign(select(d.lessThan(1), d.oneMinus().mul(d.oneMinus()), 0));
      });
    });
    If(f.lessThan(0.002), () => { Discard(); });
    const c = float(0).toVar();
    If(uShadow.greaterThan(0.5).or(uShadow.lessThan(-1.5)).and(vCa.x.greaterThan(-0.5)), () => {
      for (const k of ['x', 'y', 'z', 'w']) c.assign(max(c, max(cover(vCa[k], vP, vLamp, vH), cover(vCb[k], vP, vLamp, vH))));
      If(vCc.x.greaterThan(-0.5), () => {
        for (const k of ['x', 'y', 'z', 'w']) c.assign(max(c, cover(vCc[k], vP, vLamp, vH)));
      });
    });
    f.mulAssign(kept ? c : c.oneMinus());
    // The height the light falls at, weighted by its brightness (see lampLight).
    return vec4(vC.mul(f), kept ? 0 : vH.sub(uRef.x).mul(dot(vC, LUMA)).mul(f));
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
const uLampBox = followVec(LAMP_BOX), uLampRef = followVec(LAMP_REF), uLampNear = followVec(LAMP_NEAR);
let map: N = null, mapHigh: N = null, mapOpen: N = null, mapNear: N = null, closeMap: N = null;

// The nearest lamps' shadows (CLOSE in ../lamps.ts): the light their pools would give at
// world point `w` (what the maps hold for them there, the pools' shader's arithmetic) where
// their shadow maps say something is in the way. The maps are read texel by texel and the
// four round the point weighed (a filtered depth comparison can't be made inside a branch).
const uCloseOn = follow(CLOSE_ON), uRoi = followVec(CLOSE_ROI), uNormalOff = follow(CLOSE_NORMAL);
const followMat = (v: { value: THREE.Matrix4 }) => { const u = uniform(v.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(v.value); return u.value; }); return u; };
const closeSlots = CLOSE_SLOTS.map((s) => ({ pool: followVec(s.pool), dir: followVec(s.dir), colour: followVec(s.colour), head: followVec(s.head), matrix: followMat(s.matrix) }));
// `n`: the surface's normal in the world, when there is one.
function closeShade(w: N, n: N | null) {
  closeMap ??= texture(CLOSE_MAP.value ?? new THREE.Texture());
  const lost = vec3(0).toVar();
  const size = CLOSE.size;
  closeSlots.forEach((s, slot) => {
    If(s.dir.w.greaterThan(0), () => {
      const o = w.xz.sub(s.pool.xy), q = vec2(dot(o, s.dir.xy).div(s.pool.z), dot(o, vec2(s.dir.y.negate(), s.dir.x)).div(s.pool.w));
      const d = dot(q, q).toVar(), e = d.mul(s.dir.z).mul(s.dir.z).add(1);
      const f = inverseSqrt(e).div(e).mul(smoothstep(0.5, 1, d).oneMinus()).mul(POOL.peak).toVar();
      If(f.greaterThan(0.002), () => {
        // (Moved off itself, so a surface doesn't shade itself: along its normal by
        // CLOSE_NORMAL, and towards the lamp by one of the map's texels there and 2 cm.)
        const toward = s.head.xyz.sub(w), texel = length(toward).mul(s.head.w);
        const off = n ? n.mul(uNormalOff) : vec3(0);
        const p = s.matrix.mul(vec4(w.add(off).add(normalize(toward).mul(texel.add(0.02))), 1)).toVar();
        const ndc = p.xyz.div(p.w).toVar();
        If(p.w.greaterThan(0).and(abs(ndc.x).lessThan(1)).and(abs(ndc.y).lessThan(1)).and(ndc.z.lessThan(1)), () => {
          // Three by three of the four texels round the point, weighed as filtered lookups
          // would be, averaged: a 4×4 block, the outer rows and columns by how near they are.
          const at = vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)).mul(size).sub(0.5).toVar();
          const i0 = floor(at).toVar(), fr = fract(at).toVar();
          const wx = [fr.x.oneMinus(), float(1), float(1), fr.x], wy = [fr.y.oneMinus(), float(1), float(1), fr.y];
          const shown = float(0).toVar();
          for (let y = -1; y <= 2; y++) for (let x = -1; x <= 2; x++) {
            const c = clamp(i0.add(vec2(x, y)), 0, size - 1);
            shown.addAssign(step(ndc.z, closeMap.load(ivec2(int(c.x.add(slot * size)), int(c.y)))).mul(wx[x + 1]).mul(wy[y + 1]));
          }
          shown.divAssign(9);
          lost.addAssign(s.colour.rgb.mul(f).mul(shown.oneMinus()).mul(s.dir.w));
        });
      });
    });
  });
  return lost;
}
// A building's roofs: how far a face must look up to count as one (the cosine of its
// slope: from 70° to 55°, so steep roofs too but no wall), and from what height over the
// lit ground it gets no lamplight (m; a doorstep or a low plinth below that still does).
const ROOF = { facing: [0.34, 0.57], over: [1.2, 2.2] };
const WALL_MOST = 0.85; // the most lamplight a wall takes (its roll-off's ceiling)

// The lamps' light at a point in the world (0 by day and off the map); with a normal,
// what faces up and is well above the lamp gets none (lampLightOn).
// Each map's light reaches the walls a few metres up from the ground it falls on. The
// ground's own lights also reach down (a floodlit square, a cutting); a bridge's don't,
// so the street under a deck isn't lit from it.
// `roofs`: the surface is a building's, whose faces that look up are roofs: they get none
// from a little over the ground up, however low the roof (a shed's beside a lamp was lit
// as if the lamp shone from above it; the map knows the ground a light falls on, not how
// high its head is). The same arithmetic with other numbers, so it costs a pixel nothing.
// `tall`: a landmark, lit by the floodlights at its foot all the way up, fading towards its
// top (TALL: from where and to where over the lit ground, m, and the most light it takes),
// on its roofs and spires too. (The ordinary reach, a few metres, left every
// tower and church dark from the first cornice up. The map can't tell a floodlight's light
// from a street lamp's, so a landmark beside a street lamp is lit as high; nearly all of
// them are floodlit, and the ceiling on walls keeps it modest.)
const TALL = { reach: [10, 62], most: 1.1 };
export function lampLight(w: N, n?: N, roofs = false, tall = false) {
  map ??= texture(LAMP_MAP.value ?? new THREE.Texture());
  mapHigh ??= texture(LAMP_MAP_HIGH.value ?? new THREE.Texture());
  mapOpen ??= texture(LAMP_MAP_OPEN.value ?? new THREE.Texture());
  mapNear ??= texture(LAMP_MAP_NEAR.value ?? new THREE.Texture());
  const out = vec3(0).toVar();
  // Worked out here, not first inside the branch below: the lighting after it needs the normal too.
  const nv = n ? n.toVar() : null;
  const uv = w.xz.sub(uLampBox.xy).mul(uLampBox.zw).mul(0.5).add(0.5).toVar();
  const inside = uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.lessThanEqual(1));
  If(uLampOn.greaterThan(0.005).and(inside), () => {
    const at = vec2(uv.x, uv.y.oneMinus()).toVar();
    const facing = roofs ? ROOF.facing : [0.5, 0.8], over = roofs ? ROOF.over : [3.5, 5.5];
    const reach = tall ? TALL.reach : [3, 11];
    // (A landmark's normals all point up, for the sun's sake: which way its faces look can't be asked.)
    const up = nv && !tall ? smoothstep(facing[0], facing[1], dot(nv, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)).toVar() : null;
    const from = (tex: N, low: [number, number], open = false) => {
      const l = tex.sample(at).level(float(0)).toVar();
      if (open) {
        // Round where you look, the sharp map (LAMP_MAP_NEAR), fading to this one at its edge.
        If(uLampNear.w.greaterThan(0.5), () => {
          const q = w.xz.sub(uLampNear.xy).mul(uLampNear.z).toVar();
          const k = smoothstep(0.8, 1, max(abs(q.x), abs(q.y))).oneMinus().toVar();
          If(k.greaterThan(0), () => {
            l.assign(mix(l, mapNear.sample(vec2(q.x.mul(0.25).add(0.25), q.y.mul(0.5).add(0.5).oneMinus())).level(float(0)), k));
          });
        });
      }
      const dy = w.y.sub(l.a.div(max(dot(l.rgb, LUMA), 1e-4)).add(uLampRef.x)).toVar();
      const opened = float(0).toVar(); // (how much of the open map's light, which has no boxes in it)
      if (open) {
        // Above the cars, the light nothing stands in (LAMP_MAP_OPEN in ../lamps.ts),
        // which also knows the ground under a car's shadow.
        If(uLampRef.w.greaterThan(0.5), () => {
          const o = mapOpen.sample(at).level(float(0)).toVar();
          dy.assign(w.y.sub(o.a.div(max(dot(o.rgb, LUMA), 1e-4)).add(uLampRef.x)));
          opened.assign(smoothstep(OPEN_ABOVE[0], OPEN_ABOVE[1], dy));
          l.assign(vec4(mix(l.rgb, o.rgb, opened), l.a));
        });
      }
      const k = smoothstep(reach[0], reach[1], dy).oneMinus().mul(smoothstep(low[0], low[1], dy)).toVar();
      if (up) k.mulAssign(up.mul(smoothstep(over[0], over[1], dy)).oneMinus());
      if (open) {
        // Round you, the nearest lamps' real shadows instead of their boxes' (CLOSE): the
        // light the boxes kept off back (the right half of LAMP_MAP_NEAR), less what
        // the shadows keep off; towards the circle's edge the boxes' come back.
        const change = vec3(0).toVar();
        If(uCloseOn.greaterThan(0.5), () => {
          const inside = smoothstep(uRoi.z.mul(0.75), uRoi.z, length(w.xz.sub(uRoi.xy))).oneMinus().toVar();
          If(inside.greaterThan(0), () => {
            const q = w.xz.sub(uLampNear.xy).mul(uLampNear.z);
            const back = mapNear.sample(vec2(q.x.mul(0.25).add(0.75), q.y.mul(0.5).add(0.5).oneMinus())).level(float(0)).rgb;
            const gone = closeShade(w, nv ? normalize(normalWorld) : null);
            change.assign(back.mul(opened.oneMinus()).sub(gone).mul(inside));
          });
        });
        return max(l.rgb.add(change), 0).mul(k);
      }
      return l.rgb.mul(k);
    };
    out.assign(from(map, [-22, -16], true));
    If(uLampRef.y.greaterThan(0.5), () => { out.addAssign(from(mapHigh, [-5, -2.5])); });
    out.mulAssign(uLampOn);
  });
  return out;
}

// Cache by both graph inputs. In particular, a converted material's own emissive
// graph may differ even when its port key is the same.
const caches = () => ({ lit: new WeakMap<N, WeakMap<N, N>>(), unlit: new WeakMap<N, N>() });
const plainGraphs = caches(), roofGraphs = caches(), tallGraphs = caches();
const applied = new WeakMap<N, { graph: N }>();

// Adds the lamps' light to what a material already gives out, over its own diffuse colour.
// `roofs`: a building, whose roofs the lamps leave dark (lampLight).
export function lampLit(node: N, world: N = positionWorld, roofs = false, tall = false) {
  const previous = applied.get(node);
  if (previous && node.emissiveNode === previous.graph) return;
  const emissive = node.emissiveNode ?? null;
  const { lit: litGraphs, unlit: unlitGraphs } = tall ? tallGraphs : roofs ? roofGraphs : plainGraphs;
  let byWorld = emissive === null ? unlitGraphs : litGraphs.get(emissive);
  if (!byWorld) litGraphs.set(emissive, (byWorld = new WeakMap()));
  let graph = byWorld.get(world);
  if (!graph) graph = Fn(() => {
    const e = vec3(emissive ?? 0).toVar();
    const light: N = lampLight(world, normalView, roofs, tall).toVar();
    // What stands right beside a lamp (the wall its bracket is on, its own pole) takes the
    // brightest middle of its pool, which from the street is a burnt-out white sheet: on
    // what doesn't face up the light rolls off towards WALL_MOST. (The map knows the light
    // on the ground, not how it falls on a wall.)
    const wall: N = smoothstep(0.3, 0.7, dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)).oneMinus();
    if (tall) light.divAssign(dot(light, LUMA).div(TALL.most).add(1)); // (its ceiling, whichever way a face looks)
    else light.divAssign(dot(light, LUMA).div(WALL_MOST).mul(wall).add(1));
    e.addAssign(diffuseColor.rgb.mul(light));
    return e;
  })();
  byWorld.set(world, graph);
  node.emissiveNode = graph;
  applied.set(node, { graph });
}
