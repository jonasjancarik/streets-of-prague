#!/usr/bin/env node
// Checks a map's ground meshes (tiles/<k>.tin.bin.gz, pipeline/tin_tiles.py) the way the
// game reads them: src/tin.ts decodes each file, builds the triangles and samples them,
// and the heights are compared with the surface the mesh was fitted to (the tile pass's
// grid every 0.5 m in pipeline/.cache/tin/<map>/surface), each sample on its own side.
// Per tile: points, triangles, breakline pieces the triangulation couldn't keep, the
// time to triangulate, and how far the mesh is off on paved ground and elsewhere.
//
//   node scripts/check-tin.mjs ujezd-lidar [--data public/data] [--surface <dir>] [--tiles i_j,…] [--every 2]
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildTin, decodeTin, tinSampler } from '../src/tin.ts';

const args = process.argv.slice(2), options = {}, positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) options[args[i]] = args[++i];
  else positional.push(args[i]);
}
const map = positional[0] ?? 'ujezd-lidar';
const root = new URL('..', import.meta.url).pathname;
const dir = `${options['--data'] ?? `${root}public/data`}/${map}_now/`;
const index = JSON.parse(readFileSync(`${dir}index.json`, 'utf8'));
if (!index.tin) throw new Error(`${map}: index.json lists no meshes`);
// (The tile pass keeps its work for a map outside public/data beside that map, pipeline/tin_tiles.py --work.)
const work = options['--data'] ? `${options['--data']}/tin-${map}` : `${root}pipeline/.cache/tin/${map}`;
const surface = options['--surface'] ?? `${work}/${index.tin.lidar ? 'surface' : 'surface-nolidar'}`;
const every = Number(options['--every'] ?? 2);
const keys = options['--tiles']?.split(',') ?? index.tin.tiles;
const tol = index.tin.tol, loose = index.tin.loose;

const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const rows = [];
for (const k of keys) {
  const t = JSON.parse(readFileSync(`${dir}tiles/${k}.json`, 'utf8'));
  const raw = gunzipSync(readFileSync(`${dir}tiles/${k}.tin.bin.gz`));
  const f = decodeTin(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), t.box);
  const t0 = performance.now();
  const mesh = buildTin(f);
  const ms = performance.now() - t0;
  const { sample } = tinSampler(mesh, 0, () => NaN);
  const row = { k, points: f.xy.length, triangles: mesh.tri.length / 3, lost: mesh.lost, ms: Math.round(ms), bytes: readFileSync(`${dir}tiles/${k}.tin.bin.gz`).length };
  if (existsSync(`${surface}/${k}.json`)) {
    const meta = JSON.parse(readFileSync(`${surface}/${k}.json`, 'utf8')), { nx, ny, grid: g } = meta;
    const buf = readFileSync(`${surface}/${k}.grid.bin`);
    const h = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + 4 * nx * ny));
    const side = buf.subarray(4 * nx * ny, 5 * nx * ny), paved = buf.subarray(5 * nx * ny, 6 * nx * ny);
    const [x0, y0, x1, y1] = meta.box;
    const errP = [], errO = [];
    let over = 0, missing = 0;
    for (let j = 0; j < ny; j += every) for (let i = 0; i < nx; i += every) {
      const x = i === nx - 1 ? x1 : x0 + i * g, y = j === ny - 1 ? y1 : y0 + j * g, n = j * nx + i;
      const got = sample(x, y, side[n]);
      if (!Number.isFinite(got)) { missing++; continue; }
      const e = Math.abs(got - h[n]);
      (paved[n] ? errP : errO).push(e);
      if (e > 2 * (paved[n] ? tol : loose) + 0.05) over++;
    }
    Object.assign(row, {
      paved95: +pct(errP, 0.95).toFixed(3), pavedMax: +pct(errP, 1).toFixed(3),
      other95: +pct(errO, 0.95).toFixed(3), otherMax: +pct(errO, 1).toFixed(3),
      over, overShare: +(over / (errP.length + errO.length || 1)).toFixed(5), missing,
    });
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
const sum = (f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
console.log(JSON.stringify({ map, tiles: rows.length, points: sum('points'), triangles: sum('triangles'), lost: sum('lost'),
  bytes: sum('bytes'), msTotal: sum('ms'), msMedian: pct(rows.map((r) => r.ms), 0.5), msMax: pct(rows.map((r) => r.ms), 1),
  over: sum('over'), missing: sum('missing') }));
