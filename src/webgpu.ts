// The game's renderer, three.js's WebGPURenderer (it began as a trial, ?renderer=webgpu), to measure what the ground
// costs there against WebGL. The ground, buildings, trees, lamp light and the ground's soft
// shading are ported (to TSL, in webgpu/), and the tone curve (sky.ts). Everything
// else that changes three.js's GLSL (onBeforeCompile) is drawn with the plain material,
// and what is written in GLSL outright (ShaderMaterial: rain, snow, lamp glows,
// skid marks) isn't drawn at all. Not for playing: for
// scripts/bench.mjs, e.g. --extra "&renderer=webgl" for the old renderer, with --ab (see ground's flatten).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { WebGPURenderer, MeshLambertNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, uniform, texture, positionWorld, normalView, materialColor, fract, floor, mod, dot,
  mix, smoothstep, step, length, fwidth, abs, sqrt, min, max, distance, cos, sin, select,
} from 'three/tsl';
import { setPatterned, SKY_REF, GRIT, GRIT_M } from './shading.ts';
import {
  type N, uDirt, uWet, uSnow, uStreetSnow, uRain, uCut, uDig, timeOf, followColor, hash12, vnoise, fbm, fbm2, detail, blocks, stones, ports,
} from './webgpu/common.ts';
import { lampLight } from './webgpu/lamps.ts';
import './webgpu/buildings.ts';
import './webgpu/trees.ts';
import './webgpu/soft.ts';
import './webgpu/vehicles.ts';
import './webgpu/figures.ts';
import './webgpu/glows.ts';
import './webgpu/weather.ts';
import './webgpu/underground.ts';

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
const gritMap = texture(GRIT.value);
function grit(c0: N, p: N) {
  const c = vec3(c0).toVar(), d = detail(p, 0.6), g = gritMap.sample(p.div(GRIT_M)).rg.toVar();
  If(uDirt.greaterThan(0.5), () => {
    c.mulAssign(float(1).sub(g.x.mul(0.22)).mul(float(1).sub(g.y.mul(0.12).mul(d))));
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

// WEATHER_GLSL: the colour, and in .a how much of a mirror the ground is there (shine).
function weathered(id: number, c0: N, p: N, time: N) {
  if (id === 10) return vec4(c0, 0.35);
  const paved = id <= 4 || id === 9, road = id === 1 || id === 2;
  const c = vec3(c0).toVar(), shine = float(0).toVar();
  // (Derivatives outside the branches.)
  const ripple = paved ? detail(p, 0.12) : float(0);
  const wet = (paved ? select(uSnow.greaterThan(0.01), max(uWet, uSnow.mul(uStreetSnow.oneMinus()).mul(0.8)), uWet) : uWet).toVar();
  If(wet.greaterThan(0.01), () => {
    c.mulAssign(mix(1, paved ? 0.6 : 0.78, wet));
    if (paved) {
      const puddle = smoothstep(0.66, 0.71, fbm2(p.mul(0.3).add(31)).mul(0.75).add(fbm2(p.mul(0.04).add(7)).mul(0.35))).mul(smoothstep(0.35, 0.9, wet)).toVar();
      shine.assign(puddle.mul(0.4).add(0.1).mul(wet));
      c.mulAssign(float(1).sub(puddle.mul(0.35)));
      If(uRain.greaterThan(0.01).and(ripple.mul(puddle).greaterThan(0)), () => {
        shine.addAssign(ripples(p, time).mul(uRain).mul(0.8).mul(ripple).mul(puddle));
      });
    }
  });
  If(uSnow.greaterThan(0.01), () => {
    const lie = road ? uStreetSnow : paved ? uStreetSnow.mul(0.85).add(0.15) : float(1);
    const n = fbm2(p.mul(0.3).add(9)).mul(0.6).toVar();
    const cover = smoothstep(n, n.add(0.25), uSnow.mul(lie).mul(1.15));
    let snow: N = vec3(0.78, 0.8, 0.84).mul(vnoise(p.mul(4)).mul(0.06).add(0.94));
    if (paved) snow = mix(snow.mul(vec3(0.72, 0.7, 0.68)), snow, uStreetSnow.mul(uStreetSnow));
    c.assign(mix(c, snow, cover));
    shine.mulAssign(cover.oneMinus());
  });
  return vec4(c, shine);
}
// Rings spreading from a drop in each cell of the puddles.
function ripples(p0: N, time: N) {
  const p = p0.mul(2.5), i = floor(p), f = fract(p);
  const t = fract(time.mul(1.1).add(hash12(i)));
  const c = vec2(hash12(i.add(1.7)), hash12(i.add(4.3))).mul(0.6).add(0.2);
  return t.oneMinus().mul(smoothstep(0, 0.07, abs(length(f.sub(c)).sub(t.mul(0.45)))).oneMinus());
}

const uSkyRef: N = followColor(SKY_REF);
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
  const shade = (n: N, pattern: number) => {
    const g = groundColor(pattern, timeOf(time), relief, deck, dig, photo, sheltered).toVar();
    n.colorNode = vec4(g.rgb, 1);
    // Lamp light on the ground, and the wet ground's mirror of the sky and the lamps.
    n.emissiveNode = Fn(() => {
      const l = lampLight(positionWorld, normalView);
      return g.rgb.mul(l).add(uSkyRef.add(l.mul(0.85)).mul(g.a));
    })();
  };
  shade(m, id);
  m.userData.flatten = () => {
    const f = m.clone();
    shade(f, 0);
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
    const shine = float(0).toVar();
    if (!sheltered) { const wc = weathered(id, c, wp, time); c.assign(wc.rgb); shine.assign(wc.a); }
    if (dig) If(distance(w.xz, uDig.xy).lessThan(uDig.z), () => { c.assign(vec3(0.23, 0.19, 0.15).mul(fbm(wp.mul(0.7)).mul(0.4).add(0.8))); });
    return vec4(c, shine);
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
  // Buffers that geometries share (the tree crown's, in every tile) are marked `shared`. Left to
  // three.js, disposing one tile's geometry destroys the buffer for all of them, and objects that
  // haven't changed are never checked again, so they would draw without it.
  const attributes = (renderer as any)._geometries.attributes;
  const deleteAttribute = attributes.delete.bind(attributes);
  attributes.delete = (attribute: { shared?: boolean }) => (attribute.shared ? null : deleteAttribute(attribute));
  library.addToneMapping(toneCurve, THREE.CustomToneMapping);
  // GLSL materials can't be drawn: hide them all. (Material's constructor sets
  // visible through this setter too.)
  // WebGPURenderer calls camera.updateProjectionMatrix(); the lamps' light map is drawn with a bare THREE.Camera, which has none.
  (THREE.Camera.prototype as { updateProjectionMatrix?: () => void }).updateProjectionMatrix ??= () => {};
  Object.defineProperty(THREE.ShaderMaterial.prototype, 'visible', { get: () => false, set: () => {}, configurable: true });
  // Under Chrome's --disable-frame-rate-limit (bench.mjs) compiling ahead never
  // finishes; what isn't compiled by then is compiled when it's first drawn.
  const compileAsync = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...a: Parameters<typeof compileAsync>) => Promise.race([compileAsync(...a), new Promise<void>((r) => setTimeout(r, 10000))]);
  setPatterned(groundMaterial);
  console.info(`Renderer: three.js WebGPURenderer on ${(renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL 2 (no WebGPU here)'}`);
  return renderer as unknown as THREE.WebGLRenderer;
}
