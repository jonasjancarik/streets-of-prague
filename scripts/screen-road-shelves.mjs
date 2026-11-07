// Check each proposed shelf in isolation before assembling a combined preview.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeRegressions } from './bridge-regressions.mjs';

const [currentPath, trialPath, fitsPath, outputPath, out] = process.argv.slice(2);
if (!out) throw new Error('Usage: screen-road-shelves.mjs current.json trial.json trial-report.json screened.json evidence-directory');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, data) => writeFileSync(path, JSON.stringify(data) + '\n');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const current = read(currentPath), trial = read(trialPath), { built, fits } = read(fitsPath);
if (built !== current.built || built !== trial.built || current.area !== trial.area)
  throw new Error('Shelf trial, current preview and report must match the map');
mkdirSync(out, { recursive: true });
const run = (name, args, log, allowed = [0]) => {
  const path = fileURLToPath(new URL('./' + name + '.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw r.error;
  writeFileSync(log, r.stdout + r.stderr);
  if (!allowed.includes(r.status)) throw new Error(`${name} failed. See ${log}`);
  return r.status;
};

const accepted = [], decisions = [];
const currentDigest = digest(currentPath);
for (const [i, c] of fits.entries()) {
  const patch = trial.patches.find(p => p.id === c.id);
  if (!patch || current.patches.some(p => p.id === c.id)) throw new Error('Missing or repeated shelf ' + c.id);
  const dir = join(out, String(i + 1));
  mkdirSync(dir, { recursive: true });
  const file = name => join(dir, name);
  const one = file('one.json'), candidate = { ...current, patches: [patch, ...current.patches] };
  write(one, candidate);
  const near = [current.area, '--near', c.at.join(',') + ',220', '--worst', '0'];
  for (const [variant, sidecar] of [['before', currentPath], ['after', one]]) {
    run('check-road-flatness', [...near, '--roadsurfaces', sidecar, '--save', file(variant + '-roads.json')],
      file(variant + '-roads.log'));
    run('check-bridge-decks', [...near, '--roadsurfaces', sidecar, '--save', file(variant + '-bridges.json')],
      file(variant + '-bridges.log'), [0, 1]); // Existing named-bridge failures also exit 1.
  }
  run('check-step-edges', [current.area, '--roadsurfaces', one, '--tiles', patch.tiles.join(','), '--save', file('steps.json')],
    file('steps.log'));
  const verify = file('verify.json');
  run('verify-road-corridors', [currentPath, one, file('before-roads.json'), file('after-roads.json'), file('steps.json')],
    verify, [0, 1]);
  const { regressions, collisionChanges } = read(verify);
  const a = read(file('before-bridges.json')), b = read(file('after-bridges.json'));
  if (a.built !== built || b.built !== built || a.patchDigest !== currentDigest || b.patchDigest !== digest(one))
    throw new Error('Bridge report does not match the shelf trial');
  const bridges = bridgeRegressions(a, b);
  const keep = !regressions.length && !collisionChanges.length && !bridges.length;
  if (keep) accepted.push(patch);
  decisions.push({ ...c, keep, regressions, collisionChanges, bridges });
  console.log(`${keep ? 'Kept' : 'Rejected'} ${c.name || c.id}`);
}
write(outputPath, { ...current, patches: [...accepted, ...current.patches] });
write(join(out, 'screen.json'), decisions);
console.log(`Kept ${accepted.length} of ${fits.length} shelf fits`);
