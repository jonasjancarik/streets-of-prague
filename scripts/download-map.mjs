// Download the public game's map of one area into public/data, to work on the game
// without building a map. The pipeline can't rebuild part of a downloaded map (it works
// from its own caches in pipeline/.cache): to change how the map is made, build it with
// pipeline/build_map.sh instead.
//
//   node scripts/download-map.mjs                  centrum (67 MB), the default
//   node scripts/download-map.mjs ujezd            a few streets under Petřín (4 MB)
//   node scripts/download-map.mjs praha            the whole city (about 1 GB, 38,000 files)
//   node scripts/download-map.mjs centrum --countryside   also the land past the map's edge (283 MB)
//   node scripts/download-map.mjs centrum --version 2026-11-12   another uploaded map
//
// The map's version is the one in deploy/data-version, the map production serves. The
// files go into a folder beside the area's and replace nothing: an area already in
// public/data is left alone (move it away first). An interrupted download goes on
// where it stopped when run again.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BASE = 'https://data.streetsofprague.com';
const AREAS = ['ujezd', 'centrum', 'praha'];
// The area's own files besides the tiles. Not every area has every one (ujezd has no
// buses), so a missing one is skipped.
const AREA_FILES = ['index.json', 'names.json', 'leaving.json', 'signals.json', 'lines.json', 'metro.json',
  'buses.json', 'river.json', 'footfall.json', 'footfall.png', 'lamps.bin.gz', 'lit.bin.gz', 'bikes.json',
  'terraces.json', 'districts.json', 'landmarks.json'];

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args.splice(i, 1).length > 0; };
const version = option('version') || (await readFile(join(ROOT, 'deploy/data-version'), 'utf8')).trim();
const countryside = flag('countryside');
const area = args[0] || 'centrum';
if (!AREAS.includes(area) || args.length > 1) {
  console.error(`usage: node scripts/download-map.mjs [${AREAS.join('|')}] [--countryside] [--version YYYY-MM-DD]`);
  process.exit(2);
}

const DATA = join(ROOT, 'public/data');
const final = join(DATA, `${area}_now`);
const temp = join(DATA, `.${area}_now.download-${version}`);
const exists = (p) => stat(p).then(() => true, () => false);
if (await exists(final)) {
  console.error(`public/data/${area}_now is already there: move it away first to download ${version}'s.`);
  process.exit(1);
}

async function get(url, { optional = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 && optional) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (attempt === 4) throw new Error(`${url}: ${e.message}`);
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
  }
}

// One file into `dir`, unless it's there from an earlier, interrupted run.
async function save(dir, path, url, opts) {
  const to = join(dir, path);
  if (await exists(to)) return 0;
  const body = await get(url, opts);
  if (body === null) return 0;
  await mkdir(dirname(to), { recursive: true });
  await writeFile(`${to}.part`, body);
  await rename(`${to}.part`, to);
  return body.length;
}

// Many at once, with a running count.
async function all(jobs, label) {
  let done = 0, bytes = 0, next = 0, shown = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const got = await jobs[next++]();  // (not `bytes += await`: that reads bytes before the wait)
      bytes += got;
      done++;
      if (Date.now() - shown > 2000 || done === jobs.length) {
        shown = Date.now();
        process.stdout.write(`\r  ${label}: ${done} of ${jobs.length} files, ${(bytes / 1e6).toFixed(0)} MB new   `);
      }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  process.stdout.write('\n');
}

const url = (path) => `${BASE}/${version}/${path}`;
console.log(`Downloading ${area}'s map ${version} from ${BASE}/${version}/`);
const index = JSON.parse(await get(url(`${area}_now/index.json`)));
const gz = index.gzip ? '.gz' : '';
const structures = new Set(index.terrain?.structures || []);
const bare = new Set(index.terrain?.bare || []);
const landmarks = JSON.parse((await get(url(`${area}_now/landmarks.json`), { optional: true })) || '[]');

// What the game reads (src/tiles.ts): every tile's JSON and heights, IPR's buildings
// where the index says the tile has them, the levels of bridges and tunnels, and the
// bare ground's heights where there are any.
const files = [...AREA_FILES.map((f) => [f, true]), ...landmarks.map((l) => [l.file, false])];
for (const [i, j, , ipr] of index.tiles) {
  const k = `${i}_${j}`;
  files.push([`tiles/${k}.json`, false]);
  if (index.terrain) files.push([`tiles/${k}.height.bin${gz}`, false]);
  if (ipr) files.push([`tiles/${k}.ipr.bin${gz}`, false]);
  if (structures.has(k)) files.push([`tiles/${k}.levels.bin${gz}`, false]);
  if (bare.has(k)) files.push([`tiles/${k}.bare.bin${gz}`, false]);
}
await all(files.map(([path, optional]) => () => save(temp, path, url(`${area}_now/${path}`), { optional })), `${area}_now`);
// (The paid-parking sections the pipeline read: beside the area, for build_tiles.py.)
await save(DATA, `${area}_parking.json`, url(`${area}_parking.json`), { optional: true });
if (countryside) await all([() => save(DATA, 'countryside/central-bohemia.pmtiles',
  url('countryside/central-bohemia.pmtiles'))], 'countryside');

await rename(temp, final);
console.log(`Done: public/data/${area}_now, map ${version}, built ${index.built}.`);
console.log(`Play it: npm run dev, then http://localhost:5191/?area=${area}`);
