// The small effects that are written in GLSL outright (ShaderMaterial), in TSL: the lamps'
// and traffic lights' glows (lamps.ts, signals.ts), the spray behind cars in the rain
// (spray.ts), the flames and smoke of burning cars and the sparks of crashes (particles.ts) and the tyre marks (skids.ts).
// Each one is made through a hook in its own file (as `setSoftShade` is in surface.ts).
// The signals' poles and heads have the lamps' light too (a port of their Lambert materials).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Loop, abs, Discard, float, vec2, vec3, vec4, uv, texture, instanceIndex, attribute, uniform, renderGroup, instanceColor, positionGeometry, positionView, positionViewDirection, normalView, cameraViewMatrix,
  cameraProjectionMatrix, cameraPosition, positionWorld, transformNormalToView, normalize, cross, distance, smoothstep, step, mix, min, max, clamp, dot, sqrt, pow, fract, sin, cos, length, select, sRGBTransferEOTF, toneMappingExposure,
} from 'three/tsl';
import { setGlows } from '../lamps.ts';
import { pedestrianLens } from '../signalOptics.ts';
import { setSignalGlow, setSignalFlare } from '../signals.ts';
import { setBeamShade, setGlintShade, BEAM_ON } from '../lightfx.ts';
import { setSprayDrawing } from '../spray.ts';
import { setSmokeDrawing } from '../chimneySmoke.ts';
import { setSpriteShade } from '../particles.ts';
import { setSkidShade } from '../skids.ts';
import { setStreakShade, STREAK_GAIN, STREAK_TIME } from '../streaks.ts';
import { lampLit, uLampOn } from './lamps.ts';
import { ungrade } from './grade.ts';
import { OLD_GRADE } from '../grade.ts';
import { SKY_REF } from '../shading.ts';
import { type N, addPort, follow, followVec, followColor, uWet, uRain, vnoise, fbm2 } from './common.ts';

addPort(/^pedestrian-lenses$/, node => {
  const tile = instanceIndex.mod(2).toFloat().toVarying('vPedestrianTile');
  node.colorNode = texture(pedestrianLens(), vec2(uv().x.add(tile).mul(.5),uv().y));
});

addPort(/^signal-(pole|head)$/, (node) => { lampLit(node); });

// These shaders write a colour as it is, after the tone curve (they include neither tonemapping_fragment
// nor colorspace_fragment), so it is the colour on the screen. Here the curve and the conversion to sRGB
// come after the blending, on the whole frame: this gives the colour that comes out as the given one
// (`v`, sRGB numbers) once the curve has run, by undoing the curve in ../webgpu.ts step by step (the
// shadows lifted, the S-curve by Newton's method, the greying, the extended Reinhard, the exposure).
// `add`: a glow, only added on top of what is there: its colour is not run back through the curve (that
// bleached the flames to green and white); it is made linear and scaled by eye (GG) so that it reads like the GLSL's.
const lift = vec3(0.016, 0.012, 0.006);
// How strong an added glow is in the linear frame (tuned by eye against the GLSL's; the curve compresses increments).
const GG = 5;
const unmap = (v: N, add = false): N => Fn(() => {
  const e: N = toneMappingExposure;
  const lin: N = add ? (sRGBTransferEOTF(clamp(vec3(v), 0, 1)) as N).mul(GG) : sRGBTransferEOTF(clamp(vec3(v), 0, 1));
  if (add) return lin;
  if (!OLD_GRADE) return ungrade(lin);
  const s: N = clamp(lin.sub(lift).div(lift.oneMinus()), 0, 0.9995).toVar();
  const d: N = s.toVar();
  for (let i = 0; i < 4; i++) {
    const f = d.mul(0.65).add(d.mul(d).mul(d.mul(-2).add(3)).mul(0.35)).sub(s);
    d.assign(d.sub(f.div(d.mul(d.oneMinus()).mul(2.1).add(0.65))));
  }
  const luma = dot(d, vec3(0.2126, 0.7152, 0.0722));
  const r = max(d.sub(luma.mul(0.12)).div(0.88), 0);
  const q = r.oneMinus();
  const c = q.negate().add(sqrt(q.mul(q).add(r.div(9)))).mul(18);
  // (A negative exposure means the curve is off: the colour is only scaled.)
  return select(e.lessThan(0), lin.div(max(e.negate(), 0.001)), c.div(max(e, 0.001)));
})();

// GLSL's smoothstep(hi, lo, x) (edges the wrong way round), which WGSL doesn't take.
const smoothDown = (hi: number, lo: number, x: N) => smoothstep(lo, hi, x).oneMinus();

function additive(fragment: () => N, side: THREE.Side = THREE.FrontSide) {
  const m = new NodeMaterial();
  m.fragmentNode = Fn(fragment)();
  m.blending = THREE.AdditiveBlending;
  Object.assign(m, { side, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  return m;
}

// ---- Glows of lamp heads and of the cars' and trams' lights (lamps.ts) ----

setGlows(() => additive(() => {
  const d = length(uv().mul(2).sub(1));
  const f = smoothDown(1, 0, d);
  const g = f.mul(f).mul(0.5).add(smoothDown(0.16, 0.08, d));
  return vec4(unmap(instanceColor.mul(g).mul(uLampOn), true), 1);
}));

// ---- The lights' cones in the air and their glints (lightfx.ts) ----
// A cone is brightest where you look through the most of it: along its middle, fading to
// nothing at its outline, and thinning out along its length.

setBeamShade((search = false) => {
  const strength = follow(BEAM_ON);
  if (search) {
    const eye: N = attribute('iBeamEye', 'vec3').toVarying('vBeamEye');
    const size: N = attribute('iBeamSize', 'vec3').toVarying('vBeamSize');
    return additive(() => {
      // Integrate soft light through the air, rather than lighting the cone's skin.
      // Coordinates are in the unit cone; size restores metres for the optical depth.
      const delta = positionGeometry.sub(eye), distance = length(delta);
      const ray = delta.div(max(distance, 0.0001));
      const inverse = vec3(1).div(step(0, ray).mul(2).sub(1).mul(max(abs(ray), vec3(0.00001))));
      const a = vec3(0, -1, -1).sub(eye).mul(inverse);
      const b = vec3(1, 1, 1).sub(eye).mul(inverse);
      const near = min(a, b);
      const enter = max(0, max(near.x, max(near.y, near.z)));
      const stride = max(distance.sub(enter), 0).div(12);
      const optical = float(0).toVar();
      Loop(12, ({ i }) => {
        const p = eye.add(ray.mul(enter.add(float(i).add(0.5).mul(stride))));
        const radius = p.x.mul(0.98).add(0.02);
        const radial = length(p.yz).div(max(radius, 0.02));
        const density = smoothDown(1, 0.15, radial).pow(2)
          .mul(smoothstep(0, 0.025, p.x)).mul(smoothDown(1.02, 0.92, p.x))
          .div(p.x.mul(p.x).mul(3).add(1));
        optical.addAssign(density.mul(stride).mul(length(ray.mul(size))));
      });
      const glow = optical.mul(0.065).clamp(0, 0.65).mul(strength);
      return vec4(unmap(instanceColor.mul(glow), true), 1);
    }, THREE.BackSide);
  }
  // (Along the whole cone, of which a car in the way leaves only the first part drawn: lightfx.ts.)
  const t: N = positionGeometry.x.mul(attribute('iCut', 'float')).toVarying('vBeamT');
  const m = additive(() => {
    const through = dot(normalView, positionViewDirection).abs();
    const a = t.oneMinus().pow(1.6).mul(smoothstep(0, 0.07, t)).mul(through.pow(1.5)).mul(strength).mul(0.5);
    return vec4(unmap(instanceColor.mul(a), true), 1);
  });
  m.side = THREE.DoubleSide;
  return m;
});

// A glint: a small bright core in a soft patch, lying flat (stretched by its instance).
setGlintShade(() => {
  const m = additive(() => {
    const d = length(uv().mul(2).sub(1));
    const f = smoothDown(1, 0, d);
    const g = f.mul(f).mul(0.45).add(smoothDown(0.45, 0.1, d).mul(0.55));
    return vec4(unmap(instanceColor.mul(g).mul(uLampOn), true), 1);
  });
  Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -12 });
  return m;
});

// ---- Glows round the traffic lights that are lit (signals.ts) ----

setSignalGlow(() => additive(() => {
  const d = length(uv().mul(2).sub(1)), f = smoothDown(1, 0, d);
  const g = f.mul(f).mul(uLampOn.mul(0.5).add(0.9)).add(smoothDown(0.3, 0.2, d).mul(0.9));
  return vec4(unmap(instanceColor.mul(g), true), 1);
}));
// A car light's flare (signals.ts): brightest at the head, widening and fading as it slopes down to the road.
setSignalFlare(() => additive(() => {
  const along = uv().y.oneMinus(), x = uv().x.sub(0.5).mul(2);
  const fan = pow(along.oneMinus(), 1.5).mul(smoothDown(1, 0.55, abs(x).div(along.mul(0.7).add(0.3))));
  const core = smoothDown(1, 0.3, length(vec2(x.div(0.4), along.sub(0.06).div(0.13))));
  return vec4(unmap(instanceColor.mul(fan.mul(uLampOn.mul(0.4).add(0.9)).add(core)), true), 1);
}, THREE.DoubleSide));

// ---- The lights' streaks in the wet streets (streaks.ts) ----

const uStreakTime = follow(STREAK_TIME);
setStreakShade(() => additive(() => {
  const along = uv().y.oneMinus(), x = uv().x.sub(0.5).mul(2);
  const f = select(along.lessThan(0.25), along.div(0.25), along.oneMinus().div(0.75));
  const across = x.mul(x).oneMinus();
  const p = vec2(positionWorld.x, positionWorld.z.negate());
  const puddle = smoothstep(0.66, 0.71, fbm2(p.mul(0.3).add(31)).mul(0.75).add(fbm2(p.mul(0.04).add(7)).mul(0.35)));
  const flicker = float(1).sub(uRain.mul(0.5).mul(vnoise(vec2(along.mul(9).add(x.mul(2)), uStreakTime.mul(4)))));
  const a = f.mul(f).mul(across).mul(across).mul(uWet).mul(uLampOn).mul(puddle.mul(0.75).add(0.25)).mul(flicker).mul(STREAK_GAIN);
  return vec4(unmap(instanceColor.mul(a), true), 1);
}));

// ---- The scene's fog, for colours on the screen (the spray, the tyre marks) ----

const fogs = new WeakMap<THREE.Scene, { near: N; far: N; color: N }>();
function fogOf(scene: THREE.Scene) {
  let f = fogs.get(scene);
  if (!f) {
    const at = (get: (fog: THREE.Fog) => number) => uniform(1e5).setGroup(renderGroup).onRenderUpdate(() => {
      const fog = scene.fog as THREE.Fog | null;
      return fog ? get(fog) : 1e5;
    });
    const color = uniform(new THREE.Color()).setGroup(renderGroup);
    color.onRenderUpdate(() => { if (scene.fog) color.value.copy(scene.fog.color); return color.value; });
    fogs.set(scene, f = { near: at((fog) => fog.near), far: at((fog) => fog.far), color });
  }
  return f;
}
// smoothstep(fogNear, fogFar, depth), which is 0 while the fog is off (near = far = 1e5).
function fogAt(scene: THREE.Scene, depth: N) {
  const { near, far } = fogOf(scene);
  const t = clamp(depth.sub(near).div(max(far.sub(near), 0.001)), 0, 1);
  return t.mul(t).mul(t.mul(-2).add(3));
}

// ---- Spray (spray.ts) ----
// Points are one pixel wide on WebGPU, so each drop is a quad instanced from the drops' own
// buffers, made as wide on the screen as the GLSL's gl_PointSize.

setSprayDrawing(({ from, born, vel, tint, scene, life, size, uNow, uScale }) => {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('start', from);
  g.setAttribute('born', born);
  g.setAttribute('vel', vel);
  g.instanceCount = born.count;

  const m = new NodeMaterial();
  const now = follow(uNow), scale = follow(uScale), tinted = followColor(tint);
  // The size of the picture in pixels.
  const screen = uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup);
  screen.onRenderUpdate(({ renderer }: N) => { renderer.getDrawingBufferSize(screen.value); return screen.value; });
  const t = now.sub(attribute('born', 'float')), k = t.div(life);
  const alive = t.greaterThanEqual(0).and(k.lessThan(1));
  const a = select(alive, k.oneMinus().mul(min(1, k.mul(8))), 0);
  const p = attribute('start', 'vec3').add(attribute('vel', 'vec3').mul(t)).add(vec3(0, t.mul(t).mul(-4.9), 0));
  const view = cameraViewMatrix.mul(vec4(p, 1)), clip = cameraProjectionMatrix.mul(view);
  const across = select(a.greaterThan(0), scale.mul(size).mul(k.add(0.6)).div(view.z.negate()), 0);
  const q = positionGeometry.xy;
  m.vertexNode = vec4(clip.xy.add(q.mul(across).div(screen).mul(clip.w)), clip.z, clip.w);
  const vA = a.toVarying('vA'), vQ = q.toVarying('vQ'), vDepth = view.z.negate().toVarying('vDepth');
  m.fragmentNode = Fn(() => {
    const alpha = vA.mul(smoothDown(1, 0.1, length(vQ))).mul(0.3);
    If(alpha.lessThan(0.004), () => { Discard(); });
    const colour: N = min(max(tinted.mul(1.1), vec3(0.26, 0.28, 0.3)), vec3(0.9));
    return vec4(unmap(mix(colour, fogOf(scene).color, fogAt(scene, vDepth))), alpha);
  })();
  Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
  return new THREE.Mesh(g, m);
});

// ---- The chimneys' smoke (chimneySmoke.ts) ----
// A quad for each puff, as the spray's drops; where it is and how it fades as in the GLSL.

setSmokeDrawing(({ scene, life, rise, uTime, uOn, uScale, uWind, tint }) => {
  const m = new NodeMaterial();
  const now = follow(uTime), on = follow(uOn), scale = follow(uScale), wind: N = followVec(uWind as any), tinted = followColor(tint);
  const screen = uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup);
  screen.onRenderUpdate(({ renderer }: N) => { renderer.getDrawingBufferSize(screen.value); return screen.value; });
  const puff: N = attribute('puff', 'vec2');
  const lasts = puff.x.mul(0.4).add(0.8).mul(life);
  const k: N = fract(now.div(lasts).add(puff.y)), t: N = k.mul(lasts);
  const gust: N = vec2(sin(now.mul(0.5).add(puff.x.mul(40)).add(k.mul(5))), cos(now.mul(0.4).add(puff.x.mul(23)).add(k.mul(4)))).mul(0.6).mul(k);
  const along: N = wind.xy.mul(t).mul(k.mul(0.65).add(0.35)).add(gust);
  const p = attribute('start', 'vec3').add(vec3(along.x, t.mul(rise).mul(k.mul(-0.45).add(1)), along.y));
  const wisp: N = fract(puff.y.mul(7.31));
  const a = on.mul(puff.x.mul(0.5).add(0.5)).mul(wisp.mul(0.75).add(0.25)).mul(smoothstep(0, 0.12, k)).mul(pow(k.oneMinus(), 1.5));
  const view: N = cameraViewMatrix.mul(vec4(p, 1)), clip: N = cameraProjectionMatrix.mul(view);
  const across: N = scale.mul(mix(0.6, 3.2, sqrt(k))).mul(wisp.mul(0.6).add(0.7)).div(view.z.negate());
  const q: N = positionGeometry.xy;
  m.vertexNode = vec4(clip.xy.add(q.mul(across).div(screen).mul(clip.w)), clip.z, clip.w);
  const vA = a.toVarying('vA'), vQ = q.toVarying('vQ'), vDepth = view.z.negate().toVarying('vDepth');
  m.fragmentNode = Fn(() => {
    const alpha = vA.mul(smoothDown(1, 0, length(vQ))).mul(0.15);
    If(alpha.lessThan(0.004), () => { Discard(); });
    const colour: N = min(max(tinted.mul(1.25), vec3(0.3, 0.32, 0.36)), vec3(0.96));
    return vec4(unmap(mix(colour, fogOf(scene).color, fogAt(scene, vDepth))), alpha);
  })();
  Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
  return m;
});

// ---- Flames, smoke, sparks and flying bits (particles.ts: fire.ts and debris.ts) ----
// A quad for each, worked out on the CPU: `at` where it is (and its radius; a negative one lies flat on
// the ground), `tint` its colour and fade, `motion` its turn and pattern (a spark: its velocity). Smoke
// and flames face the camera and are broken up by noise that moves as they age, so they read as puffs
// and tongues from the street as well as from above; a spark is drawn as a streak along its flight.

setSpriteShade(({ kind, scene, light }) => {
  const m = new NodeMaterial();
  const at: N = attribute('at', 'vec4'), tint: N = attribute('tint', 'vec4'), mv: N = attribute('motion', 'vec4');
  const q: N = positionGeometry.xy;
  const lit: N = clamp(followColor(light).mul(1.5), 0.12, 1.15);
  if (kind === 'spark') {
    const screen = uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup);
    screen.onRenderUpdate(({ renderer }: N) => { renderer.getDrawingBufferSize(screen.value); return screen.value; });
    // Head and tail on the screen; the streak between them, at least a pixel or so wide.
    const head: N = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(at.xyz, 1)));
    const tail0: N = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(at.xyz.sub(mv.xyz.mul(mv.w)), 1)));
    const tail: N = select(tail0.w.lessThan(0.05), head, tail0);
    const hs: N = head.xy.div(head.w).mul(screen), ts: N = tail.xy.div(tail.w).mul(screen);
    const d: N = hs.sub(ts), dl: N = length(d);
    const dir: N = select(dl.lessThan(0.001), vec2(1, 0), d.div(max(dl, 0.001)));
    const p11: N = cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y;
    const wide: N = max(at.w.mul(p11).mul(screen.y).div(head.w), 1.3);
    const end: N = mix(tail, head, q.x.mul(0.5).add(0.5));
    const side: N = vec2(dir.y.negate(), dir.x).mul(q.y).mul(wide).div(screen).mul(end.w).mul(2);
    // (A short streak still shows its round head.)
    const pad: N = dir.mul(q.x).mul(wide).div(screen).mul(end.w).mul(2);
    m.vertexNode = vec4(end.xy.add(side).add(pad), end.z, end.w);
    const vQ = q.toVarying('vQ'), vT = tint.toVarying('vTint');
    m.fragmentNode = Fn(() => {
      const across = vQ.y.mul(vQ.y);
      const a = across.oneMinus().mul(mix(0.3, 1, vQ.x.mul(0.5).add(0.5))).mul(vT.a);
      If(a.lessThan(0.004), () => { Discard(); });
      const hot = mix(vT.rgb, vec3(1.6, 1.5, 1.3), pow(across.oneMinus(), 4).mul(0.5));
      return vec4(unmap(hot.mul(a), true), 1);
    })();
    Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
    m.blending = THREE.AdditiveBlending;
    return m;
  }
  if (kind === 'chip') return chipMaterial();
  // Turned, then either facing the camera or flat on the ground.
  const turned: N = vec2(mv.x.mul(q.x).sub(mv.y.mul(q.y)), mv.y.mul(q.x).add(mv.x.mul(q.y)));
  const r: N = turned;
  const centre: N = cameraViewMatrix.mul(vec4(at.xyz, 1));
  const facing: N = vec4(centre.xy.add(r.mul(at.w)), centre.z, 1);
  const lying: N = cameraViewMatrix.mul(vec4(at.xyz.add(vec3(r.x, 0, r.y).mul(at.w.negate())), 1));
  const view: N = select(at.w.lessThan(0), lying, facing);
  m.vertexNode = cameraProjectionMatrix.mul(view);
  const vQ = q.toVarying('vQ'), vR = turned.toVarying('vR'), vT = tint.toVarying('vTint');
  const vM = vec2(mv.z, mv.w).toVarying('vMove'), vDepth = view.z.negate().toVarying('vDepth');
  const fogged = (c: N) => mix(c, fogOf(scene).color, fogAt(scene, vDepth));
  if (kind === 'smoke') {
    m.fragmentNode = Fn(() => {
      const k = vM.y, seed = vM.x;
      const n = fbm2(vR.mul(1.7).add(vec2(seed.mul(41.3), seed.mul(17.9))).add(vec2(k.mul(0.9), k.mul(-0.6))));
      const d = length(vQ);
      const shape = smoothDown(1, 0.25, d.add(n.sub(0.5).mul(0.8)));
      const a = shape.mul(clamp(n.mul(1.1).add(0.5), 0, 1)).mul(vT.a);
      If(a.lessThan(0.02), () => { Discard(); });
      // Lighter on top where the sky lights it, darker in its folds.
      const shade = vQ.y.mul(0.18).add(0.86).add(n.sub(0.5).mul(0.4));
      return vec4(unmap(fogged(vT.rgb.mul(shade).mul(lit))), a);
    })();
    Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
    return m;
  }
  // Flames and flashes: tongues flickering upwards, hottest in the middle.
  m.fragmentNode = Fn(() => {
    const k = vM.y, seed = vM.x;
    const n = fbm2(vR.mul(2.2).add(vec2(seed.mul(23.1), seed.mul(57.7))).add(vec2(0, k.mul(-2.5))));
    const d = length(vQ);
    const shape = smoothDown(1, 0.05, d.mul(n.oneMinus().mul(0.7).add(0.7)));
    const a = shape.mul(vT.a);
    If(a.lessThan(0.004), () => { Discard(); });
    const core = smoothDown(0.55, 0, d).mul(shape);
    const colour = mix(vT.rgb, vec3(1.5, 1.25, 0.8), core.mul(0.5)).mul(n.mul(0.5).add(0.75));
    // Added, but also hiding a little of what is behind (premultiplied), so a fireball in daylight
    // reads as a body of flame rather than bleaching all it covers to white.
    return vec4(unmap(colour.mul(a), true).mul(0.4), a.mul(0.6));
  })();
  Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.OneFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  return m;
});

// Broken glass and bits of a car (debris.ts): a flat flake, lit by the sun, the sky and the lamps
// like anything else on the street and shaded by the houses' shadows. It tumbles about an axis of
// its own as it flies and lies flat where it comes to rest, each tilted a few degrees its own way,
// so a scatter of glass on the road catches the sun crumb by crumb as you walk past. Glass is
// clear: the road shows through its middle, its broken edges are greenish and brighter, and its
// face mirrors the sky at a slant and the sun where it leans right. So small a piece is under a
// pixel from overhead; it is drawn a pixel wide there and fainter by as much, which keeps the
// scatter visible without the crumbs flickering.
const uSkyRef: N = followColor(SKY_REF);
function chipMaterial() {
  const m = new MeshStandardNodeMaterial();
  const at: N = attribute('at', 'vec4'), tint: N = attribute('tint', 'vec4'), mv: N = attribute('motion', 'vec4');
  const q: N = positionGeometry.xy;
  const angle: N = mv.x, seed: N = mv.y, glass: N = mv.z, long: N = mv.w;
  const resting: N = at.w.lessThan(0), radius: N = abs(at.w);
  const flake: N = vec3(q.x.mul(long), q.y, 0);
  // Flying: turned about its own axis.
  const axis: N = normalize(fract(vec3(seed.mul(91.7), seed.mul(47.3), seed.mul(13.1))).sub(0.5).add(vec3(0, 0.001, 0)));
  const c: N = cos(angle), s: N = sin(angle);
  const turn = (v: N): N => v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v)).mul(c.oneMinus()));
  // At rest: in the ground's plane, turned about the upright, its face tilted a little.
  const lying: N = vec3(flake.x.mul(c).sub(flake.y.mul(s)), 0, flake.x.mul(s).add(flake.y.mul(c)));
  const tilt: N = normalize(vec3(fract(seed.mul(7.13)).sub(0.5).mul(0.5), 1, fract(seed.mul(3.71)).sub(0.5).mul(0.5)));
  const offset: N = select(resting, lying, turn(flake));
  const n: N = select(resting, tilt, turn(vec3(0, 0, 1)));
  // At least about a pixel across, fainter by as much as it was blown up.
  const screen = uniform(new THREE.Vector2(1, 1)).setGroup(renderGroup);
  screen.onRenderUpdate(({ renderer }: N) => { renderer.getDrawingBufferSize(screen.value); return screen.value; });
  const perMetre: N = cameraProjectionMatrix.mul(vec4(0, 1, 0, 0)).y.mul(screen.y).div(distance(cameraPosition, at.xyz).mul(2));
  const size: N = max(radius, float(0.6).div(perMetre));
  const cover: N = radius.div(size).mul(radius.div(size));
  m.positionNode = at.xyz.add(offset.mul(size));
  const vN: N = n.toVarying('vChipNormal'), vQ: N = q.toVarying('vChipQ');
  const vS: N = vec4(seed, glass, long, cover).toVarying('vChipSeed'), vT: N = tint.toVarying('vChipTint');
  // A rough, broken outline of its own; how near the edge a point is.
  const outline = Fn(() => {
    const k = vS.x;
    return max(abs(vQ.x).mul(k.mul(0.5).add(0.75)), abs(vQ.y).mul(k.mul(-0.5).add(1.25))).add(vQ.x.add(vQ.y.mul(k.sub(0.5))).mul(0.25))
      .add(abs(vQ.x.add(vQ.y)).mul(fract(k.mul(5.3)).mul(0.3)));
  })();
  const isGlass: N = vS.y.greaterThan(0.5);
  const rim: N = smoothstep(0.55, 0.85, outline);
  // A crumb of safety glass is a little cube, not a flat flake: split into four faces leaning
  // their own ways, one of which catches the sun or the sky from almost any side.
  const k: N = vS.x;
  const fx: N = step(fract(k.mul(3.3)).mul(0.6).sub(0.3), vQ.x).mul(2).sub(1), fy: N = step(fract(k.mul(6.1)).mul(0.6).sub(0.3), vQ.y).mul(2).sub(1);
  const lean: N = vec3(fx.mul(fract(k.mul(13.7).add(fy.mul(0.31))).mul(0.5).add(0.3)), 0, fy.mul(fract(k.mul(17.3).add(fx.mul(0.17))).mul(0.5).add(0.3)));
  const face: N = transformNormalToView(normalize(vN.add(select(isGlass, lean, vec3(0)))));
  m.normalNode = select(dot(face, positionViewDirection).lessThan(0), face.negate(), face);
  const body: N = sRGBTransferEOTF(vT.rgb);
  // Glass: a faint green-grey body, its edges greener and more solid.
  m.colorNode = Fn(() => {
    If(outline.greaterThan(0.85), () => { Discard(); });
    const glassy = mix(vec3(0.06, 0.09, 0.08), vec3(0.2, 0.32, 0.28), rim);
    const a = select(isGlass, mix(0.4, 0.9, rim), float(1)).mul(vT.a).mul(vS.w);
    const rgb: N = select(isGlass, glassy, body);
    return vec4(rgb, a);
  })();
  m.roughnessNode = select(isGlass, float(0.1), mix(0.35, 0.75, fract(vS.x.mul(5.7))));
  m.metalnessNode = float(0);
  // What the glass mirrors at a slant: the sky (as a car's windows do).
  const slant: N = pow(dot(face, positionViewDirection).abs().oneMinus(), 3);
  // (As bright as a car's windows mirror it: SKY_REF is the sky's light, not its look. Each face a
  // little differently, as each leans to a different patch of it.)
  const facet: N = fract(k.mul(29.1).add(fx.mul(0.37)).add(fy.mul(0.71))).mul(0.9).add(0.3);
  m.emissiveNode = select(isGlass, uSkyRef.mul(mix(3, 12, slant)).mul(mix(0.6, 1.3, rim)).mul(facet), vec3(0));
  lampLit(m);
  Object.assign(m, { transparent: true, depthWrite: true, side: THREE.DoubleSide });
  return m;
}

// ---- Tyre marks (skids.ts) ----
// Only darkens what's there: the colour is ignored (the blending takes nothing of the source),
// so the alpha is all there is to match.

setSkidShade((now, scene, life) => {
  const m = new NodeMaterial();
  const mark: N = attribute('mark', 'vec3');
  const age = follow(now).sub(mark.x);
  const vA = mark.y.mul(smoothDown(life, life * 0.3, age)).toVarying('vA'), vU = mark.z.toVarying('vU');
  m.fragmentNode = Fn(() => {
    const u2 = vU.mul(vU);
    const a = vA.mul(u2.mul(u2).oneMinus()).mul(fogAt(scene, positionView.z.negate()).oneMinus());
    If(a.lessThan(0.004), () => { Discard(); });
    return vec4(0, 0, 0, a);
  })();
  m.blending = THREE.CustomBlending;
  m.blendSrc = THREE.ZeroFactor;
  m.blendDst = THREE.OneMinusSrcAlphaFactor;
  Object.assign(m, {
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -12,
  });
  return m;
});
