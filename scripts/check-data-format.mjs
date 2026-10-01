// Is this map one the committed game code can read? Compares the "format" in each
// area's index.json with DATA_FORMAT in src/data.ts (and that with FORMAT in
// pipeline/layers.py), so a deploy stops before players get a map their game can't read.
// Usage: node scripts/check-data-format.mjs <folder or URL holding the <area>_now folders>
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2];
if (!base) { console.error('Usage: node scripts/check-data-format.mjs <data folder or URL>'); process.exit(1); }
const root = new URL('..', import.meta.url).pathname;
const number = (file, pattern) => {
  const m = readFileSync(join(root, file), 'utf8').match(pattern);
  if (!m) throw new Error(`No format number found in ${file}`);
  return Number(m[1]);
};
const game = number('src/data.ts', /^export const DATA_FORMAT = (\d+);/m);
const pipeline = number('pipeline/layers.py', /^FORMAT = (\d+)$/m);
const problems = [];
if (game !== pipeline) problems.push(`src/data.ts reads format ${game} but pipeline/layers.py writes format ${pipeline}`);

const remote = /^https?:\/\//.test(base);
// A URL can't be listed, so there it's the areas the pipeline knows; only praha must exist.
const areas = remote ? ['praha', 'centrum', 'ujezd']
  : readdirSync(base).filter((d) => d.endsWith('_now') && existsSync(join(base, d, 'index.json'))).map((d) => d.slice(0, -4));
if (!remote && !areas.includes('praha')) problems.push(`${base} has no praha_now/index.json`);
for (const area of areas) {
  let index;
  if (remote) {
    const res = await fetch(new URL(`${area}_now/index.json`, base.endsWith('/') ? base : `${base}/`));
    if (res.status === 404 && area !== 'praha') continue;
    if (!res.ok) { problems.push(`${area}: index.json could not be loaded (${res.status})`); continue; }
    index = await res.json();
  } else index = JSON.parse(readFileSync(join(base, `${area}_now`, 'index.json'), 'utf8'));
  const format = index.format ?? 1;
  console.log(`${area}: format ${format}${index.built ? `, built ${index.built}` : ''}${index.pipeline ? ` from ${index.pipeline}` : ''}`);
  if (format !== game) problems.push(`${area}: the map has format ${format} but the game reads format ${game}`);
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
