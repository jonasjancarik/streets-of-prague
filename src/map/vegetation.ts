import * as THREE from 'three';
import { Grid, fillPolys, strokeLines, rng } from './geo.ts';
import { cutAway, NOISE_GLSL } from '../shading.ts';
import type { Geo, GeoData, Point2, Polygons } from './geo.ts';

export interface TreeTileData extends GeoData {
  areas: Record<string, Polygons | undefined>;
  roads: Record<string, Polygons | undefined>;
  buildings: { rings: Point2[][] }[];
  walls: { kind: string; pts: Point2[] }[];
  trees: Point2[];
}

interface TreeInstances { matrices: Float32Array; colours: Float32Array; count: number }

// Land-use classes rasterised at 1 px/m, used to scatter trees.
const WOOD = 200, PARK = 120, ORCHARD = 60;

// Where a tile's trees stand, and how big and what colour they are: their instance
// matrices (standing on the terrain, `height(x, y)`) and colours, for treeMesh. Under
// a bridge a tree grows no higher than `room(x, y)` metres leaves it, or not at all.
// Runs in the tile workers.
export function treeInstances(geo: Geo<TreeTileData>, height: (x: number, y: number) => number = () => 0,
  room: (x: number, y: number) => number = () => Infinity): TreeInstances {
  const d = geo.data;
  const grid = new Grid(geo, 1, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const fill = (polys: Polygons | undefined, v: number) => {
      if (!polys) return;
      ctx.fillStyle = `rgb(${v},0,0)`;
      fillPolys(ctx, geo, polys, s);
    };
    fill(d.areas.park, PARK);
    fill(d.areas.orchard, ORCHARD);
    fill(d.areas.wood, WOOD);
    // Keep trees off everything built or paved.
    fill(d.areas.square, 0);
    fill(d.areas.pitch, 0);
    fill(d.areas.water, 0);
    fill(d.areas.bridge, 0);
    for (const k of Object.keys(d.roads)) fill(d.roads[k], 0);
    ctx.fillStyle = '#000';
    fillPolys(ctx, geo, d.buildings.map((b) => b.rings), s);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    strokeLines(ctx, geo, d.walls.map((w) => w.pts), s);
  });

  const trees = []; // [x, y, radius, kind]
  const r = rng(42);
  for (const [x, y] of d.trees) trees.push([x, y, 3 + r() * 2.5, 1]);

  const step = 4.5;
  for (let y = geo.minY; y < geo.maxY; y += step) {
    for (let x = geo.minX; x < geo.maxX; x += step) {
      const jx = x + (r() - 0.5) * step, jy = y + (r() - 0.5) * step;
      const v = grid.at(jx, jy);
      if (v === WOOD && r() < 0.62) trees.push([jx, jy, 3 + r() * 3.2, 0]);
      else if (v === PARK && r() < 0.09) trees.push([jx, jy, 2.8 + r() * 2.8, 1]);
    }
  }
  // Orchards: loose rows, like the Petřín fruit gardens in the 1945 photo.
  for (let y = geo.minY; y < geo.maxY; y += 6) {
    for (let x = geo.minX; x < geo.maxX; x += 6) {
      if (grid.at(x, y) === ORCHARD && r() < 0.85) trees.push([x + (r() - 0.5), y + (r() - 0.5), 1.7 + r() * 0.8, 2]);
    }
  }

  const matrices = new Float32Array(trees.length * 16), colours = new Float32Array(trees.length * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const colors = [
    [new THREE.Color('#5a7c38'), new THREE.Color('#4a6a30'), new THREE.Color('#6a8c40')],
    [new THREE.Color('#6f9440'), new THREE.Color('#7f9c45'), new THREE.Color('#5f8638')],
    [new THREE.Color('#7f9a52'), new THREE.Color('#8ea85c'), new THREE.Color('#c9c7a0')], // blossom in May
  ];
  const c = new THREE.Color();
  trees.forEach(([x, y, rad, kind], i) => {
    let h = rad * (1.6 + r() * 0.6);
    // The crown's top is 0.75 of its radius above its centre.
    const top = h + rad * 0.75, fit = Math.min(1, (room(x, y) - 0.5) / top);
    if (fit < 1) {
      rad *= fit < 0.35 ? 0 : fit;
      h *= fit < 0.35 ? 0 : fit;
    }
    p.set(x, h, -y);
    q.setFromEuler(new THREE.Euler(0, r() * Math.PI, 0));
    const w = rad * (0.9 + r() * 0.2);
    sc.set(w, rad * (0.85 + r() * 0.3), rad * (0.9 + r() * 0.2));
    m.compose(p, q, sc);
    m.elements[13] += height(x, y);
    m.toArray(matrices, i * 16);
    const pal = colors[kind];
    c.copy(pal[Math.floor(r() * pal.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.05);
    c.toArray(colours, i * 3);
  });
  return { matrices, colours, count: trees.length };
}

// A crown: tufts of leaves in tiers, like shingles, round a dark core that fills the
// gaps between them. Each tuft is a low dome with a ragged outline of five lobes,
// tilted outwards the further down the crown it sits, with normals that bulge so
// every tuft has its own lit edge and shaded underside; the upper tufts shade the ones
// below. Lower tiers are darker (vertex colours, multiplied by each tree's own
// colour). The tufts are real geometry rather than shapes cut out of cards, so they're
// opaque: what's hidden needn't be shaded, the edges are antialiased like any mesh's
// and the shadows need no material of their own. Top tier first, so what it covers is
// skipped. About 340 triangles, shared by every tree of a tile.
// `tuft`: where on the tuft a vertex is (-1…1 across) and the tuft's seed.
const RIM = 20;
function crownGeometry() {
  const r = rng(7);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], tuft: number[] = [], idx: number[] = [];
  const across: number[] = [], along: number[] = []; // each tuft's card, for its leaves
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
  const bulge = new THREE.Vector3(), round = new THREE.Vector3();
  const card = (c: THREE.Vector3, normal: THREE.Vector3, size: number, shade: number) => {
    t.crossVectors(Math.abs(normal.y) > 0.99 ? side : up, normal).normalize();
    b.crossVectors(normal, t);
    const spin = r() * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
    const tx = t.clone().multiplyScalar(cs).addScaledVector(b, sn), bx = b.clone().multiplyScalar(cs).addScaledVector(t, -sn);
    const seed = r(), base = pos.length / 3, sa = seed * Math.PI * 2;
    // A low dome: the middle raised a little, and round it the outline, four points
    // to a lobe (the leaf shader lays its leaves out by the same lobes).
    const ring: [number, number, number][] = [[0, 0, 0.35]];
    for (let j = 0; j < RIM; j++) {
      const th = (j / RIM) * Math.PI * 2 - sa;
      const e = 0.8 + 0.13 * Math.cos(5 * (th + sa)) + 0.05 * Math.cos(11 * th + sa * 3);
      ring.push([Math.cos(th) * e, Math.sin(th) * e, 0]);
    }
    for (const [u, v, h] of ring) {
      p.copy(c).addScaledVector(tx, u * size).addScaledVector(bx, v * size).addScaledVector(normal, h * size);
      bulge.copy(normal).addScaledVector(tx, u).addScaledVector(bx, v).normalize();
      round.copy(p).normalize();
      n.copy(bulge).addScaledVector(round, 0.7).normalize();
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      col.push(shade, shade, shade);
      tuft.push(u, v, seed);
      across.push(tx.x, tx.y, tx.z);
      along.push(bx.x, bx.y, bx.z);
    }
    for (let j = 0; j < RIM; j++) idx.push(base, base + 1 + j, base + 1 + ((j + 1) % RIM));
  };
  // [tufts, distance from the middle, height, tilt, half size]
  const tiers: [number, number, number, number, number][] = [
    [7, 0.64, -0.08, 62, 0.48], [5, 0.4, 0.2, 40, 0.46], [3, 0.18, 0.4, 20, 0.4], [1, 0, 0.5, 0, 0.36],
  ];
  const c = new THREE.Vector3(), normal = new THREE.Vector3();
  tiers.map((t, tier) => [t, tier] as const).reverse().forEach(([[count, dist, y, tilt, size], tier]) => {
    const phase = r() * Math.PI * 2, lift = tier / (tiers.length - 1);
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2 + (r() - 0.5) * 0.4;
      const d = dist * (0.9 + r() * 0.2), tl = THREE.MathUtils.degToRad(tilt * (0.85 + r() * 0.3));
      c.set(Math.cos(a) * d, y + (r() - 0.5) * 0.08, Math.sin(a) * d);
      normal.set(Math.cos(a) * Math.sin(tl), Math.cos(tl), Math.sin(a) * Math.sin(tl));
      card(c, normal, size * (0.9 + r() * 0.2), (0.7 + 0.3 * lift) * (0.9 + r() * 0.2));
    }
  });
  // The core, round and dark, behind the tufts.
  const core = new THREE.IcosahedronGeometry(0.56, 0);
  const cp = core.attributes.position.array;
  for (let i = 0; i < cp.length; i += 3) {
    p.set(cp[i], cp[i + 1] * 0.7, cp[i + 2]);
    n.set(cp[i], cp[i + 1], cp[i + 2]).normalize();
    idx.push(pos.length / 3);
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
    col.push(0.32, 0.32, 0.32);
    tuft.push(0, 0, -1); // (no leaves)
    across.push(1, 0, 0);
    along.push(0, 0, 1);
  }
  core.dispose();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geom.setAttribute('tuft', new THREE.Float32BufferAttribute(tuft, 3));
  geom.setAttribute('across', new THREE.Float32BufferAttribute(across, 3));
  geom.setAttribute('along', new THREE.Float32BufferAttribute(along, 3));
  geom.setIndex(idx);
  return geom;
}
let crown: THREE.BufferGeometry | null = null;

const TUFT_GLSL = 'varying vec3 vTuft;';
// Cells for the small leaves: x = gap to the next leaf, y = random, zw = from the
// leaf's middle. Only the four nearest cells are searched (their points kept near the
// middle of each cell so that's enough).
const SMALL_LEAVES_GLSL = /* glsl */ `
vec4 smallLeaves(vec2 p) {
  vec2 i = floor(p - .5), f = p - i;
  float d1 = 8., d2 = 8.;
  vec2 o1 = vec2(0.), c1 = vec2(0.);
  for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
    vec2 g = vec2(x, y), r = g + vec2(hash12(i + g), hash12(i + g + 17.3)) * .75 + .125 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; o1 = r; c1 = i + g; } else if (d < d2) d2 = d;
  }
  return vec4(sqrt(d2) - sqrt(d1), hash12(c1 + 5.1), -o1);
}
`;
const TUFT_VERTEX = ['#include <common>', '#include <common>\nattribute vec3 tuft;\nvarying vec3 vTuft;'] as const;
const TUFT_BEGIN = ['#include <begin_vertex>', '#include <begin_vertex>\n  vTuft = tuft;'] as const;

// Leaves: every tuft is five big leaves with five smaller ones on top, set between
// them. Each leaf is flat and tilted its own way, outwards (the top ones less), so
// the light changes leaf by leaf, with hard edges and a thin dark crease where two
// meet, not in one smooth gradient over the tuft. Leaves in the light go a little
// yellow, as sunlight through leaves does, and the shade a little blue-green.
function leafy(material: THREE.MeshLambertMaterial) {
  const before = material.onBeforeCompile; // (the tunnel's hole, see treeMesh)
  material.onBeforeCompile = (sh, renderer) => {
    before.call(material, sh, renderer);
    sh.vertexShader = sh.vertexShader.replace(...TUFT_VERTEX).replace(...TUFT_BEGIN)
      .replace('#include <common>', '#include <common>\nattribute vec3 across;\nattribute vec3 along;\nvarying vec3 vAcross;\nvarying vec3 vAlong;')
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  vAcross = normalMatrix * mat3(instanceMatrix) * across;
  vAlong = normalMatrix * mat3(instanceMatrix) * along;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${TUFT_GLSL}\n${NOISE_GLSL}\n${SMALL_LEAVES_GLSL}\nvarying vec3 vAcross;\nvarying vec3 vAlong;\nfloat leafCrease = 1.;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  // (Derivatives first, outside the branches. A tuft only a few pixels across gets
  // no leaves at all.)
  float tw = fwidth(length(vTuft.xy));
  float sd = detail(vTuft.xy * 8., 1.5);
  if (vTuft.z >= 0. && tw < .3) {
    float r = length(vTuft.xy), s = vTuft.z * 6.2832, k = 6.2832 / 5.;
    float a0 = atan(vTuft.y, vTuft.x);
    // The top leaves have lobed edges of their own; the edges between leaves curve a
    // little, as where leaves overlap.
    float topEdge = .44 + .1 * cos(5. * (a0 + s) + 3.1416);
    float top = step(r, topEdge);
    float a = a0 + s + top * k * .5 + .7 * r;
    float f = a / k + .5, leaf = floor(f);
    float mid = leaf * k - s - top * k * .5;                        // the leaf's middle
    vec3 T = normalize(vAcross), B = normalize(vAlong), N = normalize(cross(T, B));
    if (dot(N, normal) < 0.) N = -N;
    float rnd = fract(sin(leaf * 12.9 + s * 7.) * 43758.5);
    float tilt = mix(.95, .45, top) * (.6 + .8 * rnd) * smoothstep(.08, .22, r);
    vec3 ln = normalize(N + (T * cos(mid + rnd - .5) + B * sin(mid + rnd - .5)) * tilt);
    normal = normalize(mix(normal, ln, .6));
    float gap = min(fract(f), 1. - fract(f)) * k * r;                // to the next leaf
    float w = tw + .008;
    leafCrease = mix(.78, 1., smoothstep(0., w * 1.5, gap) + (1. - smoothstep(.1, .2, r)))
      * mix(.75, 1., smoothstep(0., w * 1.5, abs(r - topEdge)));
    // Small leaves all over: each a little dome of its own, turned and lit a little
    // differently, which breaks the light up into a fine grain.
    // (Only where they're big enough to see: most of a wood seen from high up is
    // too far for them, and they're the costliest part of a tree.)
    if (sd > .01) {
      vec4 sl = smallLeaves(vTuft.xy * 8.);
      vec2 jit = vec2(hash12(sl.yy * 91.), hash12(sl.yy * 37. + 3.)) - .5;
      normal = normalize(normal + (T * (sl.z * 1.3 + jit.x * .7) + B * (sl.w * 1.3 + jit.y * .7)) * sd);
      leafCrease *= mix(1., (.78 + .38 * sl.y) * mix(.7, 1., smoothstep(0., .12, sl.x)), sd);
    }
  }`)
      .replace('#include <lights_lambert_fragment>', 'diffuseColor.rgb *= leafCrease;\n#include <lights_lambert_fragment>')
      .replace('#include <opaque_fragment>', `outgoingLight *= mix(vec3(.88, 1., 1.06), vec3(1.14, 1.06, .7), smoothstep(.04, .3, dot(outgoingLight, vec3(.3, .59, .11))));
  #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'tufts-cut';
  return material;
}

export function treeMesh({ matrices, colours, count }: TreeInstances) {
  crown ??= crownGeometry();
  // Opened round you, like the buildings, when you're in a tunnel under a park.
  const mat = leafy(cutAway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'trees'));
  const mesh = new THREE.InstancedMesh(crown, mat, count);
  (mesh.instanceMatrix.array as Float32Array).set(matrices);
  if (count) mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
