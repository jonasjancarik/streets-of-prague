// The cars, trams, funicular and boats in TSL (the onBeforeCompile of their module-level
// materials in car.ts, trams.ts, funicular.ts and boats.ts): snow on the cars' roofs, lit
// windows and navigation lights at night, and the lamps' light. Registered as ports of
// the 'cars', 'trams', 'funicular' and 'boats' materials (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fn, float, vec2, vec3, vec4, attribute, vertexColor, normalView, cameraViewMatrix, diffuseColor, positionLocal, positionWorld, positionViewDirection, normalLocal, dot, smoothstep, mix, select, sin, cos, max, floor, mod, exp2 } from 'three/tsl';
import { LAMP_GLOW, CAR_GLOSS } from '../car.ts';
import { SKY_REF } from '../shading.ts';
import { lampLit, lampLight, uLampOn } from './lamps.ts';
import { shareInstances } from './trees.ts';
import { type N, addPort, uSnow, uWet, followColor } from './common.ts';

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
const lamp: N = floor(painted.mul(0.5).add(0.01));
const tail: N = mod(floor(paint.w.div(32)), 4);
const smashed: N = mod(floor(paint.w.div(exp2(lamp.sub(1)))), 2).greaterThan(0.5);
const shine: N = select(lamp.lessThan(0.5), float(0), select(smashed, float(-1),
  select(lamp.lessThan(2.5), mod(floor(paint.w.div(16)), 2), select(tail.greaterThan(1.5), float(1.5), tail.mul(0.45))))).toVarying('vLit');

// The gloss (CAR_GLOSS in car.ts): the sky and the lamps' light mirrored by what faces up, and
// more of it by what's seen at a slant; more when wet.
const uSkyRef: N = followColor(SKY_REF);
const carTop = (): N => smoothstep(0.35, 0.9, dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz));
const carCoat = (c: N): N => {
  const lamp = lampLight(positionWorld, normalView);
  const glass = select(luma(c).lessThan(0.04).and(c.z.greaterThan(c.x.mul(1.25))), float(CAR_GLOSS.glass), float(1));
  const coat = mix(CAR_GLOSS.dry, 1, uWet).mul(glass).mul(carTop());
  const slant = max(dot(normalView, positionViewDirection), 0).oneMinus();
  const rim = slant.mul(slant).mul(slant).mul(slant).mul(mix(CAR_GLOSS.rim[0], CAR_GLOSS.rim[1], uWet)).mul(glass);
  return uSkyRef.mul(CAR_GLOSS.sky).add(lamp.mul(CAR_GLOSS.lamps)).mul(coat).add(uSkyRef.mul(CAR_GLOSS.rimSky).add(lamp.mul(CAR_GLOSS.rimLamps)).mul(rim));
};

addPort(/^cars$/, (node) => {
  const proto = Object.getPrototypeOf(node);
  // (Before the instance's own transform goes on, in setupPosition.)
  node.setupPosition = function (builder: N) {
    shareInstances(builder);
    const p = swing(positionLocal.xz.sub(hinge.xy)).add(hinge.xy), n = swing(normalLocal.xz);
    positionLocal.assign(vec3(p.x, positionLocal.y, p.y));
    normalLocal.assign(vec3(n.x, normalLocal.y, n.y));
    return proto.setupPosition.call(this, builder);
  };
  node.setupDiffuseColor = function (builder: N) {
    proto.setupDiffuseColor.call(this, builder);
    diffuseColor.rgb.mulAssign(mix(vec3(1), paint.rgb, painted.sub(lamp.mul(2))));
    diffuseColor.rgb.assign(select(shine.lessThan(-0.5), vec3(0.05, 0.05, 0.055), diffuseColor.rgb));
    const up = dot(normalView, cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    const cover = smoothstep(0.75, 0.95, up).mul(smoothstep(0.1, 0.6, uSnow)).mul(0.6);
    diffuseColor.assign(vec4(mix(diffuseColor.rgb, vec3(0.8, 0.82, 0.86), cover), diffuseColor.a));
    diffuseColor.rgb.mulAssign(mix(1, CAR_GLOSS.darker, uWet.mul(carTop())));
  };
  glow(node, () => Fn(() => carCoat(diffuseColor.rgb))());
  glow(node, () => select(lamp.lessThan(0.5), vec3(0), vertexColor().rgb).mul(max(shine, 0)).mul(LAMP_GLOW));
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
