// The cars, trams, funicular and boats in TSL (the onBeforeCompile of their module-level
// materials in car.ts, trams.ts, funicular.ts and boats.ts): snow on the cars' roofs, lit
// windows and navigation lights at night, and the lamps' light. Registered as ports of
// the 'cars', 'trams', 'funicular' and 'boats' materials (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fn, float, vec2, vec3, vec4, attribute, vertexColor, normalView, cameraViewMatrix, cameraWorldMatrix, diffuseColor, renderGroup, positionLocal, positionWorld, positionViewDirection, normalLocal, positionGeometry, materialColor, normalize, dot, smoothstep, mix, select, sin, min, cos, max, floor, mod, exp2, reflect, atan, pow, uniform, texture, cubeTexture, length, clamp, step, distance } from 'three/tsl';
import { LAMP_GLOW, CAR_GLOSS, CAR_MIRROR, CAR_REFLECT as R, CAR_STRIPS as CS, AREA_STEP, DENT_STEP, DENT_SHAPE as DS } from '../car.ts';
import { STRIPS, STRIPS_ON, onStrips } from '../reflections.ts';
import { PROBE_AT, PROBE_K, PROBE_MAP, PROBE_MIX, PROBE_NEAR, PROBE_PREV, onProbe } from '../probe.ts';
import { SKY_REF, STREET_REF, SUN_DIR, SUN_LIGHT } from '../shading.ts';
import { lampLit, lampLight, uLampOn } from './lamps.ts';
import { shareInstances } from './trees.ts';
import { type N, addPort, uSnow, uWet, follow, followColor } from './common.ts';

const luma = (c: N) => dot(c, vec3(0.3, 0.59, 0.11));

// Adds to the material's emissive colour (what the GLSL adds to totalEmissiveRadiance).
const glow = (node: N, light: () => N) => {
  const emissive = node.emissiveNode;
  node.emissiveNode = (emissive ? vec3(emissive) : vec3(0)).add(light());
};

// An open door turns about its hinge: `hinge` is where that is (x, z) and which door
// (0 for the rest of the car), `doors` how far each of the car's four is open. The left
// ones (1 and 3) open the other way round.
const hinge: N = attribute('hinge', 'vec3'), doors: N = attribute('doors', 'vec4');
const opened = select(hinge.z.lessThan(0.5), float(0),
  select(hinge.z.lessThan(1.5), doors.x.negate(),
    select(hinge.z.lessThan(2.5), doors.y,
      select(hinge.z.lessThan(3.5), doors.z.negate(), doors.w))));
const swing = (p: N): N => {
  const c = cos(opened), s = sin(opened);
  return vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)));
};

// A lamp is dark when it's smashed and glows when it's on. Which of the car's four a
// vertex is part of is packed into `painted`, and the car's lamps into `paint.w` (see
// LAMP in car.ts): -1 here for a smashed one, 0 off, or how bright.
const painted: N = attribute('painted', 'float'), paint: N = attribute('paint', 'vec4');
const own: N = mod(painted, 16), lampAt: N = floor(own.mul(0.5).add(0.01));
// (Which lamp, if any, in a varying of its own: `painted` also holds where the vertex is.)
const lamp: N = lampAt.toVarying('vLamp');
const tail: N = mod(floor(paint.w.div(32)), 4);
const smashed: N = mod(floor(paint.w.div(exp2(lampAt.sub(1)))), 2).greaterThan(0.5);
const lit: N = select(lampAt.lessThan(0.5), float(0), select(smashed, float(-1),
  select(lampAt.lessThan(2.5), mod(floor(paint.w.div(16)), 2), select(tail.greaterThan(1.5), float(1.5), tail.mul(0.45)))));
// The car's kind of area (reflections.ts) rides along in the same varying, 4 a step.
const packed: N = lit.add(mod(floor(paint.w.div(AREA_STEP)), DENT_STEP / AREA_STEP).mul(4)).toVarying('vLit');
const area: N = floor(packed.add(1.5).div(4));
const shine: N = packed.sub(area.mul(4));

// The dents (DENT_GLSL in car.ts): where on the car a vertex is, how crumpled each
// corner and side is, how far the nose, tail, left and right are pushed in there.
const dentLevel = (i: number): N => mod(floor(floor(paint.w.div(DENT_STEP)).div(4 ** i)), 4);
const zone: N = floor(painted.div(16));
const at: N = vec2(mod(zone, 32).div(15.5).sub(1), float(1).sub(floor(zone.div(32)).div(15.5)));
const dentAt = (): N => {
  const l: N = smoothstep(-0.9, 0.7, at.y), r: N = smoothstep(-0.9, 0.7, at.y.negate()), mid: N = float(1).sub(at.x.mul(at.x));
  const nose: N = smoothstep(0.45, 1, at.x).mul(dentLevel(0).mul(l).add(dentLevel(1).mul(r)));
  const tail: N = smoothstep(0.45, 1, at.x.negate()).mul(dentLevel(2).mul(l).add(dentLevel(3).mul(r)));
  const left: N = smoothstep(0.4, 1, at.y).mul(mid).mul(dentLevel(4)), right: N = smoothstep(0.4, 1, at.y.negate()).mul(mid).mul(dentLevel(5));
  return vec4(nose, tail, left, right);
};
const bumpy = (p: N): N => sin(p.x.mul(11).add(p.z.mul(7))).add(sin(p.z.mul(13).sub(p.y.mul(9)).add(2))).mul(0.25).add(0.5);
const dented = (p: N, d: N): N => {
  const w = bumpy(p).add(0.5), all = d.x.add(d.y).add(d.z).add(d.w);
  const q = vec3(p.x.add(d.y.sub(d.x).mul(DS.nose).mul(w)), p.y, p.z.add(d.z.sub(d.w).mul(DS.side).mul(w)));
  return vec3(q.x, q.y.mul(float(1).sub(all.mul(DS.sag).mul(bumpy(q.zyx)))), q.z);
};
const dentNormal = (n: N, p: N, d: N): N =>
  normalize(n.add(vec3(sin(p.z.mul(17).add(1)), 0, sin(p.x.mul(19))).mul(d.x.add(d.y).add(d.z).add(d.w).mul(DS.tilt))));
// The colour of a vertex, painted (in the vertex stage, in place of the vertex colour's
// own varying).
const tinted: N = attribute('color', 'vec3').mul(mix(vec3(1), paint.rgb, own.sub(lampAt.mul(2)))).toVarying('vTint');
// Where on a crazed window a point is (x and z on the car), and whether it's crazed.
const crackAt: N = (() => {
  const c: N = attribute('color', 'vec3');
  const end = select(at.x.greaterThan(0.05), max(dentLevel(0), dentLevel(1)), select(at.x.lessThan(-0.05), max(dentLevel(2), dentLevel(3)), float(0)));
  const side = select(at.y.greaterThan(0.4), dentLevel(4), select(at.y.lessThan(-0.4), dentLevel(5), float(0)));
  const glassy = own.lessThan(0.5).and(luma(c).lessThan(0.04)).and(c.z.greaterThan(c.x.mul(1.25))).and(max(end, side).greaterThanEqual(2));
  return vec3(positionGeometry.x, positionGeometry.z, select(glassy, float(1), float(0))).toVarying('vCrack');
})();
// The cracks (CRACKS_GLSL in car.ts).
const cracks = (p: N): N => {
  const a = p.x.mul(6).add(sin(p.y.mul(17)).mul(0.35)).fract().sub(0.5).abs();
  const b = p.x.mul(0.5).add(p.y.mul(0.87)).mul(7).add(sin(p.x.mul(23)).mul(0.3)).fract().sub(0.5).abs();
  const c = p.x.mul(0.5).sub(p.y.mul(0.87)).mul(8).add(sin(p.y.mul(19).add(1)).mul(0.3)).fract().sub(0.5).abs();
  return smoothstep(0.03, 0.09, min(a, min(b, c))).oneMinus();
};

// The gloss (CAR_GLOSS in car.ts): the sky and the lamps' light mirrored by what faces up, and
// more of it by what's seen at a slant; more when wet.
// And what they mirror (CAR_REFLECT in car.ts): the street round the car, the sky above it.
const uSkyRef: N = followColor(SKY_REF), uStreetRef: N = followColor(STREET_REF), uSunLight: N = followColor(SUN_LIGHT);
const uMirror: N = follow(CAR_MIRROR);
const uSunDir: N = (() => {
  const u = uniform(SUN_DIR.value.clone()).setGroup(renderGroup);
  u.onRenderUpdate(() => { u.value.copy(SUN_DIR.value); return u.value; });
  return u;
})();
const carTop = (): N => smoothstep(0.35, 0.9, dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz));
const uStripsOn: N = follow(STRIPS_ON);
const uProbeK: N = follow(PROBE_K), uProbeMix: N = follow(PROBE_MIX);
const probeNodes: [N, N][] = [];
onProbe(() => { for (const [now, prev] of probeNodes) { now.value = PROBE_MAP.value; prev.value = PROBE_PREV.value; } });
const uProbeAt: N = (() => { const u = uniform(PROBE_AT.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(PROBE_AT.value); return u.value; }); return u; })();
const uProbeNear: N = (() => { const u = uniform(PROBE_NEAR.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(PROBE_NEAR.value); return u.value; }); return u; })();
const stripNodes: N[] = [];
onStrips((t) => { for (const n of stripNodes) n.value = t; });
const carStreet = (r: N): N => {
  const a = atan(r.z, r.x);
  const edge = float(R.edge).add(sin(a.mul(5)).mul(0.55).add(sin(a.mul(13).add(1.7)).mul(0.3)).add(sin(a.mul(31).add(0.4)).mul(0.15)).mul(R.ragged));
  const sky = uSkyRef.mul(mix(R.horizon, R.zenith, smoothstep(0.1, 0.9, r.y)));
  const walls = uStreetRef.mul(mix(0.75, 1.05, smoothstep(-0.02, edge, r.y)));
  const ground: N = uStreetRef.mul(0.5), above: N = smoothstep(-0.06, 0, r.y);
  const made = mix(ground, mix(walls, sky, smoothstep(edge.sub(0.015), edge.add(0.015), r.y)), above);
  // The strip of the car's kind of area, where the strips are in.
  const v: N = float(CS.stripHorizon).mul(r.y.div(max(length(r.xz), 0.001)).div(CS.stripTop).oneMinus());
  const sample: N = texture(STRIPS.value, vec2(a.div(6.2832).add(0.5), float(1).sub(area.add(clamp(v, 0.01, 0.99)).div(CS.kinds))));
  stripNodes.push(sample);
  const street = sample.rgb.mul(luma(uStreetRef)).mul(CS.stripGain);
  const strip = select(v.greaterThan(1), ground, mix(mix(ground, sky, above), street, sample.a.mul(step(0, v))));
  const c0 = select(uStripsOn.greaterThan(0.5), strip, made);
  // On Ultra, near the middle of the view: the real street (probe.ts).
  // (The last two finished cubes, faded from the older to the newer: probe.ts.)
  const now: N = cubeTexture(PROBE_MAP.value as never, r), prev: N = cubeTexture(PROBE_PREV.value as never, r);
  probeNodes.push([now, prev]);
  const m: N = mix(prev, now, uProbeMix);
  const w = smoothstep(uProbeNear.y, uProbeNear.x, distance(positionWorld.xz, uProbeAt.xz)).oneMinus().mul(step(0.5, uProbeAt.w));
  const c = mix(c0, m.rgb.mul(uProbeK), m.a.mul(w));
  return c.add(uSunLight.mul(pow(max(dot(r, uSunDir), 0), R.sharp)).mul(R.glint));
};
const carCoat = (c: N): N => {
  const lamp = lampLight(positionWorld, normalView);
  const glass = select(luma(c).lessThan(0.04).and(c.z.greaterThan(c.x.mul(1.25))), float(CAR_GLOSS.glass), float(1));
  const coat = mix(CAR_GLOSS.dry, 1, uWet).mul(glass).mul(carTop());
  const slant = max(dot(normalView, positionViewDirection), 0).oneMinus();
  const s4 = slant.mul(slant).mul(slant).mul(slant);
  const rim = s4.mul(mix(CAR_GLOSS.rim[0], CAR_GLOSS.rim[1], uWet)).mul(glass);
  const tint = uSkyRef.mul(CAR_GLOSS.sky).mul(coat).add(uSkyRef.mul(CAR_GLOSS.rimSky).mul(rim));
  const r = cameraWorldMatrix.mul(vec4(reflect(positionViewDirection.negate(), normalView), 0)).xyz;
  const mirrored = carStreet(r).mul(s4.mul(R.side).add(R.top)).mul(glass).mul(mix(1, R.wet, uWet));
  return mix(tint, mirrored, uMirror).add(lamp.mul(coat.mul(CAR_GLOSS.lamps).add(rim.mul(CAR_GLOSS.rimLamps))));
};

addPort(/^cars$/, (node) => {
  const proto = Object.getPrototypeOf(node);
  // (Before the instance's own transform goes on, in setupPosition.)
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    const d = dentAt(), bent = dented(positionLocal, d), normal = dentNormal(normalLocal, positionGeometry, d);
    const p = swing(bent.xz.sub(hinge.xy)).add(hinge.xy), n = swing(normal.xz);
    positionLocal.assign(vec3(p.x, bent.y, p.y));
    normalLocal.assign(vec3(n.x, normal.y, n.y));
    return proto.setupPosition.call(this, builder);
  };
  node.vertexColors = false; // the colour node is the vertex colour, painted
  node.colorNode = vec4(vec3(materialColor).mul(tinted), 1);
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    const crazed = mix(mix(diffuseColor.rgb, vec3(0.6), DS.milk), vec3(...DS.crack), cracks(crackAt.xy));
    diffuseColor.rgb.assign(mix(diffuseColor.rgb, crazed, crackAt.z));
    diffuseColor.rgb.assign(select(shine.lessThan(-0.5), vec3(0.05, 0.05, 0.055), diffuseColor.rgb));
    const up = dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const cover = smoothstep(0.75, 0.95, up).mul(smoothstep(0.1, 0.6, uSnow)).mul(0.6);
    diffuseColor.assign(vec4(mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.86), cover), diffuseColor.a));
    diffuseColor.rgb.mulAssign(mix(1, CAR_GLOSS.darker, uWet.mul(carTop())));
  };
  glow(node, () => Fn(() => carCoat(diffuseColor.rgb))());
  glow(node, () => select(lamp.lessThan(0.5), vec3(0), tinted).mul(max(shine, 0)).mul(LAMP_GLOW));
  lampLit(node);
});

// The windows (the dark band of blue-ish vertex colour) are lit from inside.
const windows = () => {
  const c = vertexColor().rgb;
  const dark = luma(c).lessThan(0.03).and(c.z.greaterThan(c.x));
  return select(dark, vec3(1, 0.88, 0.7).mul(0.5).mul(uLampOn), vec3(0));
};
for (const name of [/^trams$/, /^funicular$/]) {
  addPort(name, (node) => {
    glow(node, windows);
    lampLit(node);
  });
}

// Cabin windows lit, and the navigation lights (glow 2) in their own colour.
addPort(/^boats$/, (node) => {
  glow(node, () => {
    const g: N = attribute('glow', 'float');
    const c = vertexColor().rgb;
    const lit = select(g.greaterThan(1.5), c.mul(1.6), vec3(1, 0.86, 0.62).mul(0.6));
    return select(g.greaterThan(0.5), lit.mul(uLampOn), vec3(0));
  });
  lampLit(node);
});
