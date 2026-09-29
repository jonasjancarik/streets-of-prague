// The buildings in TSL (BUILDING_GLSL, FACADE_GLSL and the body of shadeBuildings in
// shading.ts / facades.ts): roof tiles, slate and gravel, the windows and facade pictures,
// grime, lit windows at night, rain and snow, and the cutaway over the player in a
// passage. Registered as a port of the 'buildings-procedural' material (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import {
  Fn, If, Discard, float, int, vec2, vec3, vec4, array, texture, attribute, vertexColor, positionWorld, normalWorld, diffuseColor,
  materialColor, fract, floor, dot, sin, mix, smoothstep, step, length, abs, max, min, clamp, normalize, dFdx, dFdy, distance, select, cross,
} from 'three/tsl';
import { FACADE_ATLAS, FACADE_ON } from '../facades.ts';
import { WINDOWS, LANDMARK_TILE_RGB } from '../shading.ts';
import { lampLit } from './lamps.ts';
import { type N, follow, addPort, uCut, uDirt, uWet, uSnow, vnoise, fbm, fbm2, blocks } from './common.ts';

const uFacadeOn = follow(FACADE_ON), uWindows = follow(WINDOWS);

// The atlas loads after the first frames: a one-layer stand-in keeps the binding's type.
const standIn = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
standIn.colorSpace = THREE.SRGBColorSpace;
standIn.minFilter = THREE.LinearMipmapLinearFilter; // (filtered, as the atlas is: a nearest texture gets no sampler)
standIn.magFilter = THREE.LinearFilter;
standIn.needsUpdate = true;
const atlas = texture(standIn).onRenderUpdate(() => { atlas.value = FACADE_ATLAS.value ?? standIn; });

// The layer tables of FACADE_GLSL (const int arrays).
const ints = (v: number[]): N => array(v.map((x) => int(x))).toVar();
const F_UP = ints([0, 1, 2, 3, 4, 0, 12, 13, 14, 15, 12, 14, 24, 25, 24, 25, 26, 24, 27, 28, 27, 27, 28, 27, 36, 37, 38, 39, 40, 36]);
const F_DOOR = ints([7, 8, 9, 18, 19, 20, 31, 31, 34, 32, 32, 34, 42, 44, 45]);
const F_WALL = ints([6, 6, 10, 11, 21, 22, 23, 20, 30, 30, 30, 35, 33, 35, 33, 35, 43, 46, 47, 43]);

const fHash = (a: N, b: N) => fract(sin(a.mul(127.1).add(b.mul(311.7))).mul(43758.5453));
const LANDMARK_TILE = vec3(...LANDMARK_TILE_RGB);
const luma = (c: N) => dot(c, vec3(0.299, 0.587, 0.114));
// detail() with the pixel's footprint worked out once, outside any branch (derivatives).
const fade = (width: N, cell: number) => float(1).sub(smoothstep(cell * 0.2, cell * 0.7, width));

function roofTiles(c0: N, wp: N, n: N, wpWidth: N) {
  const down = normalize(vec2(n.x, n.z.negate())), across = vec2(down.y.negate(), down.x);
  const slate = step(max(c0.r, max(c0.g, c0.b)).sub(min(c0.r, min(c0.g, c0.b))), 0.08);
  const size = mix(vec2(0.26, 0.32), vec2(0.3, 0.22), slate);
  const q = vec2(dot(wp, across), dot(wp, down).div(max(n.y, 0.3)));
  const b = blocks(q, size.x, size.y);
  const row = fract(q.y.div(size.y));
  const d = float(1).sub(smoothstep(size.y.mul(0.2), size.y.mul(0.7), wpWidth));
  const t = c0.mul(b.y.mul(0.2).add(0.9)).toVar();
  t.mulAssign(mix(vec3(1.07, 0.95, 0.86), vec3(0.95, 1, 1.05), fract(b.y.mul(7.3))));
  t.mulAssign(smoothstep(0, 0.4, row).mul(0.25).add(0.8));
  t.assign(mix(t.mul(0.72), t, smoothstep(0, 0.012, b.x)));
  const c = mix(c0.mul(0.95), t, d).toVar();
  c.mulAssign(fbm(wp.mul(0.22)).mul(0.24).add(0.88));
  return mix(c, c.mul(vec3(0.86, 0.9, 0.8)), smoothstep(0.62, 0.75, fbm(wp.mul(0.09).add(4))).mul(0.7));
}
function flatRoof(c: N, wp: N, wpWidth: N) {
  return c.mul(fbm(wp.mul(0.5)).mul(0.22).add(0.86)).add(vnoise(wp.mul(18)).sub(0.5).mul(0.08).mul(fade(wpWidth, 0.05)));
}

function facadeWalls(c: N, f: N, fWidth: N) {
  const along = f.x, h = f.y;
  const bay = fract(along.div(1.9)), storey = fract(h.sub(0.6).div(3.4));
  const upper = step(4, h);
  const win = step(0.3, bay).mul(step(bay, 0.7)).mul(step(0.3, storey)).mul(step(storey, 0.78)).mul(upper);
  const shop = step(0.12, bay).mul(step(bay, 0.88)).mul(step(0.6, h)).mul(step(h, 3.3)).mul(float(1).sub(upper));
  const glass = vec3(0.16, 0.19, 0.23).add(vnoise(vec2(along, h).mul(0.7)).mul(0.06));
  const m = max(win, shop.mul(0.85)), d = fade(fWidth, 0.9);
  const w = mix(c, glass, m.mul(d));
  return mix(w, w.mul(1.08), float(1).sub(m).mul(step(0.92, storey)).mul(upper).mul(d));
}

function grime(c0: N, f: N, fWidth: N) {
  const seed = fract(f.w).mul(97);
  const c = c0.mul(fbm2(vec2(f.x.mul(0.1).add(seed), f.y.mul(0.07))).mul(0.34).add(0.76)).toVar();
  const streak = fbm2(vec2(f.x.mul(1.8).add(seed), f.y.mul(0.12)));
  c.mulAssign(float(1).sub(smoothstep(0.5, 0.8, streak).mul(0.28).mul(fade(fWidth, 0.4))));
  return c.mul(mix(0.66, 1, smoothstep(0, 1.4, f.y)));
}

// The picture for a bay and storey, from the atlas's layer, with the wall's plaster colour.
function facadeModules(wall: N, f: N, fdx: N, fdy: N) {
  const style = floor(f.w).toInt(), seed = fract(f.w).mul(97);
  const bays = max(1, floor(f.z.div(1.9).add(0.5)));
  const q = vec2(f.x.div(f.z).mul(bays), select(f.y.lessThan(4), clamp(f.y.div(4), 0, 0.999), f.y.sub(4).div(3.4)));
  const cell = floor(q), uv = fract(q);
  const layer = int(0).toVar();
  If(f.y.lessThan(4), () => {
    const r = fHash(seed, cell.x);
    If(r.lessThan(0.18), () => { layer.assign(F_DOOR.element(style.mul(3).add(r.div(0.18).mul(3).toInt()))); })
      .Else(() => { layer.assign(F_WALL.element(style.mul(4).add(fHash(cell.x, seed).mul(4).toInt()))); });
  }).Else(() => { layer.assign(F_UP.element(style.mul(6).add(fHash(seed, cell.y.add(7)).mul(6).toInt()))); });
  const k = vec2(bays.div(f.z), 1 / 3.6);
  const t = atlas.sample(vec2(uv.x, float(1).sub(uv.y))).depth(layer).grad(fdx.xy.mul(k), fdy.xy.mul(k)).rgb;
  const hi = max(t.r, max(t.g, t.b)), sat = hi.sub(min(t.r, min(t.g, t.b))).div(max(hi, 1e-3));
  return mix(t, t.mul(wall).div(0.55), float(1).sub(smoothstep(0.08, 0.2, sat)));
}

const buildingColor = Fn(() => {
  const w = positionWorld.toVar();
  If(w.y.greaterThan(uCut.y).and(distance(w.xz, uCut.xz).lessThan(uCut.w)), () => { Discard(); });
  const bn = normalWorld.normalize().toVar();
  const f = attribute('facade', 'vec4').toVar();
  // Derivatives are taken here, outside the branches below (WGSL wants that).
  const fdx = dFdx(f).toVar(), fdy = dFdy(f).toVar();
  const bwp = vec2(w.x, w.z.negate()).toVar();
  const wpWidth = length(abs(dFdx(bwp)).add(abs(dFdy(bwp)))).toVar();
  const fWidth = length(abs(fdx.xy).add(abs(fdy.xy))).toVar();
  const c = vec3(materialColor).mul(vertexColor().rgb).toVar();
  If(bn.y.greaterThan(0.97), () => {
    c.assign(flatRoof(c, bwp, wpWidth));
  }).ElseIf(bn.y.greaterThan(0.15), () => {
    c.assign(roofTiles(c, bwp, bn, wpWidth));
  }).Else(() => {
    If(uFacadeOn.greaterThan(0.5).and(f.z.greaterThan(0.1)), () => { c.assign(facadeModules(c, f, fdx, fdy)); })
      .Else(() => { c.assign(facadeWalls(c, f.xy, fWidth)); });
    If(uDirt.greaterThan(0.5), () => { c.assign(grime(c, f, fWidth)); });
  });
  // Rain darkens the walls and the roofs; snow lies on the roofs, less on steep ones.
  c.mulAssign(mix(1, select(bn.y.greaterThan(0.15), 0.72, 0.84), uWet));
  If(uSnow.greaterThan(0.01).and(bn.y.greaterThan(0.15)), () => {
    const cover = smoothstep(0, 0.25, uSnow.mul(smoothstep(0.25, 0.7, bn.y)).mul(1.2).sub(fbm2(bwp.mul(0.4)).mul(0.45)));
    c.assign(mix(c, vec3(0.8, 0.82, 0.86).mul(vnoise(bwp.mul(3)).mul(0.07).add(0.93)), cover));
  });
  return vec4(c, 1);
});

// Lit windows at night: dark glass above the ground floor, in a share of the windows by
// the time; shop windows at street level the same.
const windowGlow = Fn(() => {
  const g = vec3(0).toVar();
  const bn = normalWorld.normalize(), f = attribute('facade', 'vec4');
  If(uWindows.greaterThan(0.005).and(bn.y.lessThan(0.15)).and(f.z.greaterThan(0.1)), () => {
    const bays = max(1, floor(f.z.div(1.9).add(0.5)));
    const cell = vec2(floor(f.x.div(f.z).mul(bays)), floor(f.y.sub(0.6).div(3.4)));
    const lit = step(fHash(cell.x.add(fract(f.w).mul(97)), cell.y), uWindows.mul(select(f.y.lessThan(4), 1.6, 1)));
    const glass = float(1).sub(smoothstep(0.13, 0.22, luma(diffuseColor.rgb).div(max(luma(vertexColor().rgb), 0.02))));
    g.assign(mix(vec3(1, 0.62, 0.3), vec3(1, 0.8, 0.55), fHash(cell.y, cell.x)).mul(lit).mul(glass).mul(0.55));
  });
  return g;
});

addPort(/^buildings-procedural$/, (node) => {
  node.vertexColors = false; // the colour node multiplies the vertex colour in itself
  node.colorNode = buildingColor();
  node.emissiveNode = windowGlow();
  lampLit(node);
});

// The same hole in the landmarks, trees and the ground's depth pass (cutAway in shading.ts).
addPort(/^cut-/, (node) => {
  const w = positionWorld;
  node.maskNode = w.y.greaterThan(uCut.y).and(distance(w.xz, uCut.xz).lessThan(uCut.w)).not();
  lampLit(node);
});

// Landmarks' roofs: where the photograph shows a red roof, the tile pattern of the other
// roofs, in their colour, at the brightness of the photograph (its shadows and dormers).
// The face's own normal comes from derivatives: the model's normals are all "up" for the light.
const landmarkColor = Fn(() => {
  const w = positionWorld.toVar();
  const c = vec3(materialColor).toVar();
  const fn = cross(dFdx(w), dFdy(w)).toVar();
  const up = normalize(fn.mul(select(fn.y.lessThan(0), -1, 1))).toVar();
  const bwp = vec2(w.x, w.z.negate()).toVar();
  const wpWidth = length(abs(dFdx(bwp)).add(abs(dFdy(bwp)))).toVar();
  const mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  const sat = mx.sub(mn).div(max(mx, 0.001));
  const hue = c.g.sub(c.b).div(max(mx.sub(mn), 0.001)).div(6);
  const roofFace = smoothstep(0.15, 0.3, up.y);
  const reddish = step(max(c.g, c.b), c.r.add(0.01));
  const warm = max(smoothstep(0.18, 0.3, sat).mul(float(1).sub(smoothstep(0.11, 0.16, hue))), float(1).sub(smoothstep(0.02, 0.06, luma(c)))).mul(reddish).mul(roofFace);
  const tile = roofTiles(LANDMARK_TILE.mul(clamp(luma(c).div(0.15), 0.15, 1.7)), bwp, up, wpWidth);
  return mix(c, tile, warm);
});
addPort(/^landmark-roof$/, (node) => {
  const w = positionWorld;
  node.maskNode = w.y.greaterThan(uCut.y).and(distance(w.xz, uCut.xz).lessThan(uCut.w)).not();
  node.colorNode = landmarkColor();
  lampLit(node);
});

addPort(/^lamp-pole$/, (node) => { lampLit(node); });
