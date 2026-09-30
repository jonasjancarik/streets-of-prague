// Shared TSL for the WebGPU trial (see ../webgpu.ts): the shared uniforms, the value
// noise and pattern helpers (NOISE_GLSL in shading.ts), and the registry of ports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import {
  float, vec2, vec3, uniform, renderGroup, texture, fract, floor, mod, dot, smoothstep, step, length, fwidth, min, sqrt, If,
} from 'three/tsl';
import { NOISE, DIRT, WET, SNOW, STREET_SNOW, RAIN, CUTAWAY, DIG, SKY_LEAST } from '../shading.ts';

export type N = any; // TSL nodes (their typings don't follow the chained arithmetic well)

// Uniforms that follow the shared { value } objects in shading.ts.
// (In renderGroup: an uniform in the default per-object group kept the value it had when first uploaded.)
export const follow = (u: { value: number }) => uniform(u.value).setGroup(renderGroup).onRenderUpdate(() => u.value);
export const uDirt = follow(DIRT), uWet = follow(WET), uSnow = follow(SNOW), uStreetSnow = follow(STREET_SNOW), uRain = follow(RAIN);
export const followVec = (v: { value: THREE.Vector4 }) => { const u = uniform(v.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(v.value); return u.value; }); return u; };
export const followColor = (v: { value: THREE.Color }) => { const u = uniform(v.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(v.value); return u.value; }); return u; };
export const uCut = followVec(CUTAWAY), uDig = followVec(DIG);
const times = new WeakMap<{ value: number }, N>();
export const timeOf = (t: { value: number }) => { let u = times.get(t); if (!u) times.set(t, (u = follow(t))); return u; };

// NOISE_GLSL. (One texture node, sampled at each call, so it's one binding.)
export const noise = texture(NOISE.value);
export const hash12 = (p: N) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};
export const vnoise = (p: N) => {
  const i = floor(p), f = p.sub(i);
  return noise.sample(i.mod(256).add(f.mul(f).mul(f.mul(-2).add(3))).add(0.5).div(256)).level(float(0)).r;
};
export const fbm2 = (p: N) => vnoise(p).mul(2).add(vnoise(p.mul(2.03).add(11.7))).div(3);
export const fbm = (p: N) => {
  let s: N = float(0), a = 0.5, q = p;
  for (let k = 0; k < 4; k++) { s = s.add(vnoise(q).mul(a)); q = q.mul(2.03).add(11.7); a *= 0.5; }
  return s;
};
// Declared where it's called (toVar), outside any branch: WGSL wants derivatives there.
export const detail = (p: N, cell: number) => float(1).sub(smoothstep(cell * 0.2, cell * 0.7, length(fwidth(p)))).toVar();
export const blocks = (p: N, sx: N, sy: N) => {
  const qy = p.y.div(sy), qx = p.x.div(sx).add(step(1, mod(floor(qy), 2)).mul(0.5));
  const q = vec2(qx, qy), f = fract(q), e = min(f, f.oneMinus()).mul(vec2(sx, sy));
  return vec2(min(e.x, e.y), hash12(floor(q)));
};
export const hash32 = (p: N) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
};
export const stones = (p: N) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const d1 = float(64).toVar(), d2 = float(64).toVar(), id = float(0).toVar();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const g = vec2(x, y), h = hash32(i.add(g)).toVar();
    const r = g.add(h.xy.mul(0.8)).add(0.1).sub(f), d = dot(r, r).toVar();
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); id.assign(h.z); }).ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  }
  return vec2(sqrt(d2).sub(sqrt(d1)), id);
};


// Ports of the materials that change three.js's GLSL, chosen by the legacy material's
// customProgramCacheKey (see createRenderer in ../webgpu.ts).
export type Port = (node: N, legacy: THREE.Material) => void;
export const ports: { match: RegExp; port: Port }[] = [];
export const addPort = (match: RegExp, port: Port) => { ports.push({ match, port }); };

// The share of the ambient (sky) light left where a spot sees `open` of the sky (baked in
// map/skyView.ts; 1 on roofs and squares). Even a deep courtyard is lit by light bounced off its walls.
export const skyAmbient = (open: N) => open.mul(1 - SKY_LEAST).add(SKY_LEAST);
