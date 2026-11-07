#!/usr/bin/env node
// Measure the level-zero asphalt mesh across a named road edge in the game.
// Usage: node scripts/check-asphalt-waves.mjs EDGE LAT,LON [scene options]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runs in the game with the scene test API. Intersect the actual mesh and
// apply the same coverage cutoff as the raster material.
async function measure(t, id, at, candidate = null) {
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
  let coverageHash = 2166136261;
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
      for (const j of row.keys()) coverageHash = Math.imul(coverageHash ^ (rows.length * 512 + j), 16777619);
    }
    s0 += length;
  }
  if (!errors.length) throw new Error(`No rendered asphalt along ${id}`);
  errors.sort((a, b) => a - b);
  const round = (n) => +n.toFixed(3);
  const joins = [0, 1].map(() => ({ meshStep: 0, drivingStep: 0, meshWave: 0, drivingWave: 0 }));
  const ends = (i) => [i*along <= 16, (rows.length-1-i)*along <= 16];
  for (let i = 1; i < rows.length; i++) {
    ends(i).forEach((inside, side) => {
      if (!inside) return;
      for (const [j, m] of rows[i]) {
        const a = rows[i-1].get(j);
        if (!a) continue;
        joins[side].meshStep = Math.max(joins[side].meshStep, Math.abs(m.mesh-a.mesh));
        joins[side].drivingStep = Math.max(joins[side].drivingStep, Math.abs(m.driving-a.driving));
      }
    });
  }
  const waves = [4, 6, 12, 20].map(span => {
    const half = span / (2*along);
    let centreline = null, acrossAsphalt = null, acrossDriving = 0;
    for (let i = half; i < rows.length-half; i++) {
      for (const [j, m] of rows[i]) {
        const a = rows[i-half].get(j), b = rows[i+half].get(j);
        if (!a || !b) continue;
        if (rows.slice(i-half+1, i+half).some(row => !row.has(j))) continue;
        const mesh = m.mesh - (a.mesh + b.mesh)/2;
        const driving = m.driving - (a.driving + b.driving)/2;
        acrossDriving = Math.max(acrossDriving, Math.abs(driving));
        if (span === 6) ends(i).forEach((inside, side) => {
          if (!inside) return;
          joins[side].meshWave = Math.max(joins[side].meshWave, Math.abs(mesh));
          joins[side].drivingWave = Math.max(joins[side].drivingWave, Math.abs(driving));
        });
        const bestCentre = j === 0 && (!centreline || Math.abs(mesh) > Math.abs(centreline.mesh));
        const bestAcross = !acrossAsphalt || Math.abs(mesh) > Math.abs(acrossAsphalt.mesh);
        if (bestCentre || bestAcross) {
          const value = { mesh, driving, station: i*along, offset: j*across, at: dev.toLonLat(m.x, m.y).reverse() };
          if (bestCentre) centreline = value;
          if (bestAcross) acrossAsphalt = value;
        }
      }
    }
    return { span, centreline, acrossAsphalt, acrossDriving };
  });
  const guards = candidate?.guard.map(({ id, pts, width, kerb }) => {
    const half = Math.max(1, (width || 6) / 2);
    const [left, right] = (kerb ?? [half, half]).map(w => Math.max(.5, Math.min(w, half) - .75));
    const profile = [];
    let distance = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i-1], [bx, by] = pts[i];
      const length = Math.hypot(bx-ax, by-ay);
      if (length < 1e-5) continue;
      const ux = (bx-ax)/length, uy = (by-ay)/length;
      for (let station = profile.length; station < distance+length; station = profile.length) {
        const x = ax + ux*(station-distance), y = ay + uy*(station-distance);
        profile.push([0, left, -right].map(offset => {
          const px = x-uy*offset, py = y+ux*offset;
          if (!world.tileAt(px, py)?.sample) return null;
          return round(world.terrainAt(px, py));
        }));
      }
      distance += length;
    }
    return { id, profile };
  });
  const active = candidate && candidate.tiles.some(k => candidate.surfaces.get(k)?.some(p => p.id === candidate.id));
  return { edge: id, name: edge.name, built: world.index.built, asphalt: [...modes], length: round(s0),
    coveredStations: rows.filter(row => row.size).length, stations: rows.length,
    samples: errors.length, meshDrivingP95: round(errors[Math.floor(errors.length*.95)]),
    meshDrivingMax: round(errors.at(-1)), coverageHash, waves, joins, guards, active };
}

async function batch(t, measure, manifest, variant) {
  const world = window.__drive.world;
  const surfaces = await world.roadSurfaces;
  if (world.index.built !== manifest.built || !surfaces) throw new Error('Expected the matching road preview');
  const name = { trial: 'road-corridors-trial.json', screened: 'road-corridors.json', baseline: 'road-corridor.json' }[variant];
  const response = await fetch('/data/praha_now/' + name, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read ' + name);
  const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
  const digest = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  const results = [];
  for (const c of manifest.cases) {
    if (variant === 'screened' && !c.tiles.some(k => surfaces.get(k)?.some(p => p.id === c.id))) continue;
    try { results.push(await measure(t, c.edge, c.at, { ...c, surfaces })); }
    catch (e) { results.push({ edge: c.edge, error: String(e) }); }
  }
  return { built: world.index.built, digest, results };
}

const [edge, location, ...options] = process.argv.slice(2);
const at = location?.split(',').map(Number);
let code, flags = [];
if (edge === '--batch' && location && ['baseline', 'trial', 'screened'].includes(options[0])) {
  const variant = options.shift();
  const manifest = JSON.parse(readFileSync(location, 'utf8'));
  code = `return await (${batch})(t, ${measure}, ${JSON.stringify(manifest)}, ${JSON.stringify(variant)});`;
  const stage = { baseline: '', trial: '&roadcorridors=trial', screened: '&roadcorridors' };
  flags = ['--extra', '&roadsurfaces&roadjunctions&roadraster&roadcorridor' + stage[variant]];
} else if (edge && at?.length === 2 && at.every(Number.isFinite)) {
  code = `return await (${measure})(t, ${JSON.stringify(edge)}, ${JSON.stringify(at)});`;
} else {
  console.error('Usage: node scripts/check-asphalt-waves.mjs EDGE LAT,LON [scene options]\n'
    + '       node scripts/check-asphalt-waves.mjs --batch candidates.json baseline|trial|screened [scene options]');
  process.exit(2);
}
const scene = fileURLToPath(new URL('scene.mjs', import.meta.url));
const result = spawnSync(process.execPath, [scene, 'eval', ...options, ...flags, '--fresh', '--stdin'],
  { input: code, stdio: ['pipe', 'inherit', 'inherit'] });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
