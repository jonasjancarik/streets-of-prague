// A trial of three.js's WebGPU renderer (?renderer=webgpu), to measure what the ground
// costs there against WebGL. Only the ground is ported (to TSL, from PATTERNS_GLSL,
// NOISE_GLSL and WEATHER_GLSL in shading.ts), and the tone curve (sky.ts). Everything
// else that changes three.js's GLSL (onBeforeCompile) is drawn with the plain material,
// and what is written in GLSL outright (ShaderMaterial: rain, snow, the lamps' light,
// skid marks, the ground's soft shading) isn't drawn at all. Not for playing: for
// scripts/bench.mjs, e.g. --extra "&renderer=webgpu" with --ab (see ground's flatten).
// Not ported yet: the lamps' light on the ground and the wet ground's mirror (shine).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { WebGPURenderer, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, uniform, texture, positionWorld, materialColor, fract, floor, mod, dot,
  mix, smoothstep, step, length, fwidth, abs, sqrt, min, max, distance, cos, sin, select,
} from 'three/tsl';
import { NOISE, DIRT, WET, SNOW, STREET_SNOW, RAIN, CUTAWAY, DIG, setPatterned } from './shading.ts';

type N = any; // TSL nodes (their typings don't follow the chained arithmetic well)

// Uniforms that follow the shared { value } objects in shading.ts.
const follow = (u: { value: number }) => uniform(u.value).onRenderUpdate(() => u.value);
const uDirt = follow(DIRT), uWet = follow(WET), uSnow = follow(SNOW), uStreetSnow = follow(STREET_SNOW), uRain = follow(RAIN);
const uCut = uniform(CUTAWAY.value), uDig = uniform(DIG.value);
const times = new WeakMap<{ value: number }, N>();
const timeOf = (t: { value: number }) => { let u = times.get(t); if (!u) times.set(t, (u = follow(t))); return u; };

// NOISE_GLSL. (One texture node, sampled at each call, so it's one binding.)
const noise = texture(NOISE.value);
const hash12 = (p: N) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
};
const vnoise = (p: N) => {
  const i = floor(p), f = p.sub(i);
  return noise.sample(i.mod(256).add(f.mul(f).mul(f.mul(-2).add(3))).add(0.5).div(256)).level(float(0)).r;
};
const fbm2 = (p: N) => vnoise(p).mul(2).add(vnoise(p.mul(2.03).add(11.7))).div(3);
const fbm = (p: N) => {
  let s: N = float(0), a = 0.5, q = p;
  for (let k = 0; k < 4; k++) { s = s.add(vnoise(q).mul(a)); q = q.mul(2.03).add(11.7); a *= 0.5; }
  return s;
};
// Declared where it's called (toVar), outside any branch: WGSL wants derivatives there.
const detail = (p: N, cell: number) => float(1).sub(smoothstep(cell * 0.2, cell * 0.7, length(fwidth(p)))).toVar();
const blocks = (p: N, sx: number, sy: number) => {
  const qy = p.y.div(sy), qx = p.x.div(sx).add(step(1, mod(floor(qy), 2)).mul(0.5));
  const q = vec2(qx, qy), f = fract(q), e = min(f, f.oneMinus()).mul(vec2(sx, sy));
  return vec2(min(e.x, e.y), hash12(floor(q)));
};
const hash32 = (p: N) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
};
const stones = (p: N) => {
  const i = floor(p).toVar(), f = fract(p).toVar();
  const d1 = float(64).toVar(), d2 = float(64).toVar(), id = float(0).toVar();
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    const g = vec2(x, y), h = hash32(i.add(g)).toVar();
    const r = g.add(h.xy.mul(0.8)).add(0.1).sub(f), d = dot(r, r).toVar();
    If(d.lessThan(d1), () => { d2.assign(d1); d1.assign(d); id.assign(h.z); }).ElseIf(d.lessThan(d2), () => { d2.assign(d); });
  }
  return vec2(sqrt(d2).sub(sqrt(d1)), id);
};

// PATTERNS_GLSL.
function pAsphalt(c0: N, p: N) {
  const c = c0.mul(fbm(p.mul(0.3)).mul(0.18).add(0.9)).toVar();
  c.mulAssign(mix(1, 0.9, smoothstep(0.62, 0.66, fbm(p.mul(0.07).add(3)))));
  const d = detail(p, 0.06), dc = detail(p, 0.15);
  If(d.greaterThan(0), () => { c.addAssign(vnoise(p.mul(16)).sub(0.5).mul(0.07).mul(d)); });
  c.mulAssign(float(1).sub(smoothstep(0.6, 0.85, vnoise(p.mul(vec2(0.9, 0.25)).add(23))).mul(0.14)));
  If(dc.greaterThan(0), () => {
    const crack = float(1).sub(smoothstep(0, 0.025, abs(vnoise(p.mul(0.7)).sub(0.5))));
    c.mulAssign(float(1).sub(crack.mul(0.3).mul(dc).mul(smoothstep(0.55, 0.7, vnoise(p.mul(0.06).add(2))))));
  });
  return c;
}
function pSetts(c: N, p: N, sx: number, sy: number) {
  const d = detail(p, sx), s = c.mul(0.85).toVar();
  If(d.greaterThan(0), () => {
    const b = blocks(p, sx, sy);
    const stone = c.mul(b.y.mul(0.4).add(0.8)).mul(vnoise(p.mul(9)).mul(0.16).add(0.92));
    s.assign(mix(s, mix(c.mul(0.5), stone, smoothstep(0.004, 0.02, b.x)), d));
  });
  return s.mul(fbm(p.mul(0.2)).mul(0.12).add(0.94));
}
function pMosaic(c: N, p: N) {
  const d = detail(p, 0.09), m = c.mul(0.9).toVar();
  If(d.greaterThan(0), () => {
    const s = stones(p.mul(11));
    const stone = mix(c.mul(s.y.mul(0.18).add(0.9)), c.mul(0.62), step(0.9, s.y));
    m.assign(mix(m, mix(c.mul(0.6), stone, smoothstep(0.03, 0.12, s.x)), d));
  });
  return m.mul(fbm(p.mul(0.25)).mul(0.1).add(0.95));
}
function pSlabs(c: N, p: N) {
  const d = detail(p, 0.4), s = c.mul(0.95).toVar();
  If(d.greaterThan(0), () => {
    const b = blocks(p, 0.6, 0.4);
    s.assign(mix(s, mix(c.mul(0.72), c.mul(b.y.mul(0.15).add(0.9)), smoothstep(0.004, 0.015, b.x)), d));
  });
  return s.mul(fbm(p.mul(0.15)).mul(0.14).add(0.93));
}
function pGrass(c0: N, p: N) {
  const c = c0.mul(fbm(p.mul(0.18)).mul(0.32).add(0.82)).toVar();
  c.assign(mix(c, c.mul(vec3(1.12, 1.05, 0.78)), smoothstep(0.55, 0.75, fbm(p.mul(0.04).add(7)))));
  c.assign(mix(c, c.mul(vec3(1.05, 0.9, 0.7)), smoothstep(0.6, 0.8, fbm2(p.mul(0.15).add(3))).mul(0.6)));
  const d = detail(p, 0.2);
  If(d.greaterThan(0), () => { c.addAssign(vnoise(p.mul(5)).sub(0.5).mul(0.07).mul(d)); });
  return c;
}
const pWood = (c: N, p: N) => c.mul(fbm(p.mul(0.12)).mul(0.45).add(0.75)).add(vnoise(p.mul(3)).sub(0.5).mul(0.05));
const pPitch = (c: N, p: N) => pGrass(c, p).mul(step(0.5, fract(p.x.div(6))).mul(0.1).add(0.94));
function pDirt(c0: N, p: N) {
  const d = detail(p, 0.08), c = c0.mul(fbm(p.mul(0.5)).mul(0.25).add(0.85)).toVar();
  If(d.greaterThan(0), () => { c.addAssign(vnoise(p.mul(12)).sub(0.5).mul(0.08).mul(d)); });
  return c;
}
function pGravel(c: N, p: N) {
  const d = detail(p, 0.05), g = vec3(c).toVar();
  If(d.greaterThan(0), () => {
    const s = stones(p.mul(22));
    g.assign(c.mul(s.y.mul(0.3).add(0.84)).mul(mix(0.7, 1, smoothstep(0.02, 0.1, s.x))));
    g.assign(mix(g, c.mul(vec3(1.18, 1.16, 1.12)), step(0.94, hash12(floor(p.mul(7)))).mul(0.5)));
  });
  const m = mix(c.mul(vnoise(p.mul(4)).mul(0.1).add(0.93)), g, d);
  return m.mul(fbm(p.mul(0.35)).mul(0.16).add(0.9)).mul(mix(1, 0.93, smoothstep(0.6, 0.7, fbm(vec2(p.x.mul(0.05), p.y.mul(0.8)).add(5)))));
}
function pField(c0: N, p: N) {
  const cell = floor(p.div(90));
  const a = hash12(cell).mul(3.1416), t = hash12(cell.add(3.7));
  const row = fract(dot(p, vec2(cos(a), sin(a))).div(1.6));
  const c = c0.mul(mix(vec3(0.95, 1.02, 0.9), vec3(1.07, 1, 0.88), t)).toVar();
  c.mulAssign(float(1).sub(smoothstep(0.35, 0.5, abs(row.sub(0.5))).mul(0.1).mul(detail(p, 1.2))));
  const fine = detail(p, 0.15);
  c.mulAssign(fbm(p.mul(0.03)).mul(0.2).add(0.9));
  If(fine.greaterThan(0), () => { c.addAssign(vnoise(p.mul(6)).sub(0.5).mul(0.04).mul(fine)); });
  return c;
}
function pConcrete(c: N, p: N) {
  const b = blocks(p, 3, 2.4), dl = detail(p, 1);
  return c.mul(fbm(p.mul(0.4)).mul(0.12).add(0.9)).mul(mix(0.8, 1, smoothstep(0.01, 0.04, b.x).mul(dl).add(dl.oneMinus())));
}
function pWater(c0: N, p: N, time: N) {
  const n = fbm(p.mul(vec2(0.05, 0.012)).add(vec2(0, time.mul(0.03))));
  const c = c0.mul(n.mul(0.2).add(0.88)).toVar(), d = detail(p, 0.5);
  If(d.greaterThan(0), () => {
    c.addAssign(smoothstep(0.72, 0.8, fbm(p.mul(vec2(0.5, 0.09)).add(vec2(time.mul(0.02), time.mul(0.12))))).mul(0.1).mul(d));
  });
  return c;
}
function grit(c0: N, p: N) {
  const c = vec3(c0).toVar(), d = detail(p, 0.6);
  If(uDirt.greaterThan(0.5), () => {
    c.mulAssign(float(1).sub(smoothstep(0.3, 0.85, fbm2(p.mul(0.13).add(5))).mul(0.22)));
    If(d.greaterThan(0), () => { c.mulAssign(float(1).sub(smoothstep(0.55, 0.85, fbm2(p.mul(0.6).add(17))).mul(0.12).mul(d))); });
  });
  return c;
}
function pattern(id: number, c: N, p: N, time: N): N {
  switch (id) {
    case 1: return grit(pAsphalt(c, p), p);
    case 2: return grit(pSetts(c, p, 0.17, 0.14), p);
    case 3: return grit(pMosaic(c, p), p);
    case 4: return grit(pSlabs(c, p), p);
    case 5: return pGrass(c, p);
    case 6: return pWood(c, p);
    case 7: return pPitch(c, p);
    case 8: return pDirt(c, p);
    case 9: return grit(pConcrete(c, p), p);
    case 10: return pWater(c, p, time);
    case 11: return pGravel(c, p);
    case 12: return pField(c, p);
    default: return c;
  }
}

// WEATHER_GLSL, the colour only (not the shine).
function weathered(id: number, c0: N, p: N) {
  if (id === 10) return c0;
  const paved = id <= 4 || id === 9, road = id === 1 || id === 2;
  const c = vec3(c0).toVar();
  const wet = (paved ? select(uSnow.greaterThan(0.01), max(uWet, uSnow.mul(uStreetSnow.oneMinus()).mul(0.8)), uWet) : uWet).toVar();
  If(wet.greaterThan(0.01), () => {
    c.mulAssign(mix(1, paved ? 0.6 : 0.78, wet));
    if (paved) {
      const puddle = smoothstep(0.66, 0.71, fbm2(p.mul(0.3).add(31)).mul(0.75).add(fbm2(p.mul(0.04).add(7)).mul(0.35))).mul(smoothstep(0.35, 0.9, wet));
      c.mulAssign(float(1).sub(puddle.mul(0.35)));
    }
  });
  If(uSnow.greaterThan(0.01), () => {
    const lie = road ? uStreetSnow : paved ? uStreetSnow.mul(0.85).add(0.15) : float(1);
    const n = fbm2(p.mul(0.3).add(9)).mul(0.6).toVar();
    const cover = smoothstep(n, n.add(0.25), uSnow.mul(lie).mul(1.15));
    let snow: N = vec3(0.78, 0.8, 0.84).mul(vnoise(p.mul(4)).mul(0.06).add(0.94));
    if (paved) snow = mix(snow.mul(vec3(0.72, 0.7, 0.68)), snow, uStreetSnow.mul(uStreetSnow));
    c.assign(mix(c, snow, cover));
  });
  void uRain; // (the rain only ripples the puddles' shine)
  return c;
}

const inBox = (p: N, box: number[]) => {
  const b = uniform(new THREE.Vector4(box[0], box[1], box[2], box[3]));
  return p.sub(b.xy).div(b.zw.sub(b.xy));
};

// patterned() in shading.ts, as a node material.
function groundMaterial(
  base: THREE.MeshLambertMaterial, id: number, time: { value: number },
  relief: { texture: THREE.Texture; box: number[] } | null = null, deck: { mask: THREE.Texture | null; box?: number[] } | null = null,
  dig = false, photo: { texture: THREE.Texture; box: number[] } | null = null, sheltered = false,
) {
  const m = new MeshLambertNodeMaterial();
  m.color.copy(base.color);
  Object.assign(m, { side: base.side, depthWrite: base.depthWrite, depthTest: base.depthTest, transparent: base.transparent, opacity: base.opacity });
  m.colorNode = groundColor(id, timeOf(time), relief, deck, dig, photo, sheltered);
  m.userData.flatten = () => {
    const f = m.clone();
    f.colorNode = groundColor(0, timeOf(time), relief, deck, dig, photo, sheltered);
    return f;
  };
  return m as unknown as THREE.MeshLambertMaterial;
}
function groundColor(
  id: number, time: N, relief: { texture: THREE.Texture; box: number[] } | null, deck: { mask: THREE.Texture | null; box?: number[] } | null,
  dig: boolean, photo: { texture: THREE.Texture; box: number[] } | null, sheltered: boolean,
) {
  return Fn(() => {
    const w = positionWorld.toVar();
    const wp = vec2(w.x, w.z.negate()).toVar();
    if (deck) {
      If(w.y.greaterThan(uCut.y).and(distance(w.xz, uCut.xz).lessThan(uCut.w)), () => { Discard(); });
      if (deck.mask) If(texture(deck.mask, inBox(wp, deck.box!)).r.lessThan(0.5), () => { Discard(); });
    }
    const c = vec3(photo ? texture(photo.texture, inBox(wp, photo.box)).rgb : pattern(id, vec3(materialColor), wp, time)).toVar();
    // Hill shading and the broad variation (broad), baked together for a tile.
    if (relief) c.mulAssign(texture(relief.texture, inBox(wp, relief.box)).r);
    else c.mulAssign(fbm(wp.mul(0.004)).mul(0.14).add(0.93));
    if (!sheltered) c.assign(weathered(id, c, wp));
    if (dig) If(distance(w.xz, uDig.xy).lessThan(uDig.z), () => { c.assign(vec3(0.23, 0.19, 0.15).mul(fbm(wp.mul(0.7)).mul(0.4).add(0.8))); });
    return vec4(c, 1);
  })();
}

// The tone curve in sky.ts.
const toneCurve = Fn(([color, exposure]: N[]) => {
  const c = color.mul(exposure).toVar();
  c.assign(c.mul(c.div(36).add(1)).div(c.add(1)));
  c.assign(mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), 0.12));
  c.assign(mix(c, c.mul(c).mul(c.mul(-2).add(3)), 0.35));
  return select(exposure.lessThan(0), color.mul(exposure.negate()), c.add(vec3(0.016, 0.012, 0.006).mul(c.oneMinus())));
}).setLayout({ name: 'customToneMapping', type: 'vec3', inputs: [{ name: 'color', type: 'vec3' }, { name: 'exposure', type: 'float' }] });

// Ports of the materials that change three.js's GLSL, chosen by the legacy material's
// customProgramCacheKey (each of them sets one). When WebGPURenderer builds a shader for a
// legacy material, it converts it through library.fromMaterial: `port` gets the node
// material made from it, to set colorNode and the like. The mesh keeps its legacy
// material, so the module-level ones (cars, trams, funicular, treeDepth) need no lazy
// creation or boot module, and the shadow pass (which reads the mesh's own material's
// nodes, not the converted one's) stays plain unless the port sets castShadow nodes on
// the legacy material.
type Port = (node: N, legacy: THREE.Material) => void;
const ports: { match: RegExp; port: Port }[] = [];
const addPort = (match: RegExp, port: Port) => { ports.push({ match, port }); };

export async function createRenderer() {
  const renderer = new WebGPURenderer({ antialias: true, stencil: true });
  await renderer.init();
  const library = renderer.library as any;
  const fromMaterial = library.fromMaterial.bind(library);
  library.fromMaterial = (legacy: THREE.Material) => {
    const node = fromMaterial(legacy);
    if (node && node !== legacy && legacy.customProgramCacheKey) {
      const key = legacy.customProgramCacheKey();
      for (const p of ports) if (p.match.test(key)) p.port(node, legacy);
    }
    return node;
  };
  library.addToneMapping(toneCurve, THREE.CustomToneMapping);
  // GLSL materials can't be drawn: hide them all. (Material's constructor sets
  // visible through this setter too.)
  Object.defineProperty(THREE.ShaderMaterial.prototype, 'visible', { get: () => false, set: () => {}, configurable: true });
  // Under Chrome's --disable-frame-rate-limit (bench.mjs) compiling ahead never
  // finishes; what isn't compiled by then is compiled when it's first drawn.
  const compileAsync = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...a: Parameters<typeof compileAsync>) => Promise.race([compileAsync(...a), new Promise<void>((r) => setTimeout(r, 10000))]);
  setPatterned(groundMaterial);
  console.info(`Renderer: three.js WebGPURenderer on ${(renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (no WebGPU here)'}`);
  return renderer as unknown as THREE.WebGLRenderer;
}
