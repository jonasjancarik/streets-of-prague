// Is a freshly built map fit to replace the one before it? Run at the end of a rebuild,
// before the new folder is swapped in (docs/rebuilding-the-map.md). For every area in
// the new folder it checks, against the same area in the previous folder:
//   - index.json: the format the game reads, and the same tile grid as before;
//   - the number of tiles, and the bytes of each kind of tile file, within a tolerance;
//   - every listed tile: its JSON parses and has every list the game reads, its height,
//     building and bridge/tunnel files unpack and have the length the index implies,
//     and no tile file is left over from a tile that is gone or from an interrupted write;
//   - single tiles that shrank to less than half (a few always do; many mean a lost layer);
//   - the area's other files (lines, metro, signals, lamps…) are still there and readable;
//   - on a sample of tiles: streets still join their neighbours across the tile edge.
// Prints what it found and exits 1 on any problem.
//
// Usage: node scripts/check-map-rebuild.mjs <new folder> <previous folder> [options]
//   (each folder holds the <area>_now folders, like public/data)
//   --areas praha,centrum    only these (default: every area in the new folder)
//   --count-tolerance 0.02   how much the number of tiles may change (share of before)
//   --size-tolerance 0.25    how much the bytes of a kind of file may change
//   --shrunk 0.01            share of tiles allowed to shrink below half their size
//   --sample 400             tiles whose street joins are checked (0: all of them)
//   --new-breaks 2           pairs of neighbours where streets may newly stop at the edge
//                            (a quarter of the number in the previous map is added to it)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const [, value] = args.splice(i, 2);
  return value;
};
const only = option('areas', '');
const countTolerance = Number(option('count-tolerance', 0.02));
const sizeTolerance = Number(option('size-tolerance', 0.25));
const shrunkShare = Number(option('shrunk', 0.01));
const sampleSize = Number(option('sample', 400));
const newBreaks = Number(option('new-breaks', 2));
const [fresh, previous] = args;
if (!fresh || !previous || args.length !== 2 || [countTolerance, sizeTolerance, shrunkShare, sampleSize, newBreaks].some(Number.isNaN)) {
  console.error('Usage: node scripts/check-map-rebuild.mjs <new folder> <previous folder> [--areas a,b] [--count-tolerance 0.02] [--size-tolerance 0.25] [--shrunk 0.01] [--sample 400] [--new-breaks 2]');
  process.exit(2);
}

const root = new URL('..', import.meta.url).pathname;
const gameFormat = Number(readFileSync(join(root, 'src/data.ts'), 'utf8').match(/^export const DATA_FORMAT = (\d+);/m)?.[1]);
// What every tile's JSON lists (ORDER in pipeline/layers.py, without fences, marks and
// drives, which maps built before those existed lack and the game does without).
const LISTS = ['areas', 'lots', 'roads', 'buildings', 'walls', 'rails', 'passages', 'weirs', 'crossings', 'trees', 'drive', 'walk', 'sections'];
const TILE_FILE = /^(-?\d+_-?\d+)\.([a-z0-9.]+)$/;
const KINDS = ['json', 'height.bin.gz', 'ipr.bin.gz', 'levels.bin.gz'];

const problems = [];
const fail = (area, message) => problems.push(`${area}: ${message}`);
const percent = (x) => `${(x * 100).toFixed(1)} %`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const areasIn = (folder) => readdirSync(folder).filter((d) => d.endsWith('_now') && existsSync(join(folder, d, 'index.json'))).map((d) => d.slice(0, -4));

// The sizes of an area's tile files by kind, and per tile JSON.
function sizes(dir) {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const json = new Map();
  const names = new Set();
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = name.match(TILE_FILE);
    names.add(name);
    if (!m || !(m[2] in byKind)) continue;
    const { size } = statSync(join(dir, name));
    byKind[m[2]] += size;
    if (m[2] === 'json') json.set(m[1], size);
  }
  return { byKind, json, names };
}

const unpack = (path) => gunzipSync(readFileSync(path));

// Do the streets of tile a carry on in its neighbour b? Every street of a that reaches
// into b's box must be in b too: under the same id (the pipeline lists a street in every
// tile it touches), or, where the two tiles come from different chunks and the street was
// split at other nodes there, as a street through one of its end nodes (the game joins
// the pieces by these OSM node ids).
function crossing(a, b) {
  const [x0, y0, x1, y1] = b.box;
  const inside = ([x, y]) => x > x0 + 0.5 && x < x1 - 0.5 && y > y0 + 0.5 && y < y1 - 0.5;
  let reaching = 0;
  const missing = [];
  for (const net of ['drive', 'walk']) {
    const there = new Set(b[net].flatMap((e) => [e.id, e.u, e.v]));
    for (const e of a[net]) {
      if (!e.pts.some(inside)) continue;
      reaching++;
      if (!there.has(e.id) && !there.has(e.u) && !there.has(e.v)) missing.push(`${net} ${e.id}`);
    }
  }
  return { reaching, missing };
}

function checkArea(area) {
  const dir = join(fresh, `${area}_now`);
  const before = join(previous, `${area}_now`);
  let index;
  try {
    index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch (e) {
    return fail(area, `index.json can't be read (${e.message})`);
  }
  if ((index.format ?? 1) !== gameFormat) fail(area, `the map has format ${index.format ?? 1} but the game reads format ${gameFormat} (DATA_FORMAT in src/data.ts)`);
  if (!Array.isArray(index.tiles) || !index.tiles.length) return fail(area, 'index.json lists no tiles');
  const keys = index.tiles.map(([i, j]) => `${i}_${j}`);
  const listed = new Set(keys);
  if (listed.size !== keys.length) fail(area, 'index.json lists a tile twice');
  const old = existsSync(join(before, 'index.json')) ? JSON.parse(readFileSync(join(before, 'index.json'), 'utf8')) : null;
  if (!old) fail(area, `there is no ${area}_now/index.json in ${previous} to compare with`);
  else {
    for (const key of ['area', 'tile', 'cols', 'rows', 'origin', 'size', 'iprRef']) {
      if (JSON.stringify(index[key]) !== JSON.stringify(old[key])) fail(area, `index.json "${key}" was ${JSON.stringify(old[key])} and is now ${JSON.stringify(index[key])}`);
    }
    for (const key of ['ipr', 'terrain', 'gzip', 'graphs', 'parkingInTiles']) {
      if (Boolean(index[key]) !== Boolean(old[key])) fail(area, `index.json had "${key}" ${old[key] ? 'set' : 'unset'} and now has it ${index[key] ? 'set' : 'unset'}`);
    }
    const change = (keys.length - old.tiles.length) / old.tiles.length;
    if (Math.abs(change) > countTolerance) fail(area, `${keys.length} tiles, ${old.tiles.length} before (${percent(change)}; allowed ${percent(countTolerance)})`);
    const hadIpr = old.tiles.filter((t) => t[3]).length;
    const hasIpr = index.tiles.filter((t) => t[3]).length;
    if (hadIpr && Math.abs(hasIpr - hadIpr) / hadIpr > countTolerance) fail(area, `${hasIpr} tiles have IPR's buildings, ${hadIpr} before`);
    const hadLevels = old.terrain?.structures?.length ?? 0;
    const hasLevels = index.terrain?.structures?.length ?? 0;
    if (hadLevels && Math.abs(hasLevels - hadLevels) / hadLevels > Math.max(countTolerance, 0.1)) fail(area, `${hasLevels} tiles have bridges or tunnels, ${hadLevels} before`);
  }

  // Every listed tile, read the way the game does.
  const tilesDir = join(dir, 'tiles');
  const now = sizes(tilesDir);
  const lattice = index.terrain ? index.terrain.n ** 2 : 0;
  const withLevels = new Set(index.terrain?.structures ?? []);
  const broken = [];
  const expected = new Set();
  const tile = (k) => JSON.parse(readFileSync(join(tilesDir, `${k}.json`), 'utf8'));
  for (const [i, j, , hasIpr] of index.tiles) {
    const k = `${i}_${j}`;
    let t;
    expected.add(`${k}.json`);
    try {
      t = tile(k);
      if (t.i !== i || t.j !== j) throw new Error(`it says it is tile ${t.i}_${t.j}`);
      const lacking = LISTS.filter((key) => t[key] === undefined);
      if (lacking.length) throw new Error(`no "${lacking.join('", "')}"`);
      if (!(t.buildings.length || Object.keys(t.areas).length || Object.keys(t.roads).length || t.walk.length)) throw new Error('it is empty');
      if (Boolean(t.ipr) !== Boolean(hasIpr)) throw new Error(`index.json says IPR buildings: ${Boolean(hasIpr)}, the tile: ${Boolean(t.ipr)}`);
      if (Boolean(t.structures?.length) !== withLevels.has(k)) throw new Error(`index.json says bridges or tunnels: ${withLevels.has(k)}, the tile: ${Boolean(t.structures?.length)}`);
    } catch (e) {
      broken.push(`${k}.json: ${e.message}`);
      continue;
    }
    const binary = (suffix, check) => {
      const name = `${k}.${suffix}${index.gzip ? '.gz' : ''}`;
      expected.add(name);
      try {
        const raw = readFileSync(join(tilesDir, name));
        check(index.gzip ? gunzipSync(raw) : raw);
      } catch (e) {
        broken.push(`${name}: ${e.code === 'ENOENT' ? 'missing' : e.message}`);
      }
    };
    if (index.terrain) {
      binary('height.bin', (raw) => {
        if (raw.length !== lattice * 3) throw new Error(`${raw.length} bytes, expected ${lattice * 3}`);
        if (raw.subarray(0, lattice * 2).every((b) => b === 0)) throw new Error('every height is zero');
      });
      if (withLevels.has(k)) {
        binary('levels.bin', (raw) => {
          const want = t.structures.length * lattice * 2;
          if (raw.length !== want) throw new Error(`${raw.length} bytes, expected ${want} for ${t.structures.length} levels`);
        });
      }
    }
    if (hasIpr) {
      binary('ipr.bin', (raw) => {
        const [triangles, buildings] = [raw.readUInt32LE(0), raw.readUInt32LE(4)];
        if (triangles !== t.ipr.triangles || buildings !== t.ipr.buildings) throw new Error(`holds ${triangles} triangles of ${buildings} buildings, the tile says ${t.ipr.triangles} of ${t.ipr.buildings}`);
        if (raw.length < 8 + triangles * 18) throw new Error(`${raw.length} bytes is too short for ${triangles} triangles`);
      });
    }
  }
  if (broken.length) fail(area, `${broken.length} tile files are missing or unreadable:\n    ${broken.slice(0, 12).join('\n    ')}${broken.length > 12 ? '\n    …' : ''}`);
  const known = new Set(KINDS.flatMap((kind) => [kind, kind.replace(/\.gz$/, '')]));
  const stray = [...now.names].filter((name) => {
    const m = name.match(TILE_FILE);
    return !m || !listed.has(m[1]) || !known.has(m[2]);
  });
  if (stray.length) fail(area, `${stray.length} files in tiles/ belong to no listed tile (left over, or an interrupted write): ${stray.slice(0, 8).join(', ')}${stray.length > 8 ? ' …' : ''}`);

  // Sizes against the previous map.
  const was = sizes(join(before, 'tiles'));
  for (const kind of KINDS) {
    const [a, b] = [was.byKind[kind], now.byKind[kind]];
    const change = a ? (b - a) / a : (b ? 1 : 0);
    console.log(`  ${kind.padEnd(14)} ${mb(b).padStart(10)}   before ${mb(a).padStart(10)}   ${change >= 0 ? '+' : ''}${percent(change)}`);
    if (Math.abs(change) > sizeTolerance) fail(area, `the .${kind} files are ${mb(b)} together, ${mb(a)} before (${percent(change)}; allowed ${percent(sizeTolerance)})`);
  }
  const shrunk = [...now.json].filter(([k, size]) => was.json.get(k) > 2000 && size < was.json.get(k) / 2).map(([k, size]) => `${k} (${was.json.get(k)} → ${size} bytes)`);
  const allowed = Math.max(3, Math.floor(keys.length * shrunkShare));
  if (shrunk.length) console.log(`  ${shrunk.length} tiles are under half their size before (allowed ${allowed}): ${shrunk.slice(0, 6).join(', ')}${shrunk.length > 6 ? ' …' : ''}`);
  if (shrunk.length > allowed) fail(area, `${shrunk.length} tiles shrank to under half their size (allowed ${allowed}): ${shrunk.slice(0, 12).join(', ')}`);

  // The area's other files: none lost, all readable.
  const others = (folder) => (existsSync(folder) ? readdirSync(folder, { recursive: true }) : [])
    .map(String).filter((name) => !name.startsWith('tiles') && !name.startsWith('cover') && !name.endsWith('.DS_Store') && statSync(join(folder, name)).isFile());
  const have = new Set(others(dir));
  for (const name of new Set([...others(before), 'names.json'])) {
    if (!have.has(name)) { fail(area, `${name} is missing (the previous map has it)`); continue; }
    try {
      const raw = readFileSync(join(dir, name));
      if (!raw.length) throw new Error('it is empty');
      if (name.endsWith('.json')) JSON.parse(raw.toString('utf8'));
      if (name.endsWith('.gz')) gunzipSync(raw);
    } catch (e) {
      fail(area, `${name} can't be read (${e.message})`);
    }
  }

  // Streets across tile edges, on a sample spread evenly over the area. A few streets
  // already stop at a chunk's edge in the previous map (each chunk keeps the streets a
  // car can get out of again, and two chunks can disagree), so what counts is new ones.
  const stride = sampleSize > 0 ? Math.max(1, Math.ceil(keys.length / sampleSize)) : 1;
  const reader = (folder) => {
    const cache = new Map();
    return (k) => {
      if (cache.size > 64) cache.clear();
      if (!cache.has(k)) {
        try { cache.set(k, JSON.parse(readFileSync(join(folder, 'tiles', `${k}.json`), 'utf8'))); } catch { cache.set(k, null); }
      }
      return cache.get(k);
    };
  };
  const [read, readOld] = [reader(dir), reader(before)];
  let pairs = 0, reaching = 0;
  const cut = [], cutBefore = new Set();
  for (let n = 0; n < keys.length; n += stride) {
    const [i, j] = index.tiles[n];
    for (const k of [`${i + 1}_${j}`, `${i}_${j + 1}`, `${i - 1}_${j}`, `${i}_${j - 1}`]) {
      if (!listed.has(k)) continue;
      const [a, b] = [read(keys[n]), read(k)];
      if (!a || !b) continue;
      pairs++;
      const got = crossing(a, b);
      reaching += got.reaching;
      if (!got.missing.length) continue;
      cut.push([`${keys[n]} → ${k}`, `${got.missing.length} of ${got.reaching} (${got.missing.slice(0, 2).join(', ')})`]);
      const [oa, ob] = [readOld(keys[n]), readOld(k)];
      if (oa && ob && crossing(oa, ob).missing.length) cutBefore.add(`${keys[n]} → ${k}`);
    }
  }
  const fresher = cut.filter(([pair]) => !cutBefore.has(pair));
  const allowedBreaks = newBreaks + Math.floor(cutBefore.size / 4);
  console.log(`  streets across tile edges: ${reaching} checked on ${pairs} pairs of neighbours; they stop at ${cut.length} edges, ${cutBefore.size} of which already did`);
  if (!reaching && keys.length > 1) fail(area, 'no street crosses a tile edge anywhere in the sample');
  if (fresher.length > allowedBreaks) fail(area, `streets newly stop at the tile edge between ${fresher.length} pairs of neighbours (allowed ${allowedBreaks}):\n    ${fresher.slice(0, 12).map((c) => c.join(': ')).join('\n    ')}${fresher.length > 12 ? '\n    …' : ''}`);
  else if (fresher.length) console.log(`  new ones (within the ${allowedBreaks} allowed): ${fresher.map((c) => c.join(': ')).join('; ')}`);
  console.log(`  ${keys.length} tiles${old ? ` (${old.tiles.length} before)` : ''}, format ${index.format ?? 1}, built ${index.built ?? '?'} from ${index.pipeline || '?'}`);
}

const areas = only ? only.split(',') : areasIn(fresh);
if (!areas.length) problems.push(`${fresh} holds no <area>_now folder with an index.json`);
for (const area of areasIn(previous)) {
  if (!only && !areas.includes(area)) problems.push(`${area}: the previous map has this area and the new folder doesn't`);
}
for (const area of areas) {
  console.log(`${area}:`);
  const count = problems.length;
  try {
    checkArea(area);
  } catch (e) {
    fail(area, `the check itself failed (${e.stack})`);
  }
  console.log(problems.length === count ? '  ok' : `  ${problems.length - count} problems`);
}
if (problems.length) {
  console.error(`\nMAP CHECK FAILED: do not swap this map in.\n\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('\nThe new map passes: same grid and format, every tile readable, sizes within tolerance, streets joined.');
