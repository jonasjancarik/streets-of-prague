// The small effects that are written in GLSL outright (ShaderMaterial), in TSL: the lamps'
// and traffic lights' glows (lamps.ts, signals.ts), the spray behind cars in the rain
// (spray.ts), the flames and smoke of burning cars (fire.ts) and the tyre marks (skids.ts).
// Each one is made through a hook in its own file (as `setSoftShade` is in surface.ts).
// The signals' poles and heads have the lamps' light too (a port of their Lambert materials).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, uv, attribute, uniform, renderGroup, instanceColor, positionGeometry, positionView, positionViewDirection, normalView, cameraViewMatrix,
  cameraProjectionMatrix, smoothstep, mix, min, max, clamp, dot, sqrt, pow, fract, sin, cos, length, select, sRGBTransferEOTF, toneMappingExposure,
} from 'three/tsl';
import { setGlows } from '../lamps.ts';
import { setSignalGlow } from '../signals.ts';
import { setBeamShade, setGlintShade, BEAM_ON } from '../lightfx.ts';
import { setSprayDrawing } from '../spray.ts';
import { setSmokeDrawing } from '../chimneySmoke.ts';
import { setPuffShade } from '../fire.ts';
import { setSkidShade } from '../skids.ts';
import { lampLit, uLampOn } from './lamps.ts';
import { type N, addPort, follow, followVec, followColor } from './common.ts';

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

function additive(fragment: () => N) {
  const m = new NodeMaterial();
  m.fragmentNode = Fn(fragment)();
  m.blending = THREE.AdditiveBlending;
  Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
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

setBeamShade(() => {
  const strength = follow(BEAM_ON);
  const t: N = positionGeometry.x.toVarying('vBeamT');
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
  const g = f.mul(f).mul(uLampOn.add(0.8)).add(smoothDown(0.3, 0.2, d).mul(0.5));
  return vec4(unmap(instanceColor.mul(g), true), 1);
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

// ---- Flames and smoke (fire.ts) ----
// Flat round puffs, each with its own colour and fade (the `tint` attribute): smoke drawn over the
// scene, flames and flashes added to it.

setPuffShade((glow) => {
  const m = new NodeMaterial();
  const tint: N = attribute('tint', 'vec4');
  m.fragmentNode = Fn(() => {
    const a = smoothDown(1, 0.15, length(uv().mul(2).sub(1))).mul(tint.a);
    If(a.lessThan(0.004), () => { Discard(); });
    return glow ? vec4(unmap(tint.rgb.mul(a), true), 1) : vec4(unmap(tint.rgb), a);
  })();
  Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
  if (glow) m.blending = THREE.AdditiveBlending;
  return m;
});

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
