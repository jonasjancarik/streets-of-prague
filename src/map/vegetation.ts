import * as THREE from 'three';
import { Grid, fillPolys, strokeLines, rng } from './geo.ts';
import type { Geo, GeoData, Point2, Polygons } from './geo.ts';
import { NOISE_GLSL } from '../shading.ts';

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
// matrices (standing on the terrain, `height(x, y)`) and colours, for treeMesh. Runs
// in the tile workers.
export function treeInstances(geo: Geo<TreeTileData>, height: (x: number, y: number) => number = () => 0): TreeInstances {
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
    [new THREE.Color('#4d6b35'), new THREE.Color('#3f5a2c'), new THREE.Color('#5a7a3c')],
    [new THREE.Color('#5e8040'), new THREE.Color('#6d8b45'), new THREE.Color('#4f7036')],
    [new THREE.Color('#7f9a52'), new THREE.Color('#8ea85c'), new THREE.Color('#c9c7a0')], // blossom in May
  ];
  const c = new THREE.Color();
  trees.forEach(([x, y, rad, kind], i) => {
    const h = rad * (1.6 + r() * 0.6);
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

// A crown: a few overlapping lumps of leaves round a unit sphere, darker underneath
// and towards the middle, where less light gets in (vertex colours, multiplied by each
// tree's own colour). About 320 triangles, shared by every tree of a tile.
function crownGeometry() {
  const lobes: [number, number, number, number][] = [
    [0, 0.2, 0, 0.72], [0.42, -0.12, 0.18, 0.58], [-0.36, -0.06, 0.3, 0.56], [0.02, -0.14, -0.44, 0.6],
  ];
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const r = rng(7);
  for (const [cx, cy, cz, rad] of lobes) {
    const g = new THREE.IcosahedronGeometry(rad, 1);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    // Nudge the vertices so the lumps aren't perfect balls (the same corner of
    // neighbouring faces moves the same way, so the surface stays closed).
    const bump = new Map<string, number>();
    for (let i = 0; i < p.length; i += 3) {
      const key = `${p[i].toFixed(3)},${p[i + 1].toFixed(3)},${p[i + 2].toFixed(3)}`;
      if (!bump.has(key)) bump.set(key, 0.88 + r() * 0.24);
      const k = bump.get(key)!;
      const x = cx + p[i] * k, y = cy + p[i + 1] * k, z = cz + p[i + 2] * k;
      pos.push(x, y, z);
      nor.push(n[i], n[i + 1], n[i + 2]);
      const up = THREE.MathUtils.smoothstep(y, -0.7, 0.9);
      const out = THREE.MathUtils.smoothstep(Math.hypot(x, y * 0.6, z), 0.3, 0.95);
      const v = 0.42 + 0.58 * up * (0.55 + 0.45 * out);
      col.push(v, v, v);
    }
    g.dispose();
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geom.scale(1, 0.75, 1);
  return geom;
}
let crown: THREE.BufferGeometry | null = null;

// Leaves: the light breaks up into small clumps, and the colour flecks, finer than
// the geometry. Fades out once the clumps get smaller than a pixel.
function leafy(material: THREE.MeshLambertMaterial) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
  vWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWorld;\n${NOISE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  vec2 lq = vWorld.xz * 1.4 + vWorld.y * .9;
  float leafD = detail(lq, 1.);
  diffuseColor.rgb *= 1. + (vnoise(lq * 2.3) - .5) * .5 * leafD;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize(normal + (vec3(vnoise(lq), vnoise(lq + 17.), vnoise(lq + 31.)) - .5) * 1.4 * leafD);`);
  };
  material.customProgramCacheKey = () => 'leafy';
  return material;
}

export function treeMesh({ matrices, colours, count }: TreeInstances) {
  crown ??= crownGeometry();
  const mat = leafy(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const mesh = new THREE.InstancedMesh(crown, mat, count);
  (mesh.instanceMatrix.array as Float32Array).set(matrices);
  if (count) mesh.instanceColor = new THREE.InstancedBufferAttribute(colours, 3);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
