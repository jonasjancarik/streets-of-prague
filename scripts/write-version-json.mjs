// Writes version.json at the site root: what is current here, for a game that has been
// open for hours (src/update.ts) and later for the mobile app.
// Usage: node scripts/write-version-json.mjs <outdir> <map> [--fixed]
//   <map> is the data version. With --fixed (the beta) it is the only map accepted;
//   otherwise the accepted maps are deploy/data-oldest to deploy/data-version.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [outdir, map, flag] = process.argv.slice(2);
if (!outdir || !map) { console.error('Usage: node scripts/write-version-json.mjs <outdir> <map> [--fixed]'); process.exit(1); }
const root = new URL('..', import.meta.url).pathname;
const git = (args) => { try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
// The same string vite.config.js gives the game as __APP_VERSION__.
const game = git(['describe', '--tags', '--always', '--dirty']) || 'dev';
const mapFormat = Number(readFileSync(join(root, 'src/data.ts'), 'utf8').match(/^export const DATA_FORMAT = (\d+);/m)?.[1]);
if (!mapFormat) throw new Error('No DATA_FORMAT found in src/data.ts');
const mapsAccepted = flag === '--fixed' ? [map]
  : execFileSync('node', [join(root, 'scripts/check-data-versions.mjs'), '--accepted']).toString().split('\n').filter(Boolean);
const json = { game, built: new Date().toISOString().slice(0, 10), map, mapFormat, mapsAccepted };
writeFileSync(join(outdir, 'version.json'), `${JSON.stringify(json, null, 2)}\n`);
console.log(`version.json: ${game}, map ${map}`);
