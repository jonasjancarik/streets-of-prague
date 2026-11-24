// The cars, trams, funicular and boats in TSL (the onBeforeCompile of their module-level
// materials in car.ts, trams.ts, funicular.ts and boats.ts): snow on the cars' roofs, lit
// windows and navigation lights at night, and the lamps' light. Registered as ports of
// the 'cars', 'trams', 'funicular' and 'boats' materials (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fn, If, float, vec2, vec3, vec4, attribute, vertexColor, normalView, cameraViewMatrix, cameraWorldMatrix, diffuseColor, renderGroup, positionLocal, positionWorld, positionViewDirection, normalLocal, positionGeometry, materialColor, materialSpecular, normalize, dot, smoothstep, mix, select, sin, min, cos, max, floor, mod, exp2, reflect, atan, pow, uniform, texture, cubeTexture, length, clamp, step, distance, cross } from 'three/tsl';
import { LAMP_GLOW, CAR_GLOSS, DUSTCART_COAT, CAR_MIRROR, CAR_STREET, WHEEL_LEVEL, CAR_REFLECT as R, CAR_STRIPS as CS, AREA_STEP, DENT_STEP, DENT_SHAPE as DS } from '../car.ts';
import { ROLL_CENTRE } from '../streetHandling.ts';
import { sedanInstruments, sedanWeave } from '../sedanFinish.ts';
import { registrationAtlas } from '../registrationPlates.ts';
import { STRIPS, STRIPS_ON, onStrips } from '../reflections.ts';
import { PROBE_AT, PROBE_K, PROBE_MAP, PROBE_MIX, PROBE_NEAR, PROBE_PREV, onProbe } from '../probe.ts';
import { SKY_REF, STREET_REF, SUN_DIR, SUN_LIGHT } from '../shading.ts';
import { lampLit, lampLight, uLampOn } from './lamps.ts';
import { shareInstances } from './trees.ts';
import { skyAt } from './dome.ts';
import { type N, addPort, uSnow, uWet, follow, followColor, followVec } from './common.ts';

const wheelLevel = followVec(WHEEL_LEVEL);
const levelWheel = (p: N) => p.add(cross(wheelLevel.xyz, cross(wheelLevel.xyz, p).add(p.mul(wheelLevel.w))).mul(2));

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
const swing = (p: N, close = false): N => {
  const angle = close ? select(hinge.z.greaterThan(4.5), float(0), opened) : opened;
  const c = cos(angle), s = sin(angle);
  return vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)));
};

// A lamp is dark when it's smashed and glows when it's on. Which of the car's four a
// vertex is part of is packed into `painted`, and the car's lamps into `paint.w` (see
// LAMP in car.ts): -1 here for a smashed one, 0 off, or how bright.
const painted: N = attribute('painted', 'float'), paint: N = attribute('paint', 'vec4');
const own: N = mod(floor(painted), 16), lampAt: N = floor(own.mul(0.5).add(0.01));
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
const uMirror: N = follow(CAR_MIRROR), uStreetView: N = follow(CAR_STREET);
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
const PROBE_SOFT = 0.045; // how far apart the cube is read for one pixel of paint (radians)
const stripNodes: N[] = [];
onStrips((t) => { for (const n of stripNodes) n.value = t; });
// (`soft`: how many mip levels down the strip is read, for paint that isn't a mirror.)
const carStreet = (r: N, neighbourhood: N = area, soft?: N): N => {
  const a = atan(r.z, r.x);
  const edge = float(R.edge).add(sin(a.mul(5)).mul(0.55).add(sin(a.mul(13).add(1.7)).mul(0.3)).add(sin(a.mul(31).add(0.4)).mul(0.15)).mul(R.ragged));
  const sky = uSkyRef.mul(mix(R.horizon, R.zenith, smoothstep(0.1, 0.9, r.y)));
  const walls = uStreetRef.mul(mix(0.75, 1.05, smoothstep(-0.02, edge, r.y)));
  const ground: N = uStreetRef.mul(0.5), above: N = smoothstep(-0.06, 0, r.y);
  const made = mix(ground, mix(walls, sky, smoothstep(edge.sub(0.015), edge.add(0.015), r.y)), above);
  // The strip of the car's kind of area, where the strips are in.
  const v: N = float(CS.stripHorizon).mul(r.y.div(max(length(r.xz), 0.001)).div(CS.stripTop).oneMinus());
  const at = vec2(a.div(6.2832).add(0.5), float(1).sub(neighbourhood.add(clamp(v, 0.01, 0.99)).div(CS.kinds)));
  const sample: N = soft ? texture(STRIPS.value, at).bias(soft) : texture(STRIPS.value, at);
  stripNodes.push(sample);
  const street = sample.rgb.mul(luma(uStreetRef)).mul(CS.stripGain);
  const strip = select(v.greaterThan(1), ground, mix(mix(ground, sky, above), street, sample.a.mul(step(0, v))));
  const c0 = select(uStripsOn.greaterThan(0.5), strip, made);
  // On Ultra, near the middle of the view: the real street (probe.ts).
  // (The last two finished cubes, faded from the older to the newer: probe.ts.)
  // Paint is not a mirror: four looks a couple of degrees apart, so the cube's texels and the
  // houses' windows don't show as hard blocks on a bonnet seen from the pavement.
  const side: N = normalize(cross(r, vec3(0.31, 0.9, 0.3))).mul(PROBE_SOFT), up: N = normalize(cross(r, side)).mul(PROBE_SOFT);
  let m: N = vec4(0);
  for (const o of [side.add(up.mul(0.4)), side.negate().sub(up.mul(0.4)), up.sub(side.mul(0.4)), up.negate().add(side.mul(0.4))]) {
    const now: N = cubeTexture(PROBE_MAP.value as never, r.add(o)), prev: N = cubeTexture(PROBE_PREV.value as never, r.add(o));
    probeNodes.push([now, prev]);
    m = m.add(mix(prev, now, uProbeMix).mul(0.25));
  }
  const w = smoothstep(uProbeNear.y, uProbeNear.x, distance(positionWorld.xz, uProbeAt.xz)).oneMinus().mul(step(0.5, uProbeAt.w));
  const c = mix(c0, m.rgb.mul(uProbeK), m.a.mul(w));
  return c.add(uSunLight.mul(pow(max(dot(r, uSunDir), 0), R.sharp)).mul(R.glint));
};
const carCoat = (c: N): N => {
  const lamp = lampLight(positionWorld, normalView);
  // (At street level less of the street, and out of focus: CAR_STREET in car.ts.)
  const glass = select(luma(c).lessThan(0.04).and(c.z.greaterThan(c.x.mul(1.25))), mix(CAR_GLOSS.glass, R.street.glass, uStreetView), float(1));
  const coat = mix(CAR_GLOSS.dry, 1, uWet).mul(glass).mul(carTop());
  const slant = max(dot(normalView, positionViewDirection), 0).oneMinus();
  const s4 = slant.mul(slant).mul(slant).mul(slant);
  const rim = s4.mul(mix(CAR_GLOSS.rim[0], CAR_GLOSS.rim[1], uWet)).mul(glass);
  const tint = uSkyRef.mul(CAR_GLOSS.sky).mul(coat).add(uSkyRef.mul(CAR_GLOSS.rimSky).mul(rim));
  const r = cameraWorldMatrix.mul(vec4(reflect(positionViewDirection.negate(), normalView), 0)).xyz;
  const mirrored = carStreet(r, area, uStreetView.mul(R.street.soft)).mul(s4.mul(mix(R.side, R.street.side, uStreetView)).add(mix(R.top, R.street.top, uStreetView))).mul(glass).mul(mix(1, R.wet, uWet));
  return mix(tint, mirrored, uMirror).add(lamp.mul(coat.mul(CAR_GLOSS.lamps).add(rim.mul(CAR_GLOSS.rimLamps))));
};

addPort(/^cars(?:-service|-dustcart|-close|-coachglass|-coachwork)?$/, (node, legacy) => {
  // On the detailed ambulance, dark rubber and interior trim have a satin
  // finish. Vinyl is printed onto white vertices and retains the paint gloss.
  const key = legacy.customProgramCacheKey();
  const serviceBody = key === 'cars-service';
  const hero = key === 'cars-coachwork';
  const closeCar = key === 'cars-close' || hero;
  const colour = vertexColor().rgb, brightness = luma(colour);
  const glazed = brightness.lessThan(.04).and(colour.b.greaterThan(colour.r.mul(1.25)));
  const trimFinish = select(own.equal(0).and(glazed.not()), mix(.08,1,smoothstep(.035,.17,brightness)), float(1));
  const wheelFinish = closeCar ? select(hinge.z.lessThan(0),
    mix(.045,.45,smoothstep(.045,.24,brightness)), select(hinge.z.greaterThan(11.5),float(.065),trimFinish)).toVarying('vWheelCoat') : undefined;
  const code = hero ? select(hinge.z.lessThan(0), select(brightness.greaterThan(.068), 2, 4), painted.fract().mul(16).round()).toVarying('vFinish') : undefined;
  if (code) {
    const enamel = code.equal(1), metal = code.equal(2), fabric = code.equal(3), optic = code.equal(5);
    node.roughnessNode = select(enamel, mix(.34, .23, uWet), select(metal, .28, select(fabric, .91, select(optic, .20, .68))));
    node.metalnessNode = select(enamel, .28, select(metal, .72, .015));
    node.clearcoatNode = select(enamel, .86, select(optic, .38, 0));
    node.clearcoatRoughnessNode = mix(.18, .12, uWet);
  } else if (wheelFinish) node.specularNode = materialSpecular.mul(wheelFinish);
  const rollWheel = (p: N): N => {
    const roll: N = attribute('roll', 'vec4');
    const phase = hero ? normalize(roll.xy) : roll.xy;
    const fixed = hinge.z.lessThan(-1);
    const x = select(fixed, p.x, phase.x.mul(p.x).sub(phase.y.mul(p.y))), y = select(fixed, p.y, phase.y.mul(p.x).add(phase.x.mul(p.y)));
    const steer: N = roll.z.sub(floor(roll.z.add(1).mul(.5)).mul(2));
    const c: N = max(float(1).sub(steer.mul(steer)), 0).sqrt();
    return select(hinge.x.greaterThan(0), vec3(c.mul(x).add(steer.mul(p.z)), y, c.mul(p.z).sub(steer.mul(x))), vec3(x,y,p.z));
  };
  const proto = Object.getPrototypeOf(node);
  // (Before the instance's own transform goes on, in setupPosition.)
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    let pos: N = positionLocal, nrm: N = normalLocal;
    if (closeCar) {
      const axle = vec3(hinge.x, hinge.z.negate().sub(select(hinge.z.lessThan(-1), 2, 0)), hinge.y), wheel = hinge.z.lessThan(0);
      let spun: N = axle.add(rollWheel(pos.sub(axle)));
      const twist: N = floor(attribute('roll','vec4').z.add(1).mul(.5)).mul(.0025).mul(hinge.x.mul(hinge.y).negate().sign());
      if (hero) {
        const contact = max(0, spun.y.sub(float(1).sub(smoothstep(0,.045,spun.y)).mul(.010)));
        const wheelHeight: N = select(hinge.z.greaterThan(-1), contact, spun.y);
        spun = vec3(spun.x, wheelHeight, spun.z);
      }
      const wheelPos = spun.add(vec3(0, twist, 0)).toVar(), wheelNormal = rollWheel(nrm).toVar();
      If(wheel.and(attribute('roll', 'vec4').w.lessThan(0)), () => {
        const pivot = vec3(0, ROLL_CENTRE, 0);
        wheelPos.assign(levelWheel(wheelPos.sub(pivot)).add(pivot));
        wheelNormal.assign(levelWheel(wheelNormal));
      });
      pos = select(wheel, wheelPos, pos);
      nrm = select(wheel, wheelNormal, nrm);
    }
    const d = dentAt(), bent = dented(pos, d), normal = dentNormal(nrm, positionGeometry, d);
    const p = swing(bent.xz.sub(hinge.xy), closeCar).add(hinge.xy), n = swing(normal.xz, closeCar);
    positionLocal.assign(vec3(p.x, bent.y, p.y));
    normalLocal.assign(vec3(n.x, normal.y, n.y));
    return proto.setupPosition.call(this, builder);
  };
  node.vertexColors = false; // the colour node is the vertex colour, painted
  node.colorNode = vec4(vec3(materialColor).mul(tinted), 1);
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    if (closeCar) {
      const slot = hinge.z.sub(5), roll = attribute('roll','vec4');
      const digit = select(slot.equal(1), float(10), mod(floor(roll.w.abs().div(pow(10,clamp(float(6).sub(slot),0,5)))),10));
      const atlasUV = select(hinge.z.greaterThan(4.5).and(hinge.z.lessThan(11.5)),vec2(digit.add(hinge.x.mul(.96)).add(.02).div(16),hinge.y.mul(.96).add(.02)),vec2(-1)).toVarying('vPlateUV');
      If(atlasUV.x.greaterThanEqual(0), () => { diffuseColor.rgb.mulAssign(texture(registrationAtlas(),atlasUV).rgb); });
    }
    if (hero) {
      const dial = hinge.toVarying('vDial'), engine = length(attribute('roll', 'vec4').xy).toVarying('vEngine');
      If(dial.z.greaterThan(13.5).and(dial.z.lessThan(15.5)), () => {
        const art = texture(sedanInstruments(), dial.xy).rgb.toVar();
        If(dial.z.lessThan(14.5), () => {
          const p = vec2(dial.x.mul(512).sub(256), float(1).sub(dial.y).mul(256).sub(78));
          const angle = clamp(engine.sub(2), 0, 1).mul(268).add(136).mul(Math.PI / 180), d = vec2(cos(angle), sin(angle));
          const needle = float(1).sub(smoothstep(.7, 2, length(p.sub(d.mul(clamp(dot(p, d), 3, 51))))));
          art.assign(mix(art, vec3(.71, .16, .063), needle));
        }).Else(() => { art.assign(mix(vec3(.014, .021, .025), art, step(1.5, engine))); });
        diffuseColor.rgb.mulAssign(art);
      }).ElseIf(dial.z.greaterThan(15.5).and(dial.z.lessThan(16.5)), () => {
        diffuseColor.rgb.mulAssign(texture(sedanWeave(), dial.xy).r.mul(1.32).add(.35));
      });
    }
    const crazed = mix(mix(diffuseColor.rgb, vec3(0.6), DS.milk), vec3(...DS.crack), cracks(crackAt.xy));
    diffuseColor.rgb.assign(mix(diffuseColor.rgb, crazed, crackAt.z));
    diffuseColor.rgb.assign(select(shine.lessThan(-0.5), vec3(0.05, 0.05, 0.055), diffuseColor.rgb));
    const up = dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const cover = smoothstep(0.75, 0.95, up).mul(smoothstep(0.1, 0.6, uSnow)).mul(0.6);
    diffuseColor.assign(vec4(mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.86), cover), diffuseColor.a));
    diffuseColor.rgb.mulAssign(mix(1, CAR_GLOSS.darker, uWet.mul(carTop())));
    if (key === 'cars-coachglass') {
      const grazing = float(1).sub(dot(normalView, positionViewDirection).abs()).pow(3);
      const tint = painted.fract().mul(16).round().toVarying('vGlassFinish');
      const cover = step(7.5, tint), rear = tint.equal(7);
      const base = float(.39).add(smoothstep(1.22, 1.41, positionGeometry.y).mul(.15)).add(select(rear, .18, 0));
      diffuseColor.a.assign(mix(base, .085, cover).add(grazing.mul(mix(.32, .26, cover))));
    }
  };
  glow(node, () => Fn(() => {
    const coat = carCoat(diffuseColor.rgb).toVar();
    if (hero || key === 'cars-coachglass') {
      // Beyond the reflected skyline, the lacquer and glass see the same moving
      // cloud field as the street. On Ultra the nearby live probe takes priority.
      const ray = cameraWorldMatrix.mul(vec4(reflect(positionViewDirection.negate(), normalView), 0)).xyz;
      const skyWeight: N = smoothstep(.26, .67, ray.y).mul(uMirror).mul(float(1).sub(step(.5, uProbeAt.w)));
      const surface: N = code ? code.equal(1) : float(1).greaterThan(0);
      If(surface.and(skyWeight.greaterThan(.01)), () => {
        const rim = float(1).sub(dot(normalView, positionViewDirection).abs()).clamp(0, 1).pow(4);
        const reflectance = hero ? rim.mul(.60).add(.075) : rim.mul(.52).add(.36);
        const atmosphere = skyAt(ray, positionWorld.xz).rgb.min(vec3(4));
        coat.assign(mix(coat, atmosphere.mul(reflectance), skyWeight));
      });
    }
    if (wheelFinish && code) return coat.mul(select(code.equal(3), .018, select(code.equal(4), .065, select(code.equal(6), .085, wheelFinish))));
    if (wheelFinish) return coat.mul(wheelFinish);
    if (key === 'cars-dustcart') {
      const cabGlass = luma(tinted).lessThan(0.04).and(tinted.b.greaterThan(tinted.r.mul(1.25)));
      return coat.mul(select(cabGlass, float(1), mix(DUSTCART_COAT.dry, DUSTCART_COAT.wet, uWet)));
    }
    return serviceBody ? coat.mul(mix(0.035, 1, smoothstep(0.035, 0.22, luma(vertexColor().rgb)))) : coat;
  })());
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

addPort(/^tram-glass$/, (node) => {
  const graze = float(1).sub(dot(normalView, positionViewDirection).abs()).clamp(0, 1).pow(2);
  node.opacityNode = graze.mul(0.43).add(0.23);
  const ray = cameraWorldMatrix.mul(vec4(reflect(positionViewDirection.negate(), normalView), 0)).xyz;
  glow(node, () => carStreet(ray, float(1)).mul(graze.mul(1.1).add(0.74)));
});

// Interior light falls on the fitted seats and handrails. Glass stays transparent;
// only lamp lenses and ceiling fixtures receive the stronger light.
addPort(/^street-tram$/, (node) => {
  const amount = attribute('streetGlow','float');
  glow(node, () => vertexColor().rgb.mul(amount.mul(uLampOn).add(max(0,amount.sub(1.5)).mul(.12))));
  lampLit(node);
});

// Cabin windows lit, and the navigation lights (glow 2) in their own colour.
addPort(/^boats$/, (node) => {
  glow(node, () => {
    const g: N = attribute('glow', 'float');
    const c = vertexColor().rgb;
    const lit = select(g.greaterThan(1.5), c.mul(1.6), vec3(1, 0.86, 0.62).mul(g.mul(0.6)));
    return lit.mul(uLampOn);
  });
  lampLit(node);
});
