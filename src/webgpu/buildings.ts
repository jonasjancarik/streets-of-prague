// The buildings in TSL (BUILDING_GLSL, FACADE_GLSL and the body of shadeBuildings in
// shading.ts / facades.ts): roof tiles, slate and gravel, the windows and facade pictures,
// grime, lit windows at night, rain and snow, and the cutaway over the player in a
// passage. Registered as a port of the 'buildings-procedural' material (see addPort).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import {
  Fn, If, Discard, uniformArray, float, int, vec2, vec3, vec4, texture, attribute, vertexColor, positionWorld, normalWorld, diffuseColor,
  materialColor, fract, floor, mod, dot, sin, cos, mix, smoothstep, step, length, abs, max, min, clamp, normalize, dFdx, dFdy, distance, select, cross, sqrt, cameraPosition, reflect, pow, uniform, renderGroup,
} from 'three/tsl';
import { FACADE_ATLAS, FACADE_ON, BLANK, F_BAY as BAY_WIDTH, F_UP as UP, F_DOOR as DOOR, F_WALL as WALL, F_MOD as MOD, F_GROUND as GROUND, F_STOREY as STOREY, STOREY_FIT } from '../facades.ts';
import { WINDOWS, ROOF_DETAIL, ROOF_CLUTTER, LANDMARK_ROOF as R, SUN_DIR, SUN_LIGHT } from '../shading.ts';
import { lampLit } from './lamps.ts';
import { EDGE, EDGE_STEP } from '../map/roofEdges.ts';
import { type N, follow, followColor, addPort, uCut, uDirt, uWet, uSnow, vnoise, fbm, fbm2, blocks, hash12, skyAmbient } from './common.ts';
import { DOME } from '../sky.ts';

const uZenith: N = followColor(DOME.zenith), uHorizon: N = followColor(DOME.horizon);
// Which way the sun (or at night the moon) stands, for the relief of the roofs' tiles and seams.
const uSunDir: N = (() => {
  const u = uniform(SUN_DIR.value.clone()).setGroup(renderGroup);
  u.onRenderUpdate(() => { u.value.copy(SUN_DIR.value); return u.value; });
  return u;
})();
// What a row of tiles or a seam standing a little proud of the roof does to the light: its
// lower edge casts a line of shadow on the row below when the sun stands behind it up the
// slope, and catches the light when the sun stands in front. `n`: the roof's normal;
// `down`: the way down the slope on the map (x east, y north); `along`: 0 at a row's upper
// edge to 1 at its lower one. Returns what to multiply the colour by.
// `lip`: how far the edge stands out, as a share of the row's depth.
const rowRelief = (n: N, down: N, along: N, lip: number): N => {
  // (The way down the slope in the world: level along `down`, dropping by the slope.)
  const flat: N = vec3(down.x, 0, down.y.negate());
  const d3: N = normalize(flat.sub(n.mul(dot(flat, n))));
  const facing: N = dot(uSunDir, d3), onto: N = max(dot(uSunDir, n), 0.12);
  // The shadow's reach down the next row, and the lit edge.
  const reach: N = clamp(facing.negate().div(onto).mul(lip), 0, 0.6);
  const shadow: N = float(1).sub(smoothstep(reach.mul(0.6), reach.add(0.02), along)).mul(step(0.01, reach));
  const lit: N = smoothstep(0.82, 0.97, along).mul(max(facing, 0));
  return float(1).sub(shadow.mul(RELIEF.shade)).add(lit.mul(RELIEF.light));
};
// How dark a tile's edge shadow is and how bright its lit edge, at most.
const RELIEF = { shade: 0.42, light: 0.3 };
const uSunLight: N = followColor(SUN_LIGHT);
const uFacadeOn = follow(FACADE_ON), uWindows = follow(WINDOWS), uRoofDetail = follow(ROOF_DETAIL), uRoofClutter = follow(ROOF_CLUTTER);

// The atlas loads after the first frames: a one-layer stand-in keeps the binding's type.
const standIn = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
standIn.colorSpace = THREE.SRGBColorSpace;
standIn.minFilter = THREE.LinearMipmapLinearFilter; // (filtered, as the atlas is: a nearest texture gets no sampler)
standIn.magFilter = THREE.LinearFilter;
standIn.needsUpdate = true;
const atlas = texture(standIn).onRenderUpdate(() => { atlas.value = FACADE_ATLAS.value ?? standIn; });

// The layer tables of FACADE_GLSL, as uniform arrays. (As arrays in the shader's own
// variables they were filled in again for every pixel of a wall, which on a phone's GPU
// (a Pixel 5's Adreno) cost more than everything else drawn put together.)
const ints = (v: number[]): N => { const a: N = uniformArray(v, 'float'); return { element: (i: N) => int(a.element(i)) }; };
const F_UP = ints(UP);
const F_DOOR = ints(DOOR);
const F_WALL = ints(WALL);
const floats = (v: number[]): N => uniformArray(v, 'float');
const F_BAY = floats(BAY_WIDTH);
const F_MOD = floats(MOD);
const F_GROUND = floats(GROUND), F_STOREY = floats(STOREY);
// Window bays across a wall: none on a party wall or one too short for a window.
const fBays = (f: N) => {
  const style = floor(f.w);
  return select(style.greaterThanEqual(BLANK), float(0), floor(f.z.div(F_BAY.element(min(style, 4).toInt())).add(0.5)));
};

const fHash = (a: N, b: N) => fract(sin(a.mul(127.1).add(b.mul(311.7))).mul(43758.5453));
// The wall's ground floor and its other floors, m, and its building's look (finishWalls in facades.ts).
const fStorey = (f: N) => {
  const style = min(floor(f.w), 4).toInt(), fit = mod(floor(fract(f.w).mul(1024)), 32);
  return vec2(F_GROUND.element(style), F_STOREY.element(style).mul(fit.mul(STOREY_FIT[1] / 31).add(STOREY_FIT[0])));
};
const fLook = (f: N) => min(mod(floor(fract(f.w).mul(32768)), 16), MOD.length - 1).toInt();
const fTwoTone = (f: N) => mod(floor(fract(f.w).mul(2048)), 2);
const LANDMARK_TILE = vec3(...R.rgb);
const luma = (c: N) => dot(c, vec3(0.299, 0.587, 0.114));
// detail() with the pixel's footprint worked out once, outside any branch (derivatives).
const fade = (width: N, cell: number) => float(1).sub(smoothstep(cell * 0.2, cell * 0.7, width));

// Beaver-tail tiles, laid double (beaverTiles in shading.ts): rows without offset, and
// the round ends of a second layer, half a tile over, in the gaps between theirs.
const beaverEnd = (x: N) => {
  const u = fract(x).mul(2).sub(1);
  return float(1).sub(float(1).sub(sqrt(max(0, float(1).sub(u.mul(u))))).mul(0.32));
};
function beaverTiles(c0: N, wp: N, n: N, wpWidth: N) {
  const down = normalize(vec2(n.x, n.z.negate()).add(vec2(0, 0.0001)));
  const q = vec2(dot(wp, vec2(down.y.negate(), down.x)), dot(wp, down).div(max(n.y, 0.3))).div(vec2(0.18, 0.3));
  const row = floor(q.y), fy = fract(q.y);
  const top = step(fy, beaverEnd(q.x)), under = top.oneMinus().mul(step(fy, beaverEnd(q.x.add(0.5))));
  const x = q.x.add(top.oneMinus().mul(0.5));
  const col = floor(x), fx = fract(x);
  const h = hash12(vec2(col, row.mul(2).add(top.oneMinus())));
  const patch = vnoise(vec2(col, row).mul(0.23));
  // (Single tiles differ more than patches of them do: a roof of one colour in broad
  // blotches read as camouflage from above.)
  const t = c0.mul(h.mul(0.36).add(0.78)).mul(float(1.05).sub(smoothstep(0.55, 0.85, patch).mul(0.13))).toVar();
  t.mulAssign(mix(vec3(1.06, 0.97, 0.9), vec3(0.9, 0.94, 1), fract(h.mul(7.3))));
  t.mulAssign(smoothstep(0, 0.6, fy).mul(0.1).add(0.92));
  t.mulAssign(mix(float(1), mix(0.45, 0.72, under), top.oneMinus()));
  t.mulAssign(mix(0.7, 1, smoothstep(0, 0.05, min(fx, fx.oneMinus()))));
  // Each row stands proud of the one below it: lit and shaded by where the sun is.
  t.mulAssign(rowRelief(n, down, fy, 0.16));
  const c = mix(c0.mul(0.95), t, fade(wpWidth, 0.18)).toVar();
  c.mulAssign(fbm(wp.mul(0.22)).mul(0.14).add(0.93));
  return mix(c, c.mul(vec3(0.86, 0.9, 0.8)), smoothstep(0.62, 0.75, fbm(wp.mul(0.09).add(4))).mul(0.45));
}

// Clay tiles, or slate on grey roofs where the material isn't known (`slate` not given).
function roofTiles(c0: N, wp: N, n: N, wpWidth: N, slateGiven?: N) {
  const down = normalize(vec2(n.x, n.z.negate()).add(vec2(0, 0.0001))), across = vec2(down.y.negate(), down.x);
  const slate = slateGiven ?? step(max(c0.r, max(c0.g, c0.b)).sub(min(c0.r, min(c0.g, c0.b))), 0.08);
  const size = mix(vec2(0.26, 0.32), vec2(0.3, 0.22), slate);
  const q = vec2(dot(wp, across), dot(wp, down).div(max(n.y, 0.3)));
  const b = blocks(q, size.x, size.y);
  const row = fract(q.y.div(size.y));
  const d = float(1).sub(smoothstep(size.y.mul(0.2), size.y.mul(0.7), wpWidth));
  const t = c0.mul(b.y.mul(0.2).add(0.9)).toVar();
  t.mulAssign(mix(vec3(1.07, 0.95, 0.86), vec3(0.95, 1, 1.05), fract(b.y.mul(7.3))));
  t.mulAssign(smoothstep(0, 0.4, row).mul(0.16).add(0.86));
  t.assign(mix(t.mul(0.76), t, smoothstep(0, 0.012, b.x)));
  t.mulAssign(rowRelief(n, down, row, 0.14));
  const c = mix(c0.mul(0.95), t, d).toVar();
  c.mulAssign(fbm(wp.mul(0.22)).mul(0.16).add(0.92));
  return mix(c, c.mul(vec3(0.86, 0.9, 0.8)), smoothstep(0.62, 0.75, fbm(wp.mul(0.09).add(4))).mul(0.45));
}
// Sheet metal and copper (sheetRoof in shading.ts): pans between thin standing seams,
// each pan a shade of its own and laid in sheets of about 2.4 m down the slope, now and
// then one replaced or gone rusty (not on copper), so that a roof of it reads as metal
// from the game's height and not as a bare grey plate; a broad soft sheen, verdigris on
// copper.
function sheetRoof(c0: N, wp: N, n: N, wpWidth: N, copper: N) {
  const down = normalize(vec2(n.x, n.z.negate()).add(vec2(0, 0.0001)));
  const a = dot(wp, vec2(down.y.negate(), down.x)).div(0.6);
  const b = dot(wp, down).div(2.4);
  const seam = fract(a);
  const pan = fract(sin(floor(a).mul(12.9898)).mul(43758.5453));
  const sheet = fract(sin(floor(a).mul(78.233).add(floor(b).mul(37.719))).mul(43758.5453));
  const tone = c0.mul(pan.mul(0.09).add(0.92)).toVar();
  const odd = float(1).sub(copper);
  tone.assign(mix(tone, tone.mul(1.12), step(0.93, sheet).mul(step(sheet, 0.97)).mul(odd)));
  tone.assign(mix(tone, tone.mul(vec3(1.02, 0.8, 0.62)), step(0.97, sheet).mul(odd)));
  // A standing seam is a rib 3 cm high: its side towards the sun is lit, and it lays a
  // thin shadow on the pan beyond it.
  const acrossMap: N = vec2(down.y.negate(), down.x), rib: N = dot(uSunDir, vec3(acrossMap.x, 0, acrossMap.y.negate()));
  const t = tone.mul(float(1).add(float(1).sub(smoothstep(0, 0.035, seam)).mul(0.07)).sub(smoothstep(0.94, 1, seam).mul(0.06))).toVar();
  t.mulAssign(float(1).add(float(1).sub(smoothstep(0.02, 0.07, seam)).mul(max(rib, 0)).mul(0.3)).sub(smoothstep(0.84, 0.97, seam).mul(max(rib, 0)).mul(0.28)));
  t.mulAssign(float(1).add(smoothstep(0.93, 0.98, seam).mul(max(rib.negate(), 0)).mul(0.3)).sub(float(1).sub(smoothstep(0.03, 0.16, seam)).mul(max(rib.negate(), 0)).mul(0.28)));
  t.assign(mix(t, t.mul(vec3(0.82, 1.1, 1.02)).add(vec3(0.02, 0.06, 0.05)), copper.mul(smoothstep(0.45, 0.8, fbm(wp.mul(0.25)))).mul(0.7)));
  const sheen = fbm(wp.mul(0.04)).mul(0.1).add(0.95);
  return mix(mix(c0, tone, fade(wpWidth, 0.6)), t, fade(wpWidth, 0.3)).mul(sheen);
}
// A mansard's steep lower slope (mansardWindows in shading.ts): a window in every bay of
// about 3.2 m in a light frame.
function mansardGlass(f: N, grow: number) {
  const bays = max(1, floor(f.z.div(3.2).add(0.5)));
  const bay = fract(f.x.div(f.z).mul(bays)).mul(f.z).div(bays), half = f.z.div(bays).mul(0.5);
  return step(abs(bay.sub(half)), 0.45 + grow).mul(step(0.6 - grow, f.y)).mul(step(f.y, 1.9 + grow));
}
function mansardWindows(c: N, f: N) {
  return mix(mix(c, vec3(0.74, 0.72, 0.68), mansardGlass(f, 0.08)), vec3(0.16, 0.19, 0.23), mansardGlass(f, 0));
}
// A roof window (roofWindow in shading.ts): a grey metal frame round glass that shows
// more sky towards the top.
function roofGlass(f: N) {
  return step(0.1, min(min(f.x, f.x.oneMinus()), min(f.y, f.y.oneMinus())));
}
function roofWindow(f: N) {
  return mix(vec3(0.42, 0.4, 0.38), mix(vec3(0.12, 0.15, 0.19), vec3(0.3, 0.36, 0.43), f.y), roofGlass(f));
}
// A flat roof's own axes (roofAxes in shading.ts; map/roofEdges.ts puts its grain in w's
// fraction).
function roofAxes(wp: N, w: N) {
  const a = fract(w).mul(3.4906585), g = vec2(cos(a), sin(a));
  return vec2(dot(wp, g), dot(wp, vec2(g.y.negate(), g.x)));
}
// Sun-bleached patches and stains where rain stood (flatAge in shading.ts).
function flatAge(c: N, wp: N, wpWidth: N, seed: N) {
  const t = c.mul(fbm2(wp.mul(0.045).add(seed.mul(31))).mul(0.2).add(0.9));
  const pond = fbm2(wp.mul(0.16).add(seed.mul(17)));
  const rim = smoothstep(0.57, 0.61, pond).sub(smoothstep(0.61, 0.67, pond));
  return t.mul(float(1).sub(smoothstep(0.6, 0.66, pond).mul(0.08)).sub(rim.mul(0.08).mul(fade(wpWidth, 0.4))));
}
// Gravel, or not known (flatRoof in shading.ts).
function flatRoof(c: N, wp: N, wpWidth: N, seed: N) {
  const t = c.mul(fbm(wp.mul(0.5)).mul(0.22).add(0.86)).toVar();
  t.mulAssign(float(1).add(vnoise(wp.mul(7)).sub(0.5).mul(0.22).mul(fade(wpWidth, 0.15))).add(vnoise(wp.mul(23).add(5)).sub(0.5).mul(0.2).mul(fade(wpWidth, 0.05))));
  t.assign(mix(t, t.mul(0.62), smoothstep(0.64, 0.74, fbm2(wp.mul(0.35).add(seed.mul(7)))).mul(0.6)));
  return flatAge(t, wp, wpWidth, seed);
}
// Bitumen rolls with their laps, and patches over old repairs (bitumenRoof in shading.ts).
function bitumenRoof(c: N, wp: N, q: N, wpWidth: N, seed: N) {
  const row = floor(q.y), along = q.x.div(8).add(hash12(vec2(row, seed.mul(91))));
  const t = c.mul(hash12(vec2(row, floor(along)).add(seed.mul(13))).mul(0.18).add(0.91)).toVar();
  const s = fract(q.y), e = fract(along).mul(8);
  t.mulAssign(float(1).sub(float(1).sub(smoothstep(0.02, 0.08, s)).mul(0.3)).add(smoothstep(0.08, 0.14, s).mul(float(1).sub(smoothstep(0.14, 0.3, s))).mul(0.06)));
  t.mulAssign(float(1).sub(float(1).sub(smoothstep(0, 0.05, min(e, float(8).sub(e)))).mul(0.12)));
  t.assign(mix(c, t, fade(wpWidth, 0.4)));
  const cq: N = q.div(vec2(5, 4)).add(seed.mul(3.7)), id: N = floor(cq), f: N = fract(cq);
  const hx = hash12(id), hy = hash12(id.add(7.3)), hz = hash12(id.add(19.1));
  const lo = vec2(hx, hy).mul(0.3).add(0.1), hi = min(lo.add(0.25).add(vec2(hy, hz).mul(0.3)), 0.95);
  const inside = step(lo.x, f.x).mul(step(lo.y, f.y)).mul(step(f.x, hi.x)).mul(step(f.y, hi.y)).mul(step(0.78, hz));
  const around = step(lo.x.sub(0.015), f.x).mul(step(lo.y.sub(0.015), f.y)).mul(step(f.x, hi.x.add(0.015))).mul(step(f.y, hi.y.add(0.015))).mul(step(0.78, hz)).sub(inside);
  t.assign(mix(t, mix(vec3(luma(c)), c, 0.6).mul(vnoise(wp.mul(3)).mul(0.08).add(0.84)), inside.mul(fade(wpWidth, 1))));
  t.assign(mix(t, c.mul(1.18), around.mul(0.7).mul(fade(wpWidth, 0.3))));
  t.mulAssign(float(1).add(vnoise(wp.mul(25)).sub(0.5).mul(0.1).mul(fade(wpWidth, 0.05))));
  return flatAge(t, wp, wpWidth, seed);
}
// A membrane in two-metre sheets with paler welds, and dirt (membraneRoof in shading.ts).
function membraneRoof(c: N, wp: N, q: N, wpWidth: N, seed: N) {
  const s = fract(q.y.div(2));
  const t = c.mul(float(1).add(float(1).sub(smoothstep(0.01, 0.035, s)).mul(0.1)).sub(smoothstep(0.98, 1, s).mul(0.06))).toVar();
  t.assign(mix(c, t, fade(wpWidth, 0.3)).mul(vnoise(wp.mul(1.3)).mul(0.1).add(0.95)));
  t.assign(mix(t, t.mul(vec3(0.72, 0.7, 0.66)), smoothstep(0.55, 0.75, fbm2(wp.mul(0.22).add(seed.mul(5)))).mul(0.6)));
  return flatAge(t, wp, wpWidth, seed);
}
// Sedum mats (plantedRoof in shading.ts).
function plantedRoof(c: N, wp: N, wpWidth: N) {
  const d1 = fade(wpWidth, 0.3), d2 = fade(wpWidth, 0.1);
  const grow = smoothstep(0.35, 0.7, fbm2(wp.mul(0.12).add(3)));
  const t = mix(c.mul(vec3(1.1, 0.88, 0.7)), c.mul(vec3(0.95, 1.25, 0.72)), grow).toVar();
  t.mulAssign(fbm2(wp.mul(0.7).add(9)).mul(0.3).add(0.82));
  t.mulAssign(mix(0.5, vnoise(wp.mul(2.6)), d1).mul(0.3).add(0.85));
  t.mulAssign(float(1).add(vnoise(wp.mul(9).add(3.1)).sub(0.5).mul(0.25).mul(d2)));
  t.assign(mix(t, c.mul(vec3(1.25, 1.45, 0.75)), smoothstep(0.76, 0.86, vnoise(wp.mul(4.1).add(19))).mul(0.55).mul(d1)));
  t.assign(mix(t, c.mul(vec3(1.35, 0.95, 0.75)), smoothstep(0.8, 0.88, vnoise(wp.mul(3.7).add(41))).mul(0.45).mul(d1)));
  return mix(t, c.mul(vec3(1.7, 1.6, 1.3)).add(0.02), smoothstep(0.83, 0.9, vnoise(wp.mul(5.3).add(7))).mul(0.5).mul(d1));
}
// Glass over an atrium (glassRoof in shading.ts).
function glassRoof(c: N, wp: N, q: N, wpWidth: N) {
  const cs = vec2(1.5, 3), cq: N = q.div(cs), f: N = fract(cq), e: N = min(f, f.oneMinus()).mul(cs);
  const pane = c.mul(hash12(floor(cq)).mul(0.3).add(0.85)).add(vec3(0.02, 0.03, 0.04).mul(f.y));
  const bar = float(1).sub(smoothstep(0.015, 0.035, min(e.x, e.y)));
  return mix(c, mix(pane, mix(c, vec3(0.3, 0.32, 0.34), 0.7), bar.mul(0.7)), fade(wpWidth, 0.5));
}
// darkRoofAs in shading.ts: 2 glass, 1 planted, 0 bitumen after all.
function darkRoofAs(c: N) {
  const hi = max(c.r, max(c.g, c.b)), sat = hi.sub(min(c.r, min(c.g, c.b))).div(max(hi, 1e-3));
  return select(sat.lessThan(0.4), float(0), select(c.b.greaterThan(c.r.mul(1.3)).and(c.b.greaterThanEqual(c.g)), float(2), float(1)));
}
function pavingRoof(c: N, wp: N, wpWidth: N) {
  const b = blocks(wp, float(0.5), float(0.5));
  const t = c.mul(b.y.mul(0.12).add(0.93)).toVar();
  t.assign(mix(t.mul(0.72), t, smoothstep(0, 0.02, b.x)));
  return mix(c, t, fade(wpWidth, 0.5)).mul(fbm(wp.mul(0.2)).mul(0.12).add(0.93));
}

// Age on top of any roof colour (roofWeather in shading.ts): moss in clumps, more on the
// shaded north slopes, dark streaks running down from the ridge, and stains. A building's
// number comes from its colour. Flat roofs get only a little.
// more: 0-1, thicker moss (ROOF_CLUTTER, on clay tiles).
function roofWeather(c: N, c0: N, wp: N, n: N, wpWidth: N, more: N = float(0)) {
  const seed = fract(sin(dot(c0, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
  const age = smoothstep(0.2, 0.9, fract(seed.mul(7.3).add(vnoise(wp.mul(0.02)).mul(0.35)))).mul(0.75).add(0.25);
  const flat = smoothstep(0.85, 0.97, n.y);
  const down = normalize(vec2(n.x, n.z.negate()));
  const s = vec2(dot(wp, vec2(down.y.negate(), down.x)), dot(wp, down));
  const north = down.y.mul(0.5).add(0.5);
  const d = fade(wpWidth, 0.3);
  const clump = fbm2(wp.mul(0.35).add(seed.mul(40)));
  const moss = smoothstep(float(0.5).sub(more.mul(0.13)), 0.72, clump.add(north.sub(0.5).mul(more.mul(0.12).add(0.18)))).mul(mix(age, 1, more.mul(0.4))).mul(mix(0.9, 0.2, flat)).mul(d);
  const m = mix(c, c.mul(vec3(0.62, 0.82, 0.42)).add(vec3(0.01, 0.03, 0)), moss.mul(more.mul(0.13).add(0.75)));
  const streak = smoothstep(0.5, 0.85, vnoise(vec2(s.x.mul(2.2).add(seed.mul(50)), s.y.mul(0.1))));
  const dark = float(1).sub(streak.mul(0.22).mul(age).mul(float(1).sub(flat)).mul(d));
  const stain = float(1).sub(flat.mul(0.1).mul(age).mul(smoothstep(0.5, 0.8, fbm2(wp.mul(0.12).add(seed.mul(9))))));
  return m.mul(dark).mul(stain);
}

// The edges of a roof's faces (map/roofEdges.ts: the facade attribute's x, y and z, each a
// distance from one edge of the triangle plus EDGE_STEP times what the edge is). On a pitched
// roof: a row of lighter ridge tiles bedded in mortar along ridges and hips, with the tiles
// below them a little lighter where rain washes them; valleys lined with sheet metal and
// darker either side, where leaves and moss gather; a gutter along the eaves; a metal trim up
// the verges; flashing and dirt where the roof meets a wall above it. On a flat roof: a kerb
// with a metal coping round it, and the dirt that collects inside it.
// `w`: metres a pixel. Each line fades by how much of the pixel it covers.
function roofLines(c0: N, f: N, n: N, w: N) {
  const kind: N = floor(f.xyz.add(0.01).div(EDGE_STEP)), d: N = max(f.xyz.sub(kind.mul(EDGE_STEP)), 0);
  const far = float(50);
  const near = (k: number): N => min(min(select(abs(kind.x.sub(k)).lessThan(0.5), d.x, far), select(abs(kind.y.sub(k)).lessThan(0.5), d.y, far)), select(abs(kind.z.sub(k)).lessThan(0.5), d.z, far));
  const aa: N = max(w, 0.02);
  const cover = (x: N, width: number): N => clamp(min(x.add(aa.mul(0.5)), width).sub(max(x.sub(aa.mul(0.5)), 0)).div(aa), 0, 1);
  const ridge = near(EDGE.ridge), valley = near(EDGE.valley), eave = near(EDGE.eave), verge = near(EDGE.verge), wall = near(EDGE.wall);
  const c = c0.toVar();
  If(n.y.greaterThan(0.97), () => {
    const kerb = min(eave, verge);
    c.mulAssign(mix(0.8, 1, smoothstep(0.3, 0.9, kerb)));
    c.assign(mix(c, mix(c, vec3(0.2, 0.2, 0.19), 0.75), cover(kerb, 0.3)));
    c.assign(mix(c, vec3(0.33, 0.33, 0.32), cover(kerb, 0.09).mul(0.6)));
    c.mulAssign(mix(0.66, 1, smoothstep(0, 0.9, wall)));
  }).Else(() => {
    c.mulAssign(float(1).add(float(1).sub(smoothstep(0.15, 1.1, ridge)).mul(0.07)));
    c.assign(mix(c, c.mul(1.28).add(0.02), cover(ridge, 0.15)));
    c.mulAssign(mix(0.72, 1, smoothstep(0, 0.85, valley)));
    c.assign(mix(c, vec3(0.1, 0.105, 0.11), cover(valley, 0.09).mul(0.7)));
    c.mulAssign(mix(0.84, 1, smoothstep(0.1, 0.65, eave)));
    c.assign(mix(c, vec3(0.085, 0.085, 0.09), cover(eave, 0.13).mul(0.85)));
    c.assign(mix(c, c.mul(0.5).add(vec3(0.11, 0.11, 0.115)), cover(verge, 0.12).mul(0.75)));
    c.mulAssign(mix(0.68, 1, smoothstep(0, 0.7, wall)));
    c.assign(mix(c, vec3(0.16, 0.165, 0.17), cover(wall, 0.1).mul(0.6)));
  });
  return c;
}

function facadeWalls(c: N, f: N, bayWidth: N, fWidth: N) {
  const along = f.x, h = f.y, st = fStorey(f);
  const bay = fract(along.div(bayWidth)), storey = fract(h.sub(st.x).div(st.y));
  const upper = step(st.x, h);
  const win = step(0.3, bay).mul(step(bay, 0.7)).mul(step(0.3, storey)).mul(step(storey, 0.78)).mul(upper);
  const shop = step(0.12, bay).mul(step(bay, 0.88)).mul(step(0.6, h)).mul(step(h, st.x.sub(0.7))).mul(float(1).sub(upper));
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

// The picture for a bay and storey, from the atlas's layer, with the wall's plaster
// colour; the module in the middle of the bay, its plaster edge drawn on across the piers.
function facadeModules(wall: N, f: N, bays: N, fdx: N, fdy: N) {
  const style = floor(f.w).toInt(), seed = fract(f.w).mul(97), st = fStorey(f);
  const look = fLook(f).toVar();
  // (toVar: declared here, before the branches below. Left to TSL, `q` was worked out inside the
  // upper floors' branch only, and a ground floor read it unset: every pixel of it took the module's
  // top left corner, plain plaster, so ground floors and whole low buildings had no doors or windows.)
  const q = vec2(f.x.div(f.z).mul(bays), select(f.y.lessThan(st.x), clamp(f.y.div(st.x), 0, 0.999), f.y.sub(st.x).div(st.y))).toVar();
  const cell = floor(q).toVar(), uv = fract(q);
  const bay: N = f.z.div(bays), mw: N = min(F_MOD.element(look), bay);
  const u: N = clamp(uv.x.sub(0.5).mul(bay).div(mw).add(0.5), 0.016, 0.984);
  const layer = int(0).toVar();
  If(f.y.lessThan(st.x), () => {
    const r = fHash(seed, cell.x);
    If(r.lessThan(0.18), () => { layer.assign(F_DOOR.element(look.mul(3).add(r.div(0.18).mul(3).toInt()))); })
      .Else(() => { layer.assign(F_WALL.element(look.mul(4).add(fHash(cell.x, seed).mul(4).toInt()))); });
  }).Else(() => {
    // Panel blocks by the column, the rest by the floor (FACADE_GLSL).
    const byColumn = look.equal(3).or(look.equal(10));
    layer.assign(F_UP.element(look.mul(6).add(fHash(seed, select(byColumn, cell.x.add(50), cell.y.add(7))).mul(6).toInt())));
  });
  const k = vec2(float(1).div(mw), float(1).div(st.y));
  const tm = atlas.sample(vec2(u, float(1).sub(uv.y))).depth(layer).grad(fdx.xy.mul(k), fdy.xy.mul(k));
  const t = tm.rgb;
  const plaster = mix(wall, mix(wall, vec3(0.85, 0.79, 0.67), 0.6), tm.a.mul(fTwoTone(f)));
  const hi = max(t.r, max(t.g, t.b)), sat = hi.sub(min(t.r, min(t.g, t.b))).div(max(hi, 1e-3));
  return mix(t, t.mul(plaster).div(0.55), float(1).sub(smoothstep(0.08, 0.2, sat)));
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
  const base = c.toVar();
  // Flat roofs by their material (tileWorker.ts: the facade attribute's w on roofs;
  // 5-9 flat ones, 0 not known), unless it says it's a shallow roof of tiles or metal.
  const roofWin = abs(f.w.sub(10)).lessThan(0.5).and(bn.y.greaterThan(0.15));
  If(roofWin, () => { c.assign(roofWindow(f)); }).ElseIf(bn.y.greaterThan(0.97).and(f.w.lessThan(0.5).or(f.w.greaterThan(4.5))), () => {
    If(uRoofDetail.greaterThan(0.5), () => {
      const m = floor(f.w.add(0.001)).toVar();
      const seed = fract(sin(dot(base, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
      const q = roofAxes(bwp, f.w);
      const r = vec3(0).toVar();
      If(m.greaterThan(4.5).and(m.lessThan(5.5)), () => {
        const as = darkRoofAs(base);
        m.assign(select(as.greaterThan(1.5), float(10), select(as.greaterThan(0.5), float(8), m)));
      });
      // Membrane and gravel measured off the photos come out nearly white; real ones reflect less.
      If(m.greaterThan(5.5).and(m.lessThan(7.5)), () => { base.mulAssign(min(float(1), float(0.17).div(max(luma(base), 0.01)))); });
      // Photos make sheets and gravel more coloured than they are.
      If(m.lessThan(7.5), () => { base.assign(mix(vec3(luma(base)), base, 0.75)); });
      If(m.greaterThan(9.5), () => { r.assign(glassRoof(base, bwp, q, wpWidth)); })
        .ElseIf(m.greaterThan(8.5), () => { r.assign(pavingRoof(base, bwp, wpWidth)); })
        .ElseIf(m.greaterThan(7.5), () => { r.assign(plantedRoof(base, bwp, wpWidth)); })
        .ElseIf(m.greaterThan(5.5).and(m.lessThan(6.5)), () => { r.assign(membraneRoof(base, bwp, q, wpWidth, seed)); })
        .ElseIf(m.greaterThan(4.5).and(m.lessThan(5.5)), () => { r.assign(bitumenRoof(base, bwp, q, wpWidth, seed)); })
        .Else(() => { r.assign(flatRoof(base, bwp, wpWidth, seed)); });
      c.assign(roofLines(roofWeather(r, base, bwp, bn, wpWidth), f, bn, wpWidth));
    });
  }).ElseIf(bn.y.greaterThan(0.15), () => {
    If(uRoofDetail.greaterThan(0.5), () => {
      // The roof's material (tileWorker.ts: the facade attribute's w on roofs).
      const m = f.w;
      If(m.greaterThan(2.5).and(m.lessThan(4.5)), () => { c.assign(roofWeather(sheetRoof(base, bwp, bn, wpWidth, step(3.5, m)), base, bwp, bn, wpWidth)); })
        .ElseIf(m.greaterThan(0.5).and(m.lessThan(1.5)), () => { c.assign(roofWeather(beaverTiles(base, bwp, bn, wpWidth), base, bwp, bn, wpWidth, uRoofClutter)); })
        .ElseIf(m.greaterThan(1.5).and(m.lessThan(2.5)), () => { c.assign(roofWeather(roofTiles(base, bwp, bn, wpWidth, float(1)), base, bwp, bn, wpWidth)); })
        .Else(() => {
          // Not known: slate where grey, else clay tiles.
          const grey = max(base.r, max(base.g, base.b)).sub(min(base.r, min(base.g, base.b))).lessThan(0.08);
          If(grey, () => { c.assign(roofWeather(roofTiles(base, bwp, bn, wpWidth, float(1)), base, bwp, bn, wpWidth)); })
            .Else(() => { c.assign(roofWeather(beaverTiles(base, bwp, bn, wpWidth), base, bwp, bn, wpWidth)); });
        });
      If(bn.y.lessThan(0.5), () => { If(f.z.greaterThan(0.1), () => { c.assign(mansardWindows(c, f)); }); })
        .Else(() => { c.assign(roofLines(c, f, bn, wpWidth)); });
    });
  }).Else(() => {
    const bays = fBays(f).toVar();
    If(bays.lessThan(0.5), () => {
      // A party wall: bare plaster, as bright as the modules' plaster (drawn about .45 grey).
      c.mulAssign(vnoise(f.xy.mul(vec2(0.9, 0.6))).mul(0.06).add(0.77));
    }).ElseIf(uFacadeOn.greaterThan(0.5).and(f.z.greaterThan(0.1)), () => { c.assign(facadeModules(c, f, bays, fdx, fdy)); })
      .Else(() => { c.assign(facadeWalls(c, f.xy, f.z.div(bays), fWidth)); });
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

// A lit room behind a window, without any geometry: the pixel's ray is followed from the
// glass into a box as wide as the bay, as high as the storey and ROOM_DEPTH deep, and what
// it meets first is what shows: the ceiling with the lamp's glow on it, the walls, the back
// wall with a darker dado, or the floor. Looking along a street the rooms slide behind their
// windows; from above one sees down onto their floors by the sill. Some windows have a
// blind half down (`pick`, the window's own number). Returns how bright, round 1.
// `at`: where in the bay and storey (0-1); `size`: theirs in metres; `along`: the wall's
// direction in the world; `ray`: from the eye; `n`: the wall's normal.
const ROOM_DEPTH = 4.2;
const room = (at: N, size: N, along: N, ray: N, n: N, pick: N): N => {
  const d: N = vec3(dot(ray, along), ray.y, max(dot(ray, n).negate(), 0.02)).toVar();
  const p: N = at.mul(size);
  const tx: N = select(d.x.greaterThan(0), size.x.sub(p.x), p.x.negate()).div(select(abs(d.x).lessThan(1e-4), float(1e-4), d.x));
  const ty: N = select(d.y.greaterThan(0), size.y.sub(p.y), p.y.negate()).div(select(abs(d.y).lessThan(1e-4), float(1e-4), d.y));
  const tz: N = float(ROOM_DEPTH).div(d.z);
  const t: N = min(min(tx, ty), tz).toVar();
  const hit: N = vec3(p, 0).add(d.mul(t)).toVar();
  const deep: N = hit.z.div(ROOM_DEPTH);
  // The back wall (with a darker dado and a door or a picture on it, by the window's number),
  // a side wall, or the floor or ceiling, by which was met first; each in its own colour.
  const across: N = hit.x.div(size.x), up: N = hit.y.div(size.y);
  const thing: N = step(abs(across.sub(mix(0.25, 0.75, fract(pick.mul(5.7))))), 0.11).mul(step(up, mix(0.55, 0.78, fract(pick.mul(3.1))))).mul(step(mix(0.02, 0.4, step(0.5, fract(pick.mul(9.3)))), up));
  const back: N = vec3(0.8, 0.74, 0.62).mul(mix(0.6, 1, smoothstep(0.3, 0.34, up))).mul(mix(1, 0.45, thing));
  const side: N = vec3(0.6, 0.55, 0.46);
  const glow: N = float(1.5).sub(length(vec2(hit.x.sub(size.x.mul(0.5)), hit.z.sub(ROOM_DEPTH * 0.45))).mul(0.4)).max(0.7);
  const flat: N = select(d.y.greaterThan(0), vec3(0.95, 0.93, 0.88).mul(glow), vec3(0.36, 0.25, 0.16));
  const surface: N = select(tz.lessThanEqual(t.add(1e-3)), back, select(tx.lessThanEqual(t.add(1e-3)), side, flat));
  const lit: N = surface.mul(mix(1.1, 0.6, deep));
  // A blind half down: the upper part of the window a plain bright sheet.
  const blind: N = step(pick, 0.28).mul(step(mix(0.45, 0.75, fract(pick.mul(17.3))), at.y));
  return mix(lit, vec3(0.85, 0.8, 0.7), blind);
};

// Lit windows at night: dark glass above the ground floor, in a share of the windows by
// the time; shop windows at street level the same.
const windowGlow = Fn(() => {
  const g = vec3(0).toVar();
  const bn = normalWorld.normalize().toVar(), f = attribute('facade', 'vec4').toVar();
  const bays = fBays(f).toVar();
  // Which way along the wall its `x` grows, in the world, and the ray from the eye, for the
  // rooms behind lit windows. (Derivatives must be taken outside branches that differ from
  // pixel to pixel; a branch on a uniform is allowed, so by day none of this is worked out.)
  const along: N = vec3(1, 0, 0).toVar(), eye: N = vec3(0, -1, 0).toVar();
  If(uWindows.greaterThan(0.005), () => {
    const wall0: N = vec3(bn.z, 0, bn.x.negate());
    const dwx: N = dFdx(positionWorld), dwy: N = dFdy(positionWorld), dfx: N = dFdx(f.x), dfy: N = dFdy(f.x);
    const turned: N = (dot(wall0, dwx) as N).mul(dfx).add((dot(wall0, dwy) as N).mul(dfy));
    along.assign(wall0.mul(select(turned.lessThan(0), float(-1), float(1))));
    eye.assign(normalize(positionWorld.sub(cameraPosition)));
  });
  If(uWindows.greaterThan(0.005).and(bn.y.lessThan(0.15)).and(f.z.greaterThan(0.1)).and(bays.greaterThan(0.5)), () => {
    const st = fStorey(f);
    const cell = vec2(floor(f.x.div(f.z).mul(bays)), floor(f.y.sub(st.x).div(st.y)));
    const lit = step(fHash(cell.x.add(fract(f.w).mul(97)), cell.y), uWindows.mul(select(f.y.lessThan(st.x), 1.6, 1)));
    const dark = float(1).sub(smoothstep(0.13, 0.22, luma(diffuseColor.rgb).div(max(luma(vertexColor().rgb), 0.02))));
    // Upper floors: only the bluish glass, not the dark shadowed mouldings and sills round it.
    const glass = select(f.y.lessThan(st.x), dark, dark.mul(smoothstep(1.03, 1.12, diffuseColor.b.div(max(diffuseColor.r, 0.01)))));
    const lamp: N = mix(vec3(1, 0.62, 0.3), vec3(1, 0.8, 0.55), fHash(cell.y, cell.x));
    // The room behind the glass, where the detail is on (ROOF_DETAIL: not on Lowest).
    const ground: N = f.y.lessThan(st.x);
    const inBay: N = vec2(fract(f.x.div(f.z).mul(bays)), select(ground, clamp(f.y.div(st.x), 0, 1), fract(f.y.sub(st.x).div(st.y))));
    const seen: N = select(uRoofDetail.greaterThan(0.5), room(inBay, vec2(f.z.div(bays), select(ground, st.x, st.y)), along, eye, bn, fHash(cell.x.add(3.7), cell.y.add(fract(f.w).mul(31)))).mul(0.78), vec3(1));
    g.assign(lamp.mul(lit).mul(glass).mul(0.55).mul(seen));
  }).ElseIf(uWindows.greaterThan(0.005).and(abs(f.w.sub(10)).lessThan(0.5)).and(bn.y.greaterThan(0.15)), () => {
    // Roof windows (roofGlass).
    const w = positionWorld;
    const lit = step(fHash(floor(w.x.mul(0.7)), floor(w.z.mul(0.7))), uWindows.mul(0.6));
    g.assign(mix(vec3(1, 0.62, 0.3), vec3(1, 0.8, 0.55), fHash(floor(w.z), float(3))).mul(lit).mul(roofGlass(f)).mul(0.45));
  }).ElseIf(uWindows.greaterThan(0.005).and(bn.y.greaterThan(0.15)).and(bn.y.lessThan(0.5)).and(f.z.greaterThan(0.1)), () => {
    // A mansard's windows (mansardGlass).
    const cell = floor(f.x.div(f.z).mul(max(1, floor(f.z.div(3.2).add(0.5)))));
    const lit = step(fHash(cell.add(f.z.mul(0.37)), float(7)), uWindows);
    g.assign(mix(vec3(1, 0.62, 0.3), vec3(1, 0.8, 0.55), fHash(float(7), cell)).mul(lit).mul(mansardGlass(f, 0)).mul(0.55));
  });
  // Glints: a roof window's glass and a metal roof's pans flash the sun at you where they
  // happen to lean half-way between it and your eye, so as the view moves over the roofs
  // now one flashes, now another. (Not where a taller house shades them: the map of the
  // sun's shadows isn't asked here, and such roofs are few.)
  If(bn.y.greaterThan(0.15), () => {
    const m: N = f.w, glass: N = abs(m.sub(10)).lessThan(0.5), metal: N = m.greaterThan(2.5).and(m.lessThan(4.5));
    If(glass.or(metal), () => {
      const toEye: N = normalize(cameraPosition.sub(positionWorld));
      // (A metal roof isn't flat: each of its sheets leans a little its own way. The sheets are
      // sheetRoof's: pans 0.6 m wide between the standing seams, 2.4 m long down the slope, so
      // a glint is a long strip running with the seams, never a square across them.)
      const down: N = normalize(vec2(bn.x, bn.z.negate()).add(vec2(0, 0.0001))), wp: N = vec2(positionWorld.x, positionWorld.z.negate());
      const strip: N = floor(dot(wp, vec2(down.y.negate(), down.x)).div(0.6)), sheet: N = floor(dot(wp, down).div(2.4));
      const pan: N = fHash(strip, sheet.mul(0.37).add(strip.mul(1.7))).sub(0.5), turn: N = fHash(sheet, strip.add(5.3)).sub(0.5);
      const lean: N = normalize(bn.add(vec3(pan, 0, turn).mul(select(glass, 0.02, 0.09))));
      const flash: N = pow(max(dot(reflect(uSunDir.negate(), lean), toEye), 0), select(glass, 220, 70));
      g.addAssign(uSunLight.mul(flash).mul(select(glass, roofGlass(f).mul(1.6), float(0.22))));
    });
  });
  // The sky in the window panes, seen from the street: more of it the flatter you look along
  // the wall, each window a slightly different patch of it (no two panes are quite in one
  // plane), less where the street is narrow and the houses opposite fill the glass. From
  // above a pane mirrors the street below, which is dark: nothing is added.
  If(bn.y.lessThan(0.15).and(f.z.greaterThan(0.1)).and(bays.greaterThan(0.5)), () => {
    const st = fStorey(f);
    const cell = vec2(floor(f.x.div(f.z).mul(bays)), floor(f.y.sub(st.x).div(st.y)));
    const dark = float(1).sub(smoothstep(0.13, 0.22, luma(diffuseColor.rgb).div(max(luma(vertexColor().rgb), 0.02))));
    const glass = select(f.y.lessThan(st.x), dark, dark.mul(smoothstep(1.03, 1.12, diffuseColor.b.div(max(diffuseColor.r, 0.01)))));
    const view: N = normalize(cameraPosition.sub(positionWorld)), facing: N = max(dot(view, bn), 0);
    const up: N = reflect(view.negate(), bn).y.add(fHash(cell.x.add(fract(f.w).mul(53)), cell.y).sub(0.5).mul(0.22));
    const fresnel: N = pow(float(1).sub(facing), 4).mul(0.85).add(0.045);
    const sky: N = mix(uHorizon, uZenith, smoothstep(0, 1.2, up));
    g.addAssign(sky.mul(fresnel).mul(smoothstep(-0.04, 0.2, up)).mul(glass).mul(mix(0.3, 1, attribute('sky', 'float'))));
  });
  return g;
});

// These nodes describe the layout, not a tile. Material colour and the sky vertex
// attribute are resolved for each mesh when the shared graph is built.
const buildingGraph = {
  color: buildingColor(),
  glow: windowGlow(),
  ambient: skyAmbient(attribute('sky', 'float')),
};
const cutMask = positionWorld.y.greaterThan(uCut.y).and(distance(positionWorld.xz, uCut.xz).lessThan(uCut.w)).not();

addPort(/^buildings-procedural$/, (node) => {
  node.vertexColors = false; // the colour node multiplies the vertex colour in itself
  node.colorNode = buildingGraph.color;
  node.emissiveNode = buildingGraph.glow;
  // Lower walls that look onto a narrow street or a courtyard get less of the sky's light, never less sun or lamplight.
  node.aoNode = buildingGraph.ambient;
  lampLit(node, positionWorld, true);
});

// The same hole in the landmarks, trees and the ground's depth pass (cutAway in shading.ts).
addPort(/^cut-/, (node, legacy) => {
  node.maskNode = cutMask;
  // (A landmark is floodlit to its top: lampLight's `tall`.)
  lampLit(node, positionWorld, false, /landmark/.test(legacy.customProgramCacheKey()));
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
  const roofFace = smoothstep(R.face[0], R.face[1], up.y).mul(float(1).sub(smoothstep(R.flat[0], R.flat[1], up.y)));
  const reddish = step(max(c.g, c.b), c.r.add(0.01));
  const warm = max(smoothstep(R.sat[0], R.sat[1], sat).mul(float(1).sub(smoothstep(R.hue[0], R.hue[1], hue))), float(1).sub(smoothstep(R.black[0], R.black[1], luma(c)))).mul(reddish).mul(roofFace);
  If(uRoofDetail.greaterThan(0.5), () => {
    const tile = roofTiles(LANDMARK_TILE.mul(clamp(luma(c).div(R.light), R.minLight, R.maxLight)), bwp, up, wpWidth);
    c.assign(mix(c, tile, warm));
  });
  return c;
});
const landmarkGraph = landmarkColor();
addPort(/^landmark-roof$/, (node) => {
  node.maskNode = cutMask;
  node.colorNode = landmarkGraph;
  lampLit(node, positionWorld, false, true);
});

addPort(/^lamp-pole$/, (node) => { lampLit(node); });
