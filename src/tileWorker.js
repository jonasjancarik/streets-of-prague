// Builds a tile off the main thread, which then only turns the arrays into meshes:
//   roofs   OSM buildings extruded with straight-skeleton roofs (by far the slowest
//           part of a tile, up to a second or so), with their facade coordinates
//   ipr     IPR's 3D buildings unpacked from the tile's .ipr.bin, with normals and
//           facade coordinates
//   ground  the ground's layers (ground.js)
//   land    trees, walls and the collision grid
// Everything stands on the tile's terrain, sampled from the heights sent along.
import * as THREE from 'three';
import { initRoofs, buildBuildings, wallArrays } from './map/buildings.js';
import { treeInstances } from './map/vegetation.js';
import { Geo, Grid, fillPolys, strokeLines } from './map/geo.js';
import { styleFor, facadeCoords } from './facades.js';
import { groundLayers, layerBuffers } from './ground.js';
import { heightSampler } from './terrain.js';

const RES = 2; // collision grid cells per metre

let roofsReady = null;
let styles = null, stylesOf = '';
// A facade's style by where it is and how tall (facades.js), for this area.
const styleAt = (bbox) => {
  if (stylesOf !== bbox.join()) { styles = styleFor({ bbox_wgs84: bbox }); stylesOf = bbox.join(); }
  return styles;
};
const groundAt = (g) => (g ? heightSampler(g.hm, g.box, g.n, g.step) : () => 0);

async function roofs({ buildings, size, origin, ground, bbox }) {
  await (roofsReady ??= initRoofs());
  const hAt = groundAt(ground);
  // One building at a time, each lifted onto its own ground height (`base`).
  const parts = { position: [], normal: [], color: [], drapeUv: [] };
  for (const b of buildings) {
    const g = buildBuildings({ size, origin, buildings: [b] }).mesh.geometry;
    const pos = g.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) pos[i] += b.base || 0;
    for (const k in parts) parts[k].push(g.attributes[k].array);
  }
  const arrays = {};
  for (const k in parts) {
    const n = parts[k].reduce((a, x) => a + x.length, 0);
    arrays[k] = new Float32Array(n);
    let o = 0;
    for (const x of parts[k]) { arrays[k].set(x, o); o += x.length; }
  }
  arrays.facade = facadeCoords(arrays.position, hAt, styleAt(bbox));
  return arrays;
}

// IPR Praha's 3D buildings for a tile (pipeline/ipr_buildings.py): triangles with
// positions in centimetres from the tile corner and a colour per triangle.
function ipr({ buffer, box: [x0, y0], absolute, ground, bbox }) {
  const n = new DataView(buffer).getUint32(0, true);
  const p16 = new Int16Array(buffer, 8, n * 9);
  const colAt = 8 + n * 18 + ((4 - ((8 + n * 18) % 4)) % 4);
  const c8 = new Uint8Array(buffer, colAt, n * 3);
  const pos = new Float32Array(n * 9), col = new Float32Array(n * 9);
  const c = new THREE.Color();
  for (let t = 0; t < n; t++) {
    c.setRGB(c8[t * 3] / 255, c8[t * 3 + 1] / 255, c8[t * 3 + 2] / 255, THREE.SRGBColorSpace);
    for (let v = 0; v < 3; v++) {
      const i = t * 9 + v * 3;
      const h = p16[i + 1] / 100;
      pos[i] = x0 + p16[i] / 100;
      pos[i + 1] = h;
      pos[i + 2] = -(y0 + p16[i + 2] / 100);
      const k = absolute ? 1 : 0.62 + 0.38 * Math.min(1, h / 6); // older data: darker towards the street
      col[i] = c.r * k; col[i + 1] = c.g * k; col[i + 2] = c.b * k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { position: pos, color: col, normal: g.attributes.normal.array, facade: facadeCoords(pos, groundAt(ground), styleAt(bbox)) };
}

// Walkable/drivable cells: 0 free, 255 solid, 254 free but walled in (a closed
// courtyard). Only cells reachable from the street network (`seeds`: x, y pairs
// along every street and path in the tile) count as free.
function tileGrid(geo, t, seeds) {
  const grid = new Grid(geo, RES, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = '#fff';
    if (t.areas.water) fillPolys(ctx, geo, t.areas.water, s);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.9 * s;
    strokeLines(ctx, geo, t.walls.map((w) => w.pts), s);
    ctx.fillStyle = '#000';
    fillPolys(ctx, geo, [...(t.areas.bridge || []), ...(t.roads.bridge || [])], s);
    ctx.fillStyle = '#fff';
    fillPolys(ctx, geo, t.buildings.map((b) => b.rings), s);
    // Gateways and passages through buildings stay open, a little past both ends
    // (mapped passages often stop just short of the building's edge).
    ctx.strokeStyle = '#000';
    ctx.lineCap = 'square';
    for (const p of t.passages) {
      ctx.lineWidth = p.w * s;
      strokeLines(ctx, geo, [p.pts], s);
    }
  });
  const { w, h, cells } = grid;
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i] > 100 ? 255 : 0;
  const seen = new Uint8Array(cells.length), stack = [];
  for (let s = 0; s < seeds.length; s += 2) {
    const [u, v] = geo.px(seeds[s], seeds[s + 1], RES);
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = j * w + i;
    if (!cells[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
  }
  const visit = (n) => { if (!cells[n] && !seen[n]) { seen[n] = 1; stack.push(n); } };
  while (stack.length) {
    const k = stack.pop(), x = k % w;
    if (x > 0) visit(k - 1);
    if (x < w - 1) visit(k + 1);
    if (k >= w) visit(k - w);
    if (k + w < cells.length) visit(k + w);
  }
  for (let i = 0; i < cells.length; i++) if (!cells[i] && !seen[i]) cells[i] = 254;
  return grid;
}

// Tree trunks are solid.
function stampTrunks(grid, geo, { matrices, count }) {
  for (let i = 0; i < count; i++) {
    const e = matrices.subarray(i * 16, i * 16 + 16);
    const x = e[12], y = -e[14];
    const rad = 0.35 + Math.hypot(e[0], e[1], e[2]) * 0.06;
    const [u, v] = geo.px(x, y, RES);
    const R = Math.ceil(rad * RES);
    for (let j = -R; j <= R; j++) {
      for (let k = -R; k <= R; k++) {
        if (Math.hypot(j, k) > rad * RES) continue;
        const cu = Math.floor(u) + k, cv = Math.floor(v) + j;
        if (cu >= 0 && cv >= 0 && cu < grid.w && cv < grid.h) grid.cells[cv * grid.w + cu] = 255;
      }
    }
  }
}

function land({ data, seeds, ground }) {
  const geo = new Geo(data), hAt = groundAt(ground);
  const trees = treeInstances(geo, hAt);
  const walls = wallArrays(data, hAt);
  const grid = tileGrid(geo, data, seeds);
  stampTrunks(grid, geo, trees);
  return { trees, walls, cells: grid.cells };
}

const JOBS = {
  roofs,
  ipr,
  ground: ({ d, ground, ...opts }) => groundLayers(d, { ...opts, height: ground ? groundAt(ground) : null }),
  land,
};
// The typed arrays in a result, handed back without copying.
const buffers = (type, r) => (type === 'ground' ? layerBuffers(r)
  : type === 'land' ? [r.trees.matrices.buffer, r.trees.colours.buffer, r.walls.position.buffer, r.walls.normal.buffer, r.cells.buffer]
    : Object.values(r).map((a) => a.buffer));

self.onmessage = async (e) => {
  const { id, type, data } = e.data;
  try {
    const result = await JOBS[type](data);
    self.postMessage({ id, result }, buffers(type, result));
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
