// The edges at the tops of the steps in the ground (src/stepEdges.ts), counted over an
// area's tiles without a browser: metres of edge that stop you, metres with a parapet,
// and every street, path or stairs that crosses a step (where the edge is open), by
// kind and by how far the ground drops there. A car street crossing a drop of metres
// is a place where the terrain or the map is wrong: they are listed.
//   node scripts/check-step-edges.mjs [area] [--list N] [--roadsurfaces file --save report.json]
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { decodeHeights, pointLabels, heightSampler, terraceAt, flatTerraces } from '../src/terrain.ts';
import { stepEdges } from '../src/stepEdges.ts';
import { readRoadSurfaces, withRoadSurfaces } from '../src/roadSurfaces.ts';
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
const area = positional[0] ?? 'ujezd', list = Number(options['--list'] ?? 15);
const dir = new URL(`../public/data/${area}_now/`, import.meta.url).pathname;
const index = JSON.parse(readFileSync(`${dir}index.json`, 'utf8')), { n, step } = index.terrain;
const trial = options['--roadsurfaces'] ? readFileSync(options['--roadsurfaces'], 'utf8') : undefined;
const surfaces = trial !== undefined ? readRoadSurfaces(JSON.parse(trial), index.area, index.built) : null;
if (trial && !surfaces) throw new Error('No road surfaces for this map build');
const changed = [];
let metres = 0, parapet = 0, tiles = 0, withEdges = 0;
const crossings = new Map(), worst = [];
for (const f of readdirSync(`${dir}tiles`)) {
  if (!/^\d+_\d+\.json$/.test(f)) continue;
  const t = JSON.parse(readFileSync(`${dir}tiles/${f}`, 'utf8')), k = f.slice(0, -5);
  const hb = [`${dir}tiles/${k}.height.bin.gz`, `${dir}tiles/${k}.height.bin`].find(existsSync);
  if (!hb || !t.terraces?.length) continue;
  tiles++;
  const raw = readFileSync(hb), buf = hb.endsWith('.gz') ? gunzipSync(raw) : raw;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const hm = decodeHeights(ab, n, 0), labels = pointLabels(ab, n);
  const side = terraceAt(t.terraces);
  const base = heightSampler(hm, t.box, n, step, labels, side, flatTerraces(t.terraces, 0));
  const patches = t.structures?.some((s) => s.kind === 'tunnel') ? undefined : surfaces?.get(k);
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
}
console.log(`${area}: ${tiles} tiles with steps, ${withEdges} with edges that stop you`);
console.log(`  ${Math.round(metres)} m of edge, ${Math.round(parapet)} m with a parapet`);
console.log('  crossings (open edges), and those over a drop of 2 m and more:');
for (const [key, c] of [...crossings].sort((a, b) => b[1].count - a[1].count)) console.log(`    ${key.padEnd(24)} ${String(c.count).padStart(5)} ${String(c.over2).padStart(5)}`);
worst.sort((a, b) => b.drop - a.drop);
console.log(`  car streets over the highest drops (local x, y):`);
for (const w of worst.slice(0, list)) console.log(`    ${w.drop.toFixed(1)} m  tile ${w.tile}  ${w.x}, ${w.y}  ${w.hw}  ${w.name ?? ''}`);

if (options['--save']) writeFileSync(options['--save'], JSON.stringify({
  built: index.built, patchDigest: trial && createHash('sha256').update(trial).digest('hex'), changed,
}) + "\n");
