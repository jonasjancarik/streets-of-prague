#!/usr/bin/env node
// The ground a TIN has to match in stage 1 of docs/terrain-tin-plan.md: today's heights,
// read through the game's own sampler (src/terrain.ts) as the worker drapes the ground
// with them, so pipeline/tin.py triangulates exactly what is drawn. Per tile it writes
//   <k>.grid.bin: float32 heights on a grid every GRID m, each on its own side of the
//                 steps, then a uint8 side label per point and a uint8 1 where it is
//                 paved (carriageways, pavements, paths, car parks), row by row from the
//                 south-west corner;
//   <k>.lines.bin: the steps' outlines inside the tile, a point every LINE m, as float32
//                 x, y (local m), the heights on the left and right, and the labels on
//                 the left and right (float32 too);
//   <k>.json: the box, the grid's size and how many line points there are in each piece.
//
//   node scripts/tin-target.mjs [area, ujezd] [--data public/data] [--out pipeline/.cache/tin/target] [--tiles i_j,…]
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeHeights, pointLabels, heightSampler, terraceAt, flatTerraces, stepLineIndex, lineReach } from '../src/terrain.ts';
import { stepSides } from '../src/stepEdges.ts';
import { clipLine, onPolygons } from '../src/map/geo.ts';

const GRID = 0.5, LINE = 0.25, ASIDE = 0.05;
const PAVED_ROADS = ['road', 'sett', 'pavement', 'pavement_asphalt', 'path', 'dirt'], PAVED_AREAS = ['parking'];
const options = {}, positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) options[args[i]] = args[++i];
  else positional.push(args[i]);
}
const area = positional[0] ?? 'ujezd';
const dir = `${options['--data'] ?? new URL('../public/data', import.meta.url).pathname}/${area}_now/`;
const out = `${options['--out'] ?? new URL('../pipeline/.cache/tin/target', import.meta.url).pathname}/${area}`;
mkdirSync(out, { recursive: true });
const index = JSON.parse(readFileSync(`${dir}index.json`, 'utf8')), { n, step, unit } = index.terrain;
const selected = options['--tiles']?.split(',');

let count = 0;
for (const f of selected ? selected.map((k) => `${k}.json`) : readdirSync(`${dir}tiles`)) {
  if (!/^\d+_\d+\.json$/.test(f)) continue;
  const k = f.slice(0, -5), t = JSON.parse(readFileSync(`${dir}tiles/${f}`, 'utf8'));
  const hb = [`${dir}tiles/${k}.height.bin.gz`, `${dir}tiles/${k}.height.bin`].find(existsSync);
  if (!hb) continue;
  const raw = readFileSync(hb), buf = hb.endsWith('.gz') ? gunzipSync(raw) : raw;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hm = decodeHeights(ab, n, 0, unit), labels = pointLabels(ab, n);
  const H = heightSampler(hm, t.box, n, step, labels, terraceAt(t.terraces), flatTerraces(t.terraces, 0), stepLineIndex(t.stepLines, 0, lineReach(step), unit));
  const sides = stepSides(t.terraces, t.areas?.water ?? []);
  const at = sides ? sides.at : () => 0;
  const height = (x, y, s) => H(x, y, sides ? s : false);
  const [x0, y0, x1, y1] = t.box;
  const nx = Math.round((x1 - x0) / GRID) + 1, ny = Math.round((y1 - y0) / GRID) + 1;
  const gx = (i) => (i === nx - 1 ? x1 : x0 + i * GRID), gy = (j) => (j === ny - 1 ? y1 : y0 + j * GRID);
  const grid = new Float32Array(nx * ny), side = new Uint8Array(nx * ny), paved = new Uint8Array(nx * ny);
  const onPaved = onPolygons([...PAVED_ROADS.flatMap((r) => t.roads?.[r] ?? []), ...PAVED_AREAS.flatMap((a) => t.areas?.[a] ?? [])]);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = gx(i), y = gy(j), s = at(x, y);
    side[j * nx + i] = s;
    paved[j * nx + i] = onPaved(x, y) ? 1 : 0;
    grid[j * nx + i] = height(x, y, s);
  }
  // The outlines, each segment once (two terraces side by side, or a terrace at the
  // water, share theirs), clipped to the tile.
  const seen = new Set(), pieces = [];
  const key = (p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  for (const rings of sides?.outlines ?? []) for (const ring of rings) {
    const closed = ring.length && key(ring[0]) !== key(ring[ring.length - 1]) ? [...ring, ring[0]] : ring;
    let run = [];
    const flush = () => { if (run.length > 1) pieces.push(...clipLine(run, t.box)); run = []; };
    for (let i = 0; i < closed.length - 1; i++) {
      const a = closed[i], b = closed[i + 1], ka = key(a), kb = key(b);
      if (ka === kb) continue;
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(id)) { flush(); continue; }
      seen.add(id);
      if (!run.length) run.push(a);
      run.push(b);
    }
    flush();
  }
  const lines = [], lengths = [];
  for (const pts of pieces) {
    let m = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nxl = -dy / len, nyl = dx / len, steps = Math.max(1, Math.ceil(len / LINE));
      for (let s = 0; s < steps + (i === pts.length - 2 ? 1 : 0); s++) {
        const x = a[0] + (dx * s) / steps, y = a[1] + (dy * s) / steps;
        const l = at(x + nxl * ASIDE, y + nyl * ASIDE), r = at(x - nxl * ASIDE, y - nyl * ASIDE);
        lines.push(x, y, height(x, y, l), height(x, y, r), l, r);
        m++;
      }
    }
    if (m) lengths.push(m);
  }
  writeFileSync(`${out}/${k}.grid.bin`, Buffer.concat([Buffer.from(grid.buffer), Buffer.from(side.buffer), Buffer.from(paved.buffer)]));
  writeFileSync(`${out}/${k}.lines.bin`, Buffer.from(new Float32Array(lines).buffer));
  writeFileSync(`${out}/${k}.json`, JSON.stringify({ k, i: t.i, j: t.j, box: t.box, grid: GRID, nx, ny, lengths }));
  count++;
}
console.log(`${area}: ${count} tiles written to ${out}`);
