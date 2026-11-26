// The game's renderer, three.js's WebGPURenderer (it began as a trial, ?renderer=webgpu), to measure what the ground
// costs there against WebGL. The ground, buildings, trees, lamp light and the ground's soft
// shading are ported (to TSL, in webgpu/), and the tone curve (sky.ts). Everything
// else that changes three.js's GLSL (onBeforeCompile) is drawn with the plain material,
// and what is written in GLSL outright (ShaderMaterial: rain, snow, lamp glows,
// skid marks) isn't drawn at all. Not for playing: for
// scripts/bench.mjs, e.g. --extra "&renderer=webgl" for the old renderer, with --ab (see ground's flatten).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { WebGPURenderer, MeshLambertNodeMaterial, MeshStandardNodeMaterial, CubeRenderTarget } from 'three/webgpu';
import { PROBE_OPTIONS, PROBE_SIZE, setProbeTargets } from './probe.ts';
import {
  Fn, If, Discard, float, vec2, vec3, vec4, texture, materialReference, positionWorld, normalView, normalWorldGeometry, materialColor, fract, floor, mod, dot,
  mix, smoothstep, step, length, fwidth, abs, sqrt, min, max, distance, cos, sin, select, clamp, transformNormalToView,
  attribute, positionLocal, modelViewMatrix, cameraProjectionMatrix, screenSize, uniform, renderGroup, uv, cameraPosition, normalize,
  dFdx, dFdy, cross, sign,
} from 'three/tsl';
import { GRASS_SEASON, WOOD_SEASON, FIELD_SEASON, HEDGE_SEASON } from './groundSeason.ts';
import { setPatterned, setHeld, HOLD_PX, SKY_REF, GRIT, GRIT_M, LAMP_MIRROR, SEASON } from './shading.ts';
import type { RasterGroundInput } from './shading.ts';
import {
  type N, follow, uDirt, uWet, uSnow, uStreetSnow, uRain, uCut, uDig, timeOf, followColor, followVec, addPort, hash12, vnoise, fbm, fbm2, detail, blocks, stones, ports, skyAmbient,
} from './webgpu/common.ts';
import { lampLight, uLampOn } from './webgpu/lamps.ts';
import { MIRROR, MIRROR_BRIGHT, MIRROR_K, MIRROR_MAP, MIRROR_MATRIX } from './mirror.ts';
import './webgpu/buildings.ts';
import './webgpu/trees.ts';
import './webgpu/streetTrees.ts';
import './webgpu/streetHedges.ts';
import './webgpu/streetGrass.ts';
import './webgpu/streetLitter.ts';
import './webgpu/shadows.ts';
import './webgpu/wake.ts';
import './webgpu/soft.ts';
import './webgpu/vehicles.ts';
import './webgpu/figures.ts';
import './webgpu/glows.ts';
import './webgpu/weather.ts';
import './webgpu/underground.ts';
import { CloudSunNode } from './webgpu/clouds.ts';
import { gradeCurve } from './webgpu/grade.ts';
import { makePost } from './webgpu/post.ts';
import { asphalt, setts, CLOSE_RELIEF } from './streetSurface.ts';
import { dome } from './webgpu/dome.ts';
import { DOME_NODE, DOME } from './sky.ts';
import { OLD_GRADE } from './grade.ts';
import { pavementStones, pavementNormal } from './webgpu/mosaic.ts';
import { uWater, ripples, waves, waveNormal, waterShine, flatMirror } from './webgpu/water.ts';

// PATTERNS_GLSL.
const uGroundSeason = followVec(GRASS_SEASON.park), uMeadowSeason = followVec(GRASS_SEASON.meadow), uLawnSeason = followVec(GRASS_SEASON.lawn), uGardenSeason = followVec(GRASS_SEASON.garden), uPitchSeason = followVec(GRASS_SEASON.pitch), uWoodSeason = followColor(WOOD_SEASON), uFieldSeason = followColor(FIELD_SEASON);
// Evergreen hedges keep their opaque geometry and shadows. One graph for all tiles.
// (As HEDGE_SHADE_GLSL in map/fences.ts: darker low on the sides and along the top's edges.)
const hedgeV = uv().y;
const hedgeShade = select(hedgeV.lessThan(1.5), mix(0.55, 1.0, smoothstep(0.0, 1.0, hedgeV)),
  float(1).sub(smoothstep(0.12, 0.3, abs(fract(hedgeV).sub(0.5))).mul(0.3)));
// From the pavement the leaf texture is a blur of blobs: within a few metres single leaves
// show, lighter and darker, with dark gaps into the hedge between them.
const hedgeAt = vec2(positionWorld.x.add(positionWorld.z.mul(0.7)), positionWorld.y.add(positionWorld.z.mul(0.3)));
const hedgeNear = detail(hedgeAt, 0.05);
const hedgeLeaf = vnoise(hedgeAt.mul(31)).mul(0.6).add(vnoise(hedgeAt.mul(vec2(83, 71)).add(9)).mul(0.4)).sub(0.5);
const hedgeGap = smoothstep(0.6, 0.8, vnoise(hedgeAt.mul(12).add(3)));
const hedgeClose = float(1).add(hedgeLeaf.mul(1.1).mul(hedgeNear)).mul(float(1).sub(hedgeGap.mul(0.5).mul(hedgeNear)));
// Along a hedge some stretches are denser and darker, some lighter, and the newest growth
// near the top is a yellower green (at any distance: this is what stops it reading as one flat band).
const hedgePatch = vnoise(hedgeAt.mul(0.55).add(21)).mul(0.3).add(0.86);
const hedgeGrowth = mix(vec3(1), vec3(1.16, 1.12, 0.72), smoothstep(0.55, 1, hedgeV).mul(vnoise(hedgeAt.mul(1.7).add(5))).mul(0.7));
const hedgeColour = vec4(materialColor.rgb.mul(followColor(HEDGE_SEASON)).mul(hedgeShade).mul(hedgeClose).mul(hedgePatch).mul(hedgeGrowth), 1);
addPort(/^hedge-season$/, (node) => { node.colorNode = hedgeColour; });
// The cars' probe of the street (probe.ts) needs WebGPU's kind of cube target.
setProbeTargets(() => new CubeRenderTarget(PROBE_SIZE, PROBE_OPTIONS) as never);
const surfaceDetail: N = follow(asphalt.active);
const scan = texture(asphalt.map);
asphalt.onLoad = t => { scan.value = t; };
const settDetail = follow(setts.active), settScan = texture(setts.map);
setts.onLoad = t => { settScan.value = t; };
// The scan covers four metres. Hardware mipmaps take the aggregate back to its
// mean at distance; anisotropic filtering preserves it at the player's feet.
const aggregate = (p: N) => scan.sample(p.div(4));
const trackCoord: N = attribute('trackCoord', 'float');
function railProfile(base: N) {
  const u = trackCoord, width = max(.004, fwidth(u).mul(.6));
  const edge = (p: number) => smoothstep(float(p).sub(width),float(p).add(width),u);
  const band = (a: number,b: number) => edge(a).sub(edge(b));
  // From the track centre outwards: the narrow keeper lip, flangeway, running
  // head, and the dark bedding seal. The two running faces are 1.435 m apart.
  const steel = base.mul(.83).add(vec3(.12,.12,.105).mul(band(.10,.235)))
    .mul(float(1).sub(band(.25,.483).mul(.58)))
    .add(vec3(.20,.225,.23).mul(band(.483,.865))).add(vec3(.064,.069,.066).mul(band(.54,.67)));
  return mix(base,steel,float(1).sub(smoothstep(.12,.72,fwidth(u))));
}
function tramConcrete(c: N,p: N) {
  const a=trackCoord.div(6), seam=abs(fract(a.add(.5)).sub(.5)).mul(6);
  const aa=max(.003,fwidth(trackCoord).mul(.62));
  const joint=float(1).sub(smoothstep(float(.014).sub(aa),float(.014).add(aa),seam))
    .mul(float(1).sub(smoothstep(.03,.20,aa)));
  const age = vnoise(vec2(floor(a), .31)).mul(.075).add(.96);
  const concrete = c.mul(age).mul(fbm2(p.mul(.44)).mul(.16).add(.91)).toVar();
  If(surfaceDetail.greaterThan(.5), () => {
    // Individual grains in cast concrete are finer and paler than the stones
    // in the surrounding bitumen. The saw cut has a weathered arris.
    concrete.mulAssign(aggregate(p.mul(1.65)).r.sub(.5).mul(.59).add(1));
    const rim = float(1).sub(smoothstep(.018, .042, seam)).mul(float(1).sub(smoothstep(.014,.09,aa)));
    concrete.mulAssign(rim.mul(.07).add(1));
  });
  return grit(concrete.mul(float(1).sub(joint.mul(.48))),p);
}
function graniteKerb(c: N, p: N) {
  const aa = max(.0015, fwidth(trackCoord).mul(.62));
  const stone = c.toVar();
  If(surfaceDetail.greaterThan(.5), () => {
    // A course of cut granite with three different block lengths. The quartz
    // and dark grains are finer than the stone, and the worn edge catches light.
    const q = mod(trackCoord.add(vnoise(p.mul(23)).mul(.006)), 3.12);
    const edge = min(min(q, float(3.12).sub(q)), min(abs(q.sub(1.08)), abs(q.sub(2.02))));
    const joint = float(1).sub(smoothstep(float(.007).sub(aa), float(.007).add(aa), edge));
    const arris = float(1).sub(smoothstep(.009, .022, edge)).sub(joint);
    const id = floor(trackCoord.div(3.12)).mul(3).add(step(1.08, q)).add(step(2.02, q));
    const bed = vnoise(vec2(id, 17.3)).mul(.19).add(.89);
    const grit = aggregate(p.mul(3.1)).r.sub(.5);
    const mineral = vec3(grit.mul(1.7).add(1), grit.mul(1.55).add(1), grit.mul(1.4).add(1));
    // Dark mica and pale feldspar specks, as on the stairs (stairStone).
    const fine = vec2(trackCoord, positionWorld.y).add(p).mul(70);
    const specks = float(1).sub(smoothstep(.7, .86, vnoise(fine)).mul(.25)).add(smoothstep(.74, .9, vnoise(fine.add(17.3))).mul(.14));
    const fade = float(1).sub(smoothstep(.025, .15, aa));
    stone.assign(c.mul(bed).mul(mineral).mul(specks).mul(float(1).add(arris.mul(.12).sub(joint.mul(.48)).mul(fade))));
  }).Else(() => { stone.assign(grit(pConcrete(c, p), p)); });
  return stone;
}
// ---- Relief and sheen up close (High and Ultra: CLOSE_RELIEF) ----
// The kerbs, stairs and tram rails are lit as if their surface had the depth it has: joints
// sunk between the blocks, each kerb stone's face leaning a little its own way, a dish worn
// into the middle of a tread, the rail's groove. Each is a height field in metres, turned
// into a normal from its change across the pixel (Mikkelsen's surface gradient), so it works
// on a riser or a kerb's face as on the ground. It fades out before the joints come down to a
// pixel, where it would only shimmer. They also get a sheen (roughness): polished treads and
// rail heads catch the sun, and all of them more when wet.
const uRelief: N = follow(CLOSE_RELIEF);
const reliefOn: N = uRelief.mul(surfaceDetail);
function bumped(h: N) {
  const n: N = normalWorldGeometry, dpx: N = dFdx(positionWorld), dpy: N = dFdy(positionWorld);
  const r1: N = cross(dpy, n), r2: N = cross(n, dpx), det: N = dot(dpx, r1);
  const grad: N = r1.mul(dFdx(h)).add(r2.mul(dFdy(h))).mul(sign(det));
  return transformNormalToView(normalize(n.mul(abs(det)).sub(grad)));
}
const closeFade = (aa: N) => float(1).sub(smoothstep(.008, .05, aa)).mul(reliefOn);
// A joint is a centimetre or so wide: drawn narrower than a few pixels, its slope comes and goes
// from one pixel to the next (dotted, glinting lines), so it goes sooner than the rest.
const jointFade = (aa: N) => float(1).sub(smoothstep(.0022, .0045, aa));
function kerbHeight(p: N) {
  const aa = max(.0015, fwidth(trackCoord).mul(.62));
  const q = mod(trackCoord.add(vnoise(p.mul(23)).mul(.006)), 3.12);
  const edge = min(min(q, float(3.12).sub(q)), min(abs(q.sub(1.08)), abs(q.sub(2.02))));
  const joint = float(1).sub(smoothstep(.003, max(.016, aa.mul(5)), edge)).mul(jointFade(aa));
  const id = floor(trackCoord.div(3.12)).mul(3).add(step(1.08, q)).add(step(2.02, q));
  const lean = vnoise(vec2(id, 4.7)).sub(.5).mul(.1);
  const grain = aggregate(vec2(trackCoord, positionWorld.y).add(p).mul(3.1)).r.sub(.5);
  return joint.mul(-.005).add(lean.mul(q.sub(1.5))).add(grain.mul(.0007)).mul(closeFade(aa));
}
// (stairStone's own coordinates: the step, metres across, the block, how worn.)
function stairCoords(p: N) {
  const id = floor(trackCoord.div(16)), u = trackCoord.sub(id.mul(16)).sub(8), y = positionWorld.y;
  const riser = float(1).sub(smoothstep(.45, .85, abs(normalWorldGeometry.y)));
  const len = vnoise(vec2(id, 5.7)).mul(.6).add(1.15);
  const along = u.add(vnoise(vec2(id, 1.3)).mul(len));
  const block = floor(along.div(len)).add(id.mul(7));
  const wear = float(1).sub(smoothstep(.3, .85, abs(u))).mul(riser.oneMinus());
  return { id, u, y, riser, len, along, block, wear, at: mix(p, vec2(u, y), riser) };
}
function stairHeight(p: N) {
  const { u, len, along, block, at } = stairCoords(p);
  const riser = float(1).sub(smoothstep(.45, .85, abs(normalWorldGeometry.y)));
  const aa = max(.0015, fwidth(u).mul(.62));
  const q = fract(along.div(len)).mul(len), edge = min(q, len.sub(q));
  const joint = float(1).sub(smoothstep(.003, max(.014, aa.mul(5)), edge)).mul(jointFade(aa));
  const dish = float(1).sub(smoothstep(.1, .8, abs(u))).mul(riser.oneMinus());
  const undulate = fbm2(at.mul(2.3).add(vec2(block, block.mul(.37)))).sub(.5);
  // Each block has settled a degree or so its own way.
  const tilt = vnoise(vec2(block, 2.2)).sub(.5).mul(.05).mul(q.sub(len.mul(.5)));
  const grain = aggregate(at.mul(3.1)).r.sub(.5);
  return joint.mul(-.004).sub(dish.mul(.02)).add(tilt).add(undulate.mul(.008)).add(grain.mul(.0007)).mul(closeFade(aa));
}
const railBand = (a: number, b: number, w: N) =>
  smoothstep(float(a).sub(w), float(a).add(w), trackCoord).sub(smoothstep(float(b).sub(w), float(b).add(w), trackCoord));
function railHeight() {
  const aa = max(.004, fwidth(trackCoord).mul(.6));
  return railBand(.25, .483, max(aa, .008)).mul(-.025).mul(closeFade(aa));
}
// Roughness: 1 (no sheen) where the relief is off.
function closeRoughness(id: number, p: N): N {
  let r: N;
  if (id === 20) r = float(.6).add(aggregate(p.mul(3.1)).r.sub(.5).mul(.2));
  else if (id === 21) r = float(.78).sub(stairCoords(p).wear.mul(.36));
  else r = mix(.8, .22, railBand(.483, .865, float(.01)));
  return mix(1, mix(r, min(r, .18), uWet.mul(.8)), reliefOn);
}

// Outdoor stairs of cut granite. Each step is laid in two or three blocks with staggered joints. The middle of
// each tread is worn smoother and paler, and the risers are darker and streaked.
function stairStone(c: N, p: N) {
  // trackCoord is the step's number times 16, plus 8 m plus the metres across (stoneCoord in map/stairs.ts).
  const id = floor(trackCoord.div(16)), u = trackCoord.sub(id.mul(16)).sub(8), y = positionWorld.y;
  const riser = float(1).sub(smoothstep(.45, .85, abs(normalWorldGeometry.y)));
  const len = vnoise(vec2(id, 5.7)).mul(.6).add(1.15);
  const along = u.add(vnoise(vec2(id, 1.3)).mul(len));
  const block = floor(along.div(len)).add(id.mul(7));
  const tone = vnoise(vec2(block, 3.1)).mul(.2).add(.89);
  const tint = mix(vec3(1.03, 1, .96), vec3(.97, 1, 1.03), vnoise(vec2(block, 8.9)));
  const wear = float(1).sub(smoothstep(.3, .85, abs(u))).mul(riser.oneMinus());
  const stone = c.mul(tone).mul(tint).mul(mix(1, .76, riser)).mul(wear.mul(.07).add(1)).toVar();
  // Lichen and old dirt in patches, as on a garden flight under trees.
  const patch = smoothstep(.56, .78, fbm2(p.mul(.45).add(vec2(u, y).mul(.3)))).mul(wear.mul(.7).oneMinus());
  stone.mulAssign(mix(vec3(1), vec3(.84, .88, .8), patch.mul(.6)));
  If(surfaceDetail.greaterThan(.5), () => {
    const aa = max(.0015, fwidth(u).mul(.62));
    const q = fract(along.div(len)).mul(len), edge = min(q, len.sub(q));
    const joint = float(1).sub(smoothstep(float(.006).sub(aa), float(.006).add(aa), edge));
    const fade = float(1).sub(smoothstep(.025, .15, aa));
    // Quartz and dark mica, finer than the stone; on a riser the grain is laid out
    // across and up its face instead of over the ground.
    const at = mix(p, vec2(u, y), riser);
    const grain = aggregate(at.mul(3.1)).r.sub(.5).mul(wear.mul(.4).oneMinus());
    stone.mulAssign(vec3(grain.mul(1.9).add(1), grain.mul(1.75).add(1), grain.mul(1.55).add(1)));
    // Dark mica and pale feldspar specks, and a cloudy mottle over each block.
    const fine = at.mul(70);
    stone.mulAssign(float(1).sub(smoothstep(.7, .86, vnoise(fine)).mul(.28)).add(smoothstep(.74, .9, vnoise(fine.add(17.3))).mul(.16)));
    stone.mulAssign(fbm2(at.mul(1.7).add(vec2(block, block.mul(.37)))).mul(.16).add(.92));
    // Rain runs down the risers and leaves darker streaks.
    stone.mulAssign(float(1).sub(riser.mul(smoothstep(.45, .8, vnoise(vec2(u.mul(7), y.mul(.6))))).mul(.12)));
    stone.mulAssign(float(1).sub(joint.mul(.5).mul(fade)));
  });
  return grit(stone, p);
}
function pAsphalt(c0: N, p: N) {
  const c = c0.mul(fbm(p.mul(0.3)).mul(0.18).add(0.9)).toVar();
  c.mulAssign(mix(1, 0.9, smoothstep(0.62, 0.66, fbm(p.mul(0.07).add(3)))));
  const d = detail(p, 0.06), dc = detail(p, 0.15);
  If(surfaceDetail.greaterThan(.5), () => {
    const stone=aggregate(p).r.sub(.5);
    c.mulAssign(float(1).add(stone.mul(1.48)));
  }).Else(() => {
    If(d.greaterThan(0), () => { c.addAssign(vnoise(p.mul(16)).sub(0.5).mul(0.07).mul(d)); });
  });
  // (Fainter than it was: these streaks run north to south whichever way the street does, and
  // what traffic leaves along the lanes is now laid on the street itself, ground.ts streetWear.)
  c.mulAssign(float(1).sub(smoothstep(0.6, 0.85, vnoise(p.mul(vec2(0.9, 0.25)).add(23))).mul(0.06)));
  If(dc.greaterThan(0), () => {
    // (Broken into stretches: whole, the noise's contours close into loops that read as scribbles from the pavement.)
    const crack = float(1).sub(smoothstep(0, 0.016, abs(vnoise(p.mul(0.7)).sub(0.5)))).mul(smoothstep(0.42, 0.6, vnoise(p.mul(0.31).add(9))));
    c.mulAssign(float(1).sub(crack.mul(0.3).mul(dc).mul(smoothstep(0.55, 0.7, vnoise(p.mul(0.06).add(2))))));
  });
  return c;
}
// Four laying directions, as on the procedural paving. Rotate the scanned normal
// back into the street's axes before lighting it, including on a sloping road.
function settAxes(p: N) {
  const way = floor(hash12(floor(p.div(52).add(vec2(0.31, 0.57))).add(2.9)).mul(4)).mul(Math.PI / 4);
  return vec2(cos(way), sin(way));
}
function settPoint(p: N, axes: N) {
  return vec2(p.x.mul(axes.x).sub(p.y.mul(axes.y)), p.x.mul(axes.y).add(p.y.mul(axes.x)));
}
function pSetts(c: N, p: N, sx: number, sy: number) {
  const d = detail(p, sx), s = c.mul(0.85).toVar();
  const q = settPoint(p, settAxes(p));
  If(settDetail.greaterThan(0.5), () => {
    const value = settScan.sample(q.div(2.5)).r;
    s.assign(c.mul(value.sub(0.5).mul(1.72).add(0.9)));
  }).Else(() => {
    If(d.greaterThan(0), () => {
      const b = blocks(q, sx, sy);
      const stone = c.mul(b.y.mul(0.4).add(0.8)).mul(vnoise(p.mul(9)).mul(0.16).add(0.92));
      s.assign(mix(s, mix(c.mul(0.5), stone, smoothstep(0.004, 0.02, b.x)), d));
    });
  });
  // Where feet and wheels have polished the stones they are lighter, in patches a few metres
  // across: the lighter parts of the broad variation, lifted a little more (no noise read of its own).
  const broad = fbm(p.mul(0.2)).toVar();
  return s.mul(broad.mul(0.12).add(0.94)).mul(smoothstep(0.5, 0.68, broad).mul(0.1).add(0.97));
}
// (The stones are a texture: webgpu/mosaic.ts.)
const pMosaic = (c: N, p: N) => c.mul(pavementStones(p, false)).mul(fbm(p.mul(0.25)).mul(0.1).add(0.95));
// (A surveyed pavement: the same stones in Prague's patterns, webgpu/mosaic.ts.)
const pPaved = (c: N, p: N) => c.mul(pavementStones(p, true)).mul(fbm(p.mul(0.25)).mul(0.1).add(0.95));
function pSlabs(c: N, p: N) {
  const d = detail(p, 0.4), s = c.mul(0.95).toVar();
  If(d.greaterThan(0), () => {
    const b = blocks(p, 0.6, 0.4);
    s.assign(mix(s, mix(c.mul(0.72), c.mul(b.y.mul(0.15).add(0.9)), smoothstep(0.004, 0.015, b.x)), d));
  });
  return s.mul(fbm(p.mul(0.15)).mul(0.14).add(0.93));
}
// The year's turn as the trees have it (x autumn, y in blossom, z fresh leaves): the grass's flowers go by it.
const uBloom: N = followVec(SEASON);
function pGrass(c0: N, p: N, seasonal: boolean, season: typeof uGroundSeason = uGroundSeason) {
  if (seasonal) c0 = c0.mul(season.rgb);
  const c = c0.mul(fbm(p.mul(0.18)).mul(0.32).add(0.82)).toVar();
  let dry = smoothstep(0.55, 0.75, fbm(p.mul(0.04).add(7)));
  if (seasonal) dry = clamp(dry.mul(season.w), 0, 1);
  c.assign(mix(c, c.mul(vec3(1.12, 1.05, 0.78)), dry));
  c.assign(mix(c, c.mul(vec3(1.05, 0.9, 0.7)), smoothstep(0.6, 0.8, fbm2(p.mul(0.15).add(3))).mul(0.6)));
  const d = detail(p, 0.2), near = detail(p, 0.035);
  If(d.greaterThan(0), () => {
    // Lusher and thinner clumps a metre or two across, which a lawn always has (close up only).
    c.mulAssign(float(1).add(vnoise(p.mul(0.85).add(41)).sub(0.5).mul(0.2).mul(d)));
    // The blades themselves, close up: fine streaks that all lean one way over a few metres.
    const lean = vnoise(p.mul(0.11).add(5)).mul(6.2832);
    const q = vec2(dot(p, vec2(cos(lean), sin(lean))), dot(p, vec2(sin(lean).negate(), cos(lean))));
    c.mulAssign(float(1).add(vnoise(q.mul(vec2(3, 13))).sub(0.5).mul(0.26).mul(d)));
    c.addAssign(vnoise(p.mul(5)).sub(0.5).mul(0.05).mul(d));
    // At your feet: single blades, some of them catching the light.
    If(near.greaterThan(0), () => {
      const blade = vnoise(q.mul(vec2(21, 96)).add(3)).toVar(), fine = vnoise(q.mul(vec2(55, 230)).add(17));
      c.mulAssign(float(1).add(blade.sub(0.5).mul(0.5).add(fine.sub(0.5).mul(0.34)).mul(near)));
      c.assign(mix(c, c.mul(vec3(1.14, 1.12, 0.82)), smoothstep(0.62, 0.9, blade).mul(near).mul(0.5)));
    });
    // Daisies and dandelions while the trees are in blossom: a white or yellow dot here and there.
    if (seasonal) {
      const cell = floor(p.mul(2.6)), h = hash12(cell.add(7.7));
      const at = fract(p.mul(2.6)).sub(vec2(fract(h.mul(13.1)), fract(h.mul(29.3))).mul(0.6).add(0.2));
      const flower = float(1).sub(smoothstep(0.1, 0.2, length(at))).mul(step(h, uBloom.y.mul(0.16))).mul(d);
      c.assign(mix(c, mix(vec3(0.82, 0.8, 0.72), vec3(0.8, 0.62, 0.08), step(0.5, fract(h.mul(91.7)))), flower.mul(0.85)));
    }
  });
  return c;
}
const pWood = (c: N, p: N) => c.mul(fbm(p.mul(0.12)).mul(0.45).add(0.75)).add(vnoise(p.mul(3)).sub(0.5).mul(0.05));
const pPitch = (c: N, p: N, seasonal: boolean) => pGrass(c, p, seasonal, uPitchSeason).mul(step(0.5, fract(p.x.div(6))).mul(0.1).add(0.94));
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
  const c = vec3(c0).toVar(), d = detail(p, 0.5);
  If(uWater.greaterThan(0.5), () => {
    // Deep and green, lighter over the shallows: what it mirrors comes on top (webgpu/water.ts).
    c.mulAssign(vec3(0.56, 0.69, 0.63).mul(fbm2(p.mul(vec2(0.05, 0.012)).add(vec2(0, time.mul(0.03)))).mul(0.3).add(0.85)));
    // (Less of it the more of a mirror the water is from here.)
    c.mulAssign(flatMirror(positionWorld).mul(0.9).oneMinus());
  }).Else(() => {
    c.mulAssign(fbm(p.mul(vec2(0.05, 0.012)).add(vec2(0, time.mul(0.03)))).mul(0.2).add(0.88));
    If(d.greaterThan(0), () => {
      c.addAssign(smoothstep(0.72, 0.8, fbm(p.mul(vec2(0.5, 0.09)).add(vec2(time.mul(0.02), time.mul(0.12))))).mul(0.1).mul(d));
    });
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
function pattern(id: number, c: N, p: N, time: N, seasonal: boolean): N {
  switch (id) {
    case 1: {
      const road = pAsphalt(c,p).toVar();
      If(surfaceDetail.lessThan(.5),()=>{ road.assign(grit(road,p)); });
      return road;
    }
    case 18: return railProfile(c);
    case 19: return tramConcrete(c,p);
    case 20: return graniteKerb(c,p);
    case 21: return stairStone(c,p);
    case 2: return grit(pSetts(c, p, 0.17, 0.14), p);
    case 3: return grit(pMosaic(c, p), p);
    case 16: return grit(pPaved(c, p), p);
    case 4: return grit(pSlabs(c, p), p);
    case 5: return pGrass(c, p, seasonal);
    case 6: return pWood(seasonal ? c.mul(uWoodSeason) : c, p);
    case 7: return pPitch(c, p, seasonal);
    case 8: return pDirt(c, p);
    case 9: return grit(pConcrete(c, p), p);
    case 10: case 17: return pWater(c, p, time);
    case 11: return pGravel(c, p);
    case 12: return pField(seasonal ? c.mul(uFieldSeason) : c, p);
    case 13: return pGrass(c, p, seasonal, uMeadowSeason);
    case 14: return pGrass(c, p, seasonal, uLawnSeason);
    case 15: return pGrass(c, p, seasonal, uGardenSeason);
    default: return c;
  }
}

// WEATHER_GLSL: the colour, and in .a how much of a mirror the ground is there (shine).
function weathered(id: number, c0: N, p: N, time: N) {
  if (id === 10 || id === 17) return vec4(c0, select(uWater.greaterThan(0.5), 0, 0.35));
  const paved = id <= 4 || id === 9 || id === 16 || id === 18 || id === 19 || id === 20 || id === 21, road = id === 1 || id === 2;
  const c = vec3(c0).toVar(), shine = float(0).toVar();
  // (Derivatives outside the branches.)
  const ripple = paved ? detail(p, 0.12) : float(0);
  const wet = (paved ? select(uSnow.greaterThan(0.01), max(uWet, uSnow.mul(uStreetSnow.oneMinus()).mul(0.8)), uWet) : uWet).toVar();
  If(wet.greaterThan(0.01), () => {
    c.mulAssign(mix(1, paved ? 0.6 : 0.78, wet));
    if (paved) {
      const puddle = smoothstep(0.66, 0.71, fbm2(p.mul(0.3).add(31)).mul(0.75).add(fbm2(p.mul(0.04).add(7)).mul(0.35))).mul(smoothstep(0.35, 0.9, wet)).toVar();
      // Away from the puddles, how much a wet surface shines depends on it: the setts' worn caps
      // more than the sand between them, the asphalt's stones here and there, a stair's worn
      // middle, a rail's polished head (up close only).
      let gloss: N = float(1);
      if (id === 2) gloss = select(settDetail.greaterThan(0.5), smoothstep(0.35, 0.65, settScan.sample(settPoint(p, settAxes(p)).div(2.5)).r).mul(1.1).add(0.45), float(1));
      else if (id === 1) gloss = select(surfaceDetail.greaterThan(.5), aggregate(p).r.mul(0.9).add(0.55), float(1));
      else if (id === 21) gloss = stairCoords(p).wear.mul(0.8).add(0.8);
      else if (id === 18) gloss = railBand(.483, .865, float(.01)).mul(1.5).add(0.8);
      shine.assign(puddle.mul(0.4).add(gloss.mul(0.1)).mul(wet));
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

const uSkyRef: N = followColor(SKY_REF);
const followVec2 = (v: { value: THREE.Vector2 }) => { const u = uniform(v.value.clone()).setGroup(renderGroup); u.onRenderUpdate(() => { u.value.copy(v.value); return u.value; }); return u; };
// What a puddle mirrors there: the sky, under what mirror.ts drew of the scene, wavering with the ripples (MIRROR_GLSL).
const uMirrorOn = follow(MIRROR), uMirrorK = follow(MIRROR_K), uMirrorBright: N = followVec2(MIRROR_BRIGHT), mirrorMap = texture(MIRROR_MAP.value);
const uMirrorMatrix: N = (() => {
  const u = uniform(MIRROR_MATRIX.value.clone()).setGroup(renderGroup);
  u.onRenderUpdate(() => { u.value.copy(MIRROR_MATRIX.value); return u.value; });
  return u;
})();
// How much of the horizon's sky wet ground mirrors along the street, for each unit of its shine.
const WET_SHEEN = 2.5;
const uHorizon: N = followColor(DOME.horizon);
const mirrorOf = (shine: N, time: N) => Fn(() => {
  const r = vec3(uSkyRef).toVar();
  If(uMirrorOn.greaterThan(0.5).and(shine.greaterThan(0.001)), () => {
    const w = positionWorld, p = vec2(w.x, w.z.negate());
    const o = vec2(vnoise(p.mul(3).add(time.mul(0.7))), vnoise(p.mul(3).add(17).sub(time.mul(0.6)))).sub(0.5).mul(uRain.mul(0.3).add(0.06));
    const q = uMirrorMatrix.mul(vec4(w.x.add(o.x), w.y, w.z.sub(o.y), 1));
    const m = (mirrorMap.sample(q.xy.div(q.w)) as N).level(float(0));
    r.assign(uSkyRef.mul(m.a.oneMinus()).add(m.rgb.mul(0.06)).mul(uMirrorK.div(0.06)).add(max(m.rgb.sub(uMirrorBright.x), 0).mul(uMirrorBright.y).mul(uLampOn)));
  });
  return r;
})();
// A tile's texture, read from the material drawn: the ground's node graphs are shared by every
// tile (three.js builds a shader for each graph it hasn't seen, 7–60 ms on the main thread), and
// each material carries its own tile's textures and their boxes (`${name}Map`, `${name}Box`).
const tileTexture = (name: string, p: N) => {
  const b: N = materialReference(`${name}Box`, 'vec4');
  const uv = p.sub(b.xy).div(b.zw.sub(b.xy));
  return (materialReference(`${name}Map`, 'texture') as N).context({ getUV: () => uv });
};
const boxOf = (box: number[]) => new THREE.Vector4(box[0], box[1], box[2], box[3]);

type GroundInputs = {
  relief: { texture: THREE.Texture; box: number[]; sky?: { texture: THREE.Texture; box: number[] } | null } | null;
  deck: { mask: THREE.Texture | null; box?: number[] } | null;
  photo: { texture: THREE.Texture; box: number[] } | null;
  raster: RasterGroundInput | null;
};
const groundGraphs = new Map<{ value: number }, Map<string, { color: N; ao: N | null; emissive: N; normal: N | null; mask: N | null; roughness: N | null }>>();

// patterned() in shading.ts, as a node material.
function groundMaterial(
  base: THREE.MeshLambertMaterial, id: number, time: { value: number },
  relief: GroundInputs['relief'] = null, deck: GroundInputs['deck'] = null,
  dig = false, photo: GroundInputs['photo'] = null, sheltered = false,
  seasonal = true, raster: GroundInputs['raster'] = null,
) {
  // (The kerbs, stairs and rails can shine: closeRoughness.)
  const glossy = id === 18 || id === 20 || id === 21;
  const m: N = glossy ? new MeshStandardNodeMaterial() : new MeshLambertNodeMaterial();
  m.color.copy(base.color);
  m.map = base.map;
  Object.assign(m, { side: base.side, depthWrite: base.depthWrite, depthTest: base.depthTest, transparent: base.transparent, opacity: base.opacity });
  const inputs = { relief, deck, photo, raster };
  const shade = (n: N, pattern: number, seasonal = true, day = false) => {
    const g = groundGraph(pattern, time, inputs, dig, sheltered, seasonal, day);
    Object.assign(n, {
      colorNode: g.color, aoNode: g.ao, emissiveNode: g.emissive, normalNode: g.normal, ...(g.roughness ? { roughnessNode: g.roughness, metalnessNode: float(0) } : {}),
      maskNode: g.mask, rasterMap: raster?.texture, rasterBox: raster && boxOf(raster.box),
      reliefMap: relief?.texture, reliefBox: relief && boxOf(relief.box), skyMap: relief?.sky?.texture, skyBox: relief?.sky && boxOf(relief.sky.box),
      maskMap: deck?.mask, maskBox: deck?.mask && boxOf(deck.box!), photoMap: photo?.texture, photoBox: photo && boxOf(photo.box),
    });
  };
  shade(m, id, seasonal);
  m.userData.flatten = () => {
    const f = m.clone();
    shade(f, 0);
    return f;
  };
  // The same ground without the lamps' light and the wet mirror (scripts/ground-ab.js 'day'):
  // what their code costs while both are off.
  m.userData.day = () => {
    const f = m.clone();
    shade(f, id, seasonal, true);
    return f;
  };
  if ([5, 6, 7, 12, 13, 14, 15].includes(id)) m.userData.summerGround = () => {
    const f = m.clone();
    shade(f, id, false);
    return f;
  };
  return m as unknown as THREE.MeshLambertMaterial;
}
// held() in shading.ts: thin paint widened about its centre line to stay HOLD_PX pixels wide.
// Only geometry, camera and screen inputs: share the complete graph so equivalent
// paint materials can reuse a builder state as tiles arrive.
let heldPosition: N | null = null;
function heldMaterial(material: THREE.MeshLambertMaterial) {
  if (!heldPosition) {
    const hold = attribute('hold', 'vec3');
    const pixel = modelViewMatrix.mul(vec4(positionLocal, 1)).z.negate().mul(2).div((cameraProjectionMatrix as N).element(1).y.mul(screenSize.y));
    const grow = max(1, pixel.mul(HOLD_PX).div(hold.z)).sub(1);
    heldPosition = positionLocal.add(vec3(hold.x, 0, hold.y).mul(grow));
  }
  (material as unknown as MeshLambertNodeMaterial).positionNode = heldPosition;
  return material;
}
function groundGraph(id: number, time: { value: number }, { relief, deck, photo, raster }: GroundInputs, dig: boolean, sheltered: boolean, seasonal: boolean, day = false) {
  const key = `${id} ${!!relief} ${!!relief?.sky} ${!!deck} ${!!deck?.mask} ${!!photo} ${!!raster} ${dig} ${sheltered} ${seasonal} ${day}`;
  let byKey = groundGraphs.get(time);
  if (!byKey) groundGraphs.set(time, (byKey = new Map()));
  let graph = byKey.get(key);
  if (graph) return graph;
  const g = groundColor(id, timeOf(time), !!relief, deck ? !!deck.mask : null, dig, !!photo, sheltered, seasonal).toVar();
  // Open water: its waves' slope, shared by the lighting and by what it mirrors.
  const wp = vec2(positionWorld.x, positionWorld.z.negate());
  const isWater = id === 10 || id === 17, quietWater = id === 17;
  const slope = isWater && !photo && !sheltered ? waves(wp, timeOf(time), quietWater).toVar() : null;
  graph = {
    color: vec4(g.rgb, 1),
    mask: raster ? tileTexture('raster', wp).r.greaterThan(0.5) : null,
    // Courtyards and lanes see less of the sky: less of the ambient light, none of the sun's or the lamps'.
    ao: relief?.sky ? skyAmbient(tileTexture('sky', vec2(positionWorld.x, positionWorld.z.negate())).r) : null,
    // Lamp light on the ground, and the wet ground's mirror of the sky and the lamps.
    emissive: Fn(() => {
      const l = day ? vec3(0) : lampLight(slope ? positionWorld.add(vec3(slope.x, 0, slope.y).mul(6)) : positionWorld, normalView).toVar();
      const sky = !isWater && !sheltered && !day ? mirrorOf(g.a, timeOf(time)) : uSkyRef;
      const e: N = day ? uSkyRef.mul(g.a).toVar()
        : g.rgb.mul(l).add(sky.add(l.mul(smoothstep(LAMP_MIRROR[0], LAMP_MIRROR[1], dot(l, vec3(0.3, 0.59, 0.11))).mul(0.85))).mul(g.a)).toVar();
      // Seen at a slant (from the street), wet ground mirrors far more than from above: the
      // sky low over the far end of the street, on what is wet enough to shine.
      if (!isWater && !sheltered) {
        const slant: N = float(1).sub(max(normalize(cameraPosition.sub(positionWorld)).y, 0));
        const s2: N = slant.mul(slant);
        e.addAssign(uHorizon.mul(s2.mul(s2).mul(s2)).mul(min(g.a.mul(WET_SHEEN), 0.6)));
      }
      return slope ? e.add(waterShine(positionWorld, wp, slope, timeOf(time), uSkyRef, l, quietWater)) : e;
    })(),
    normal: slope ? transformNormalToView(waveNormal(slope)) : id === 1 ? Fn(() => {
      const n = normalWorldGeometry.toVar();
      If(surfaceDetail.greaterThan(.5),()=>{
        const xy=aggregate(wp).gb.sub(.5).mul(.48).mul(float(1).sub(uWet.mul(.65)));
        n.assign(normalize(n.add(vec3(xy.x,0,xy.y.negate()).mul(abs(n.y)))));
      });
      return transformNormalToView(n);
    })() : id === 2 ? Fn(() => {
      const n = normalWorldGeometry.toVar();
      If(settDetail.greaterThan(0.5), () => {
        const axes = settAxes(wp), uv = settPoint(wp, axes).div(2.5);
        const xy = settScan.sample(uv).gb.sub(0.5).mul(1.5);
        const world = vec2(dot(xy, axes), xy.y.mul(axes.x).sub(xy.x.mul(axes.y)));
        n.assign(normalize(n.add(vec3(world.x, 0, world.y.negate()).mul(abs(n.y)))));
      });
      return transformNormalToView(n);
    })() : id === 3 || id === 16 ? pavementNormal(wp)
      : id === 20 ? bumped(kerbHeight(wp)) : id === 21 ? bumped(stairHeight(wp)) : id === 18 ? bumped(railHeight()) : null,
    roughness: id === 18 || id === 20 || id === 21 ? closeRoughness(id, wp) : null,
  };
  byKey.set(key, graph);
  return graph;
}
// deck: null off the bridges and out of the tunnels, else whether its level has a mask.
function groundColor(id: number, time: N, relief: boolean, deck: boolean | null, dig: boolean, photo: boolean, sheltered: boolean, seasonal: boolean) {
  return Fn(() => {
    const w = positionWorld.toVar();
    const wp = vec2(w.x, w.z.negate()).toVar();
    if (deck !== null) {
      If(w.y.greaterThan(uCut.y).and(distance(w.xz, uCut.xz).lessThan(uCut.w)), () => { Discard(); });
      if (deck) If(tileTexture('mask', wp).r.lessThan(0.5), () => { Discard(); });
    }
    const c = vec3(photo ? tileTexture('photo', wp).rgb : pattern(id, vec3(materialColor), wp, time, seasonal)).toVar();
    // Hill shading and the broad variation (broad), baked together for a tile.
    if (relief) c.mulAssign(tileTexture('relief', wp).r);
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

// Off, every instance matrix in a uniform buffer is sent each frame again, as three.js
// does by itself (to compare: bench.mjs --ab).
export const SEND_CHANGED_MATRICES = { value: true };

export function configureRenderer(renderer: WebGPURenderer) {
  const library = renderer.library as any;
  const fromMaterial = library.fromMaterial.bind(library);
  library.fromMaterial = (legacy: THREE.Material) => {
    const node = fromMaterial(legacy);
    if (node && node !== legacy && legacy.customProgramCacheKey) {
      const key = legacy.customProgramCacheKey();
      for (const p of ports) if (p.match.test(key)) p.port(node, legacy);
      // The shadow pass reads the scene's own (legacy) material, not this one: a port's
      // shadow position (the people's animation, the trees' crowns) goes on it too, and
      // its version moves on so that shadow nodes worked out without it are made again.
      const cast = (node as any).castShadowPositionNode;
      if (cast && !(legacy as any).castShadowPositionNode) {
        (legacy as any).castShadowPositionNode = cast;
        legacy.needsUpdate = true;
      }
    }
    return node;
  };
  // The tiles' ground and buildings share their node graphs (groundGraph, the building and
  // cutaway ports), so a builder state made for one tile serves every later tile with that
  // variant. three.js drops a state as soon as no object uses it, which happens when the
  // last tile with that variant is undressed, and builds it afresh when one comes back: a
  // building's took 0.65–1 s on a Pixel 5. Those are held instead: one extra use each, a
  // few dozen variants in all.
  const nodes = (renderer as any)._nodes;
  const decided = new WeakSet<object>();
  const sharedGraph = (m: THREE.Material) => !!m.userData?.flatten || /^(buildings-procedural|street-facade|cut-)/.test(m.customProgramCacheKey?.() ?? '');
  const hold = (ro: { material: THREE.Material }, state: { usedTimes: number } | undefined) => {
    if (!state || decided.has(state)) return;
    decided.add(state);
    if (sharedGraph(ro.material)) state.usedTimes++;
  };
  const getForRender = nodes.getForRender.bind(nodes);
  const webgpu = 'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend === true;
  const backend = renderer.backend as any;
  // Instance matrices three.js keeps in a uniform buffer (a mesh with too many attributes
  // for its shared build: the trees, the people), by their array.
  const matrices = new WeakMap<object, THREE.InstancedBufferAttribute>();
  const uniformLimit: number = webgpu ? backend.capabilities.getUniformBufferLimit() : Infinity;
  nodes.getForRender = (ro: { material: THREE.Material; object?: THREE.Object3D }, useAsync?: boolean) => {
    const m = (ro.object as THREE.InstancedMesh | undefined)?.instanceMatrix as (THREE.InstancedBufferAttribute & { isStorageInstancedBufferAttribute?: boolean }) | undefined;
    if (m && webgpu) {
      // Matrices too many for a uniform buffer go in a storage buffer the mesh's shaders
      // share (shareInstances in webgpu/trees.ts). Said here, before anything is built for
      // the mesh: its shadow can be built before its colours (a mesh the sun sees before the
      // camera does), and three.js's plain instancing then made the buffer for vertex
      // input only, which the storage binding that followed was refused ("Binding usage
      // … doesn't match expected usage (BufferUsage::Storage)", and nothing drawn).
      if (ro.object!.userData.sharedMatrices && !m.isStorageInstancedBufferAttribute && Math.max(m.count, 1) * 64 > uniformLimit) m.isStorageInstancedBufferAttribute = true;
      if (!matrices.has(m.array)) matrices.set(m.array, m);
    }
    const out = getForRender(ro, useAsync);
    if (typeof out?.then === 'function') out.then((state: { usedTimes: number }) => hold(ro, state), () => {});
    else hold(ro, out);
    return out;
  };
  // Buffers that geometries share (the tree crown's, in every tile) are marked `shared`. Left to
  // three.js, disposing one tile's geometry destroys the buffer for all of them, and objects that
  // haven't changed are never checked again, so they would draw without it.
  const attributes = (renderer as any)._geometries.attributes;
  const deleteAttribute = attributes.delete.bind(attributes);
  attributes.delete = (attribute: { shared?: boolean }) => (attribute.shared ? null : deleteAttribute(attribute));
  // The sun's light node is swapped for one that takes the cloud shadows into account.
  // (`&nocloud` in the address leaves them out, to compare with and without.)
  if (!location.search.includes('nocloud')) THREE.DirectionalLight.registerNode(CloudSunNode);
  library.addToneMapping(OLD_GRADE ? toneCurve : gradeCurve, THREE.CustomToneMapping);
  if (webgpu) makePost(renderer as any);
  DOME_NODE.value = dome;
  // GLSL materials can't be drawn: hide them all. (Material's constructor sets
  // visible through this setter too.)
  // WebGPURenderer calls camera.updateProjectionMatrix(); the lamps' light map is drawn with a bare THREE.Camera, which has none.
  (THREE.Camera.prototype as { updateProjectionMatrix?: () => void }).updateProjectionMatrix ??= () => {};
  Object.defineProperty(THREE.ShaderMaterial.prototype, 'visible', { get: () => false, set: () => {}, configurable: true });
  // Under Chrome's --disable-frame-rate-limit (bench.mjs) compiling ahead never
  // finishes; what isn't compiled by then is compiled when it's first drawn.
  const compileAsync = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...a: Parameters<typeof compileAsync>) => Promise.race([compileAsync(...a), new Promise<void>((r) => setTimeout(r, 10000))]);
  // three.js sends every uniform buffer again each frame its object is drawn, changed or
  // not. For matrices that is the whole array, once for each of the mesh's shaders that
  // reads it: about 60 buffers and 600 KB a frame for the trees round Újezd. They are sent
  // when their attribute's version has moved on (needsUpdate, as send() in gpu.ts sets it)
  // or the buffer on the GPU is a new one.
  if (webgpu) {
    const updateBinding = backend.updateBinding.bind(backend);
    backend.updateBinding = (binding: { isNodeUniformBuffer?: boolean; buffer: object }) => {
      const attribute = binding.isNodeUniformBuffer && SEND_CHANGED_MATRICES.value ? matrices.get(binding.buffer) : undefined;
      if (attribute) {
        const data = backend.get(binding) as { buffer: unknown; sent?: unknown; sentVersion?: number };
        if (data.sent === data.buffer && data.sentVersion === attribute.version) return;
        data.sent = data.buffer;
        data.sentVersion = attribute.version;
      }
      updateBinding(binding);
    };
  }
  setPatterned(groundMaterial, webgpu);
  setHeld(heldMaterial);
  console.info(`Renderer: three.js WebGPURenderer on ${webgpu ? 'WebGPU' : 'WebGL 2 (no WebGPU here)'}`);
  return renderer as unknown as THREE.WebGLRenderer;
}
