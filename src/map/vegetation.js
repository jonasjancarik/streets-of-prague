import * as THREE from 'three';
import { Grid, fillPolys, strokeLines, rng } from './geo.js';

// Land-use classes rasterised at 1 px/m, used to scatter trees.
const WOOD = 200, PARK = 120, ORCHARD = 60;

export function buildTrees(geo) {
  const d = geo.data;
  const grid = new Grid(geo, 1, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const fill = (polys, v) => {
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

  const geom = new THREE.IcosahedronGeometry(1, 1);
  geom.scale(1, 0.75, 1);
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const mesh = new THREE.InstancedMesh(geom, mat, trees.length);
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
    sc.set(rad, rad, rad);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    const pal = colors[kind];
    c.copy(pal[Math.floor(r() * pal.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.05);
    mesh.setColorAt(i, c);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, count: trees.length };
}
