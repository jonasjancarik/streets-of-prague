// The edges at the tops of the steps in the ground (src/stepEdges.ts), counted over an
// area's tiles without a browser: metres of edge that stop you, metres with a parapet,
// and every street, path or stairs that crosses a step (where the edge is open), by
// kind and by how far the ground drops there. A car street crossing a drop of metres
// is a place where the terrain or the map is wrong: they are listed.
//   node scripts/check-step-edges.mjs [area] [--data public/data] [--list N] [--roadsurfaces file] [--bridgesurfaces file] [--save report.json] [--tiles i_j,i_j]
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decodeHeights, pointLabels, heightSampler, terraceAt, flatTerraces, sampling, stepLineIndex, lineReach } from '../src/terrain.ts';
import { stepEdges } from '../src/stepEdges.ts';
import { readRoadSurfaces, withRoadSurfaces } from '../src/roadSurfaces.ts';
import { bridgeSurfaceBuffers, bridgeSurfaceTile, readBridgeSurfacePreview } from '../src/bridgeSurfacePreview.ts';
import { bridgeApproaches, byLevel } from '../src/roadLevels.ts';
import { clipLine } from '../src/map/geo.ts';

const options = {}, positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key.startsWith('--')) {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    options[key] = value;
  } else positional.push(key);
}
if (options['--sides']) sampling.plane = options['--sides'] === 'plane';
if (options['--lines'] === 'off') sampling.lines = false;
const area = positional[0] ?? 'ujezd', list = Number(options['--list'] ?? 15);
const dir = options['--data'] ? `${options['--data']}/${area}_now/` : new URL(`../public/data/${area}_now/`, import.meta.url).pathname;
const index = JSON.parse(readFileSync(`${dir}index.json`, 'utf8')), { n, step } = index.terrain;
const trial = options['--roadsurfaces'] ? readFileSync(options['--roadsurfaces'], 'utf8') : undefined;
const surfaces = trial !== undefined ? readRoadSurfaces(JSON.parse(trial), index.area, index.built) : null;
if (trial && !surfaces) throw new Error('No road surfaces for this map build');
const bridgeTrial = options['--bridgesurfaces'] ? readFileSync(options['--bridgesurfaces'], 'utf8') : null;
const preview = bridgeTrial ? readBridgeSurfacePreview(JSON.parse(bridgeTrial), index.area, index.built) : null;
if (bridgeTrial && !preview) throw new Error('Bridge surfaces do not match the map build');
const selected = options['--tiles']?.split(',');
if (selected?.some(k => !/^\d+_\d+$/.test(k))) throw new Error('Expected comma-separated tile keys');
const changed = [];
let metres = 0, parapet = 0, tiles = 0, withEdges = 0, rough5 = 0, rough15 = 0, rough15wet = 0, teeth = 0;
const roughest = new Map(), roughAll = [];
const crossings = new Map(), worst = [];
for (const f of selected ? selected.map(k => k + '.json') : readdirSync(`${dir}tiles`)) {
  if (!/^\d+_\d+\.json$/.test(f)) continue;
  const k = f.slice(0, -5), t = bridgeSurfaceTile(JSON.parse(readFileSync(`${dir}tiles/${f}`, 'utf8')), k, preview);
  const hb = [`${dir}tiles/${k}.height.bin.gz`, `${dir}tiles/${k}.height.bin`].find(existsSync);
  if (!hb || !t.terraces?.length) continue;
  tiles++;
  const raw = readFileSync(hb), buf = hb.endsWith('.gz') ? gunzipSync(raw) : raw;
  const { height: ab } = bridgeSurfaceBuffers(t, k, n, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), null, preview);
  const hm = decodeHeights(ab, n, 0, index.terrain.unit), labels = pointLabels(ab, n);
  const side = terraceAt(t.terraces);
  const base = heightSampler(hm, t.box, n, step, labels, side, flatTerraces(t.terraces, 0), stepLineIndex(t.stepLines, 0, lineReach(step)));
  const road = surfaces?.get(k), lower = preview?.ground.get(k);
  const patches = lower ? [...lower, ...(road ?? [])] : road;
  const H = withRoadSurfaces(base, patches, 0, side);
  const ways = [
    ...(t.drive ?? []).filter((e) => !e.bridge && !e.tunnel).flatMap((e) => byLevel(e)
      .flatMap((part) => clipLine(part.pts, t.box).map((pts) => ({ pts, half: e.width / 2 + 2.5, hw: e.hw, car: true, name: e.name })))),
    ...(t.drive ?? []).flatMap((e) => bridgeApproaches(e).map((pts) => ({ pts, half: e.width / 2 + 2.5, hw: e.hw, car: true, name: e.name }))),
    ...(t.walk ?? []).filter((e) => !e.bridge && !e.tunnel).flatMap((e) => clipLine(e.pts, t.box)
      .map((pts) => ({ pts, half: Math.max(1.5, e.width / 2 + 0.5), hw: e.hw, car: false, name: e.name }))),
  ];
  const seen = new Set();
  const edges = stepEdges(t.terraces, t.areas?.water ?? [], H, t.box, ways, (w, x, y, drop) => {
    const id = `${w.hw}/${Math.round(x / 4)}/${Math.round(y / 4)}`;
    if (seen.has(id)) return;
    seen.add(id);
    const key = `${w.car ? 'drive' : 'walk'}:${w.hw}`, c = crossings.get(key) ?? { count: 0, over2: 0 };
    c.count++;
    if (drop >= 2) c.over2++;
    crossings.set(key, c);
    if (w.car) worst.push({ drop, tile: k, x: Math.round(x), y: Math.round(y), hw: w.hw, name: w.name });
  });
  if (patches) {
    const geometry = (e) => JSON.stringify([e.a, e.b, e.nx, e.ny, e.parapet, e.wet]);
    const inspect = (height) => {
      const drops = new Map();
      const retained = stepEdges(t.terraces, t.areas?.water ?? [], height, t.box, ways, (w, x, y, drop) => {
        const key = JSON.stringify([w.car, w.hw, x.toFixed(4), y.toFixed(4)]);
        drops.set(key, Math.max(drops.get(key) ?? 0, drop));
      });
      return { edges: new Set(retained.map(geometry)), drops };
    };
    const before = inspect(base);
    const changes = ({ edges: after, drops }) => ({
      added: [...after].filter((key) => !before.edges.has(key)).length,
      removed: [...before.edges].filter((key) => !after.has(key)).length,
      largerDrops: [...drops].filter(([key, drop]) => drop > (before.drops.get(key) ?? 0) + .05).length,
    });
    const combined = changes(inspect(H));
    if (combined.added || combined.removed || combined.largerDrops) {
      const local = patches.length === 1 ? [{ id: patches[0].id, tile: k, ...combined }]
        : patches.map((p) => ({ id: p.id, tile: k, ...changes(inspect(withRoadSurfaces(base, [p], 0, side))) }))
          .filter((r) => r.added || r.removed || r.largerDrops);
      // If the change needs more than one patch, reject the combination.
      changed.push(...(local.length ? local : patches.map(({ id }) => ({ id, tile: k, ...combined }))));
    }
  }
  if (edges.length) withEdges++;
  for (const e of edges) {
    const len = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    metres += len;
    if (e.parapet) parapet += len;
  }
  // How a parapet's top runs along it, seen from above: a top that jumps up and down
  // from one metre to the next (the height from a lattice cell's corners on one side)
  // throws a sawtooth shadow; an outline that turns back and forth is a wall in teeth.
  for (let s = 0; s < edges.length;) {
    let end = s;
    while (end < edges.length - 1 && !edges[end].last) end++;
    const chain = edges.slice(s, end + 1);
    s = end + 1;
    for (let q = 1; q < chain.length; q++) {
      const p = chain[q - 1], e = chain[q];
      const ux = p.b[0] - p.a[0], uy = p.b[1] - p.a[1], vx = e.b[0] - e.a[0], vy = e.b[1] - e.a[1];
      const turn = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
      if (turn > Math.PI / 3) teeth++;
      if (!p.parapet || !e.parapet || q === chain.length - 1) continue;
      const n2 = chain[q + 1];
      if (!n2.parapet) continue;
      // The top at e.a against the mean of its neighbours a metre either way.
      const dev = Math.abs(e.ha - (p.ha + n2.ha) / 2);
      const len = Math.hypot(vx, vy);
      if (dev > 0.05) rough5 += len;
      if (dev > 0.15) {
        rough15 += len;
        if (e.wet) rough15wet += len;
        if (options['--rough']) roughAll.push([k, Math.round(e.a[0]), Math.round(e.a[1]), +dev.toFixed(2), e.wet ? 1 : 0, +e.drop.toFixed(1)]);
        const cell = `${k}/${Math.round(e.a[0] / 10)}/${Math.round(e.a[1] / 10)}`, was = roughest.get(cell);
        if (!was || was.dev < dev) roughest.set(cell, { dev, tile: k, x: Math.round(e.a[0]), y: Math.round(e.a[1]) });
      }
    }
  }
}
console.log(`${area}: ${tiles} tiles with steps, ${withEdges} with edges that stop you`);
console.log(`  ${Math.round(metres)} m of edge, ${Math.round(parapet)} m with a parapet`);
console.log(`  parapet whose top jumps from the metres either side by over 5 cm: ${Math.round(rough5)} m, over 15 cm: ${Math.round(rough15)} m (${Math.round(rough15wet)} m of it by the water)`);
console.log(`  turns of over 60° along an edge (teeth): ${teeth}, ${(teeth / Math.max(1, metres) * 1000).toFixed(1)} per km`);
console.log('  roughest parapet tops (local x, y):');
for (const r of [...roughest.values()].sort((a, b) => b.dev - a.dev).slice(0, list)) console.log(`    ${r.dev.toFixed(2)} m  tile ${r.tile}  ${r.x}, ${r.y}`);
console.log('  crossings (open edges), and those over a drop of 2 m and more:');
for (const [key, c] of [...crossings].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${key.padEnd(24)} ${String(c.count).padStart(5)} ${String(c.over2).padStart(5)}`);
worst.sort((a, b) => b.drop - a.drop);
console.log(`  car streets over the highest drops (local x, y):`);
for (const w of worst.slice(0, list)) console.log(`    ${w.drop.toFixed(1)} m  tile ${w.tile}  ${w.x}, ${w.y}  ${w.hw}  ${w.name ?? ''}`);

if (options['--rough']) writeFileSync(options['--rough'], JSON.stringify(roughAll));
if (options['--save']) writeFileSync(options['--save'], JSON.stringify({
  built: index.built, edges: { metres, parapet, rough5, rough15, rough15wet, teeth }, patchDigest: trial && createHash('sha256').update(trial).digest('hex'), changed,
  ...(bridgeTrial ? { bridgeDigest: createHash('sha256').update(bridgeTrial).digest('hex') } : {}),
}) + "\n");
