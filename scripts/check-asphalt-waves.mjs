#!/usr/bin/env node
// Measure the level-zero asphalt mesh across a named road edge in the game.
// Usage: node scripts/check-asphalt-waves.mjs EDGE LAT,LON [scene options]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [edge, location, ...options] = process.argv.slice(2);
const at = location?.split(',').map(Number);
if (!edge || at?.length !== 2 || !at.every(Number.isFinite)) {
  console.error('Usage: node scripts/check-asphalt-waves.mjs EDGE LAT,LON [--url URL] [--extra "&roadsurfaces&roadraster"]');
  process.exit(2);
}

// Runs in the game with the scene test API. Intersect the actual mesh and
// apply the same coverage cutoff as the raster material.
async function measure(t, id, at) {
  const { world, dev } = window.__drive;
  function coverage(x, y, material) {
    const tex = material.rasterMap;
    if (!tex) return true;
    const { rasterBox: b } = material, { width: w, height: h, data } = tex.image;
    const u = Math.max(0, Math.min(w - 1, (x - b.x) * w / (b.z - b.x) - .5));
    const v = Math.max(0, Math.min(h - 1, (y - b.y) * h / (b.w - b.y) - .5));
    const i = Math.floor(u), j = Math.floor(v), a = u - i, c = v - j;
    const i1 = Math.min(w - 1, i + 1), j1 = Math.min(h - 1, j + 1);
    return ((data[j*w+i] * (1-a) + data[j*w+i1] * a) * (1-c)
      + (data[j1*w+i] * (1-a) + data[j1*w+i1] * a) * c) > 127.5;
  }
  function meshHeight(x, y, mesh) {
    if (!coverage(x, y, mesh.material)) return;
    const p = mesh.geometry.attributes.position.array, index = mesh.geometry.index.array;
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i]*3, b = index[i+1]*3, c = index[i+2]*3;
      const u = p[b]-p[a], v = p[a+2]-p[b+2], r = p[c]-p[a], s = p[a+2]-p[c+2];
      const dx = x-p[a], dy = y+p[a+2], det = u*s-v*r;
      if (Math.abs(det) < 1e-8) continue;
      const k = (dx*s-dy*r)/det, l = (u*dy-v*dx)/det;
      if (k >= 0 && l >= 0 && k+l <= 1) return p[a+1]*(1-k-l) + p[b+1]*k + p[c+1]*l;
    }
  }

  t.paused = true;
  await t.camera({ at, height: 100, tilt: 0, heading: 0 });
  const edges = [...world.loaded.values()].flatMap(tile => tile.source.t.drive ?? []);
  const edge = edges.filter(e => e.id === id).sort((a, b) => b.pts.length - a.pts.length)[0];
  if (!edge || edge.pts.length < 2 || edge.bridge || edge.tunnel || edge.level || edge.levels)
    throw new Error(`Expected a loaded ground-level edge ${id} near ${at}`);

  const along = .5, across = .25;
  const offsets = Math.ceil(Math.max(6, edge.width / 2 + 2, ...(edge.kerb ?? []).map(w => w + 2)) / across);
  const rows = [], errors = [], modes = new Set();
  let s0 = 0, windowEnd = 0, meshes = new Map();
  for (let i = 1; i < edge.pts.length; i++) {
    const [x0, y0] = edge.pts[i-1], [x1, y1] = edge.pts[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    if (!length) continue;
    const ux = (x1-x0)/length, uy = (y1-y0)/length;
    for (let station = rows.length*along; station < s0+length; station = rows.length*along) {
      const x = x0 + ux*(station-s0), y = y0 + uy*(station-s0);
      if (station >= windowEnd) {
        await t.camera({ at: dev.toLonLat(x, y).reverse() });
        windowEnd = station + 65;
        meshes = new Map();
      }
      const row = new Map();
      rows.push(row);
      for (const direction of [-1, 1]) for (let k = direction === -1 ? 0 : 1; k <= offsets; k++) {
        if (!row.has(0) && direction === 1) break;
        const j = k*direction, d = j*across, px = x-d*uy, py = y+d*ux;
        const tile = world.tileAt(px, py);
        if (!tile) break;
        if (!meshes.has(tile)) {
          // Same asphalt colour as ground.ts. The higher order wins if a
          // surveyed asphalt square underlaps the carriageway.
          meshes.set(tile, (tile.drawn?.surfaces?.group.children ?? [])
            .filter(m => m.visible && m.material?.color?.getHexString() === '6b6a68' && m.renderOrder <= -1000)
            .sort((a, b) => b.renderOrder - a.renderOrder));
        }
        let sampled = false;
        for (const m of meshes.get(tile)) {
          const mesh = meshHeight(px, py, m);
          if (mesh === undefined) continue;
          const driving = world.terrainAt(px, py);
          row.set(j, { mesh, driving, x: px, y: py });
          errors.push(Math.abs(mesh - driving));
          modes.add(m.material.rasterMap ? 'raster' : 'vector');
          sampled = true;
          break;
        }
        if (!sampled) break;
      }
    }
    s0 += length;
  }
  if (!errors.length) throw new Error(`No rendered asphalt along ${id}`);
  errors.sort((a, b) => a - b);
  const round = (n) => +n.toFixed(3);
  const waves = [4, 6, 12, 20].map(span => {
    const half = span / (2*along);
    let centreline = null, acrossAsphalt = null;
    for (let i = half; i < rows.length-half; i++) {
      for (const [j, m] of rows[i]) {
        const a = rows[i-half].get(j), b = rows[i+half].get(j);
        if (!a || !b) continue;
        if (rows.slice(i-half+1, i+half).some(row => !row.has(j))) continue;
        const mesh = m.mesh - (a.mesh + b.mesh)/2;
        const driving = m.driving - (a.driving + b.driving)/2;
        const bestCentre = j === 0 && (!centreline || Math.abs(mesh) > Math.abs(centreline.mesh));
        const bestAcross = !acrossAsphalt || Math.abs(mesh) > Math.abs(acrossAsphalt.mesh);
        if (bestCentre || bestAcross) {
          const value = { mesh, driving, station: i*along, offset: j*across, at: dev.toLonLat(m.x, m.y).reverse() };
          if (bestCentre) centreline = value;
          if (bestAcross) acrossAsphalt = value;
        }
      }
    }
    return { span, centreline, acrossAsphalt };
  });
  return { edge: id, name: edge.name, built: world.index.built, asphalt: [...modes], length: round(s0),
    coveredStations: rows.filter(row => row.size).length, stations: rows.length,
    samples: errors.length, meshDrivingP95: round(errors[Math.floor(errors.length*.95)]),
    meshDrivingMax: round(errors.at(-1)), waves };
}

const scene = fileURLToPath(new URL('scene.mjs', import.meta.url));
const code = `return await (${measure})(t, ${JSON.stringify(edge)}, ${JSON.stringify(at)});`;
const result = spawnSync(process.execPath, [scene, 'eval', code, ...options, '--fresh'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
