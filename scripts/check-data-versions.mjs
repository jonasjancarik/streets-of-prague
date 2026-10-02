// Do deploy/data-version, deploy/data-oldest and deploy/data-history agree, and can the
// committed code read the oldest map it claims to work with? Stops a release or deploy
// before it tells players, or the mobile app, a map range that doesn't hold.
// Usage: node scripts/check-data-versions.mjs [--offline]   check (offline: skip R2)
//        node scripts/check-data-versions.mjs --accepted    print data-oldest..data-version
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const lines = (file) => readFileSync(join(root, 'deploy', file), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const history = lines('data-history');
const [version] = lines('data-version');
const [oldest] = lines('data-oldest');
const mode = process.argv[2];
if (mode && mode !== '--offline' && mode !== '--accepted') {
  console.error('Usage: node scripts/check-data-versions.mjs [--offline | --accepted]');
  process.exit(1);
}

const problems = [];
const at = (name, file) => {
  const i = history.indexOf(name);
  if (i < 0) problems.push(`deploy/${file} names ${name || '(nothing)'}, which is not in deploy/data-history. Upload order is recorded there by scripts/upload-data.sh.`);
  return i;
};
const iVersion = at(version, 'data-version');
const iOldest = at(oldest, 'data-oldest');
if (iVersion >= 0 && iOldest > iVersion) {
  problems.push(`deploy/data-oldest (${oldest}) is later than deploy/data-version (${version}): the code can't need a newer map than the one it goes with.`);
}
if (new Set(history).size !== history.length) problems.push('deploy/data-history lists a version twice.');
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }

if (mode === '--accepted') {
  console.log(history.slice(iOldest, iVersion + 1).join('\n'));
  process.exit(0);
}
if (mode !== '--offline') {
  // The oldest map the code claims to play with must really be in the format it reads.
  try {
    execFileSync('node', [join(root, 'scripts/check-data-format.mjs'), `https://data.streetsofprague.com/${oldest}/`], { stdio: 'inherit' });
  } catch {
    console.error(`The oldest map this code claims to work with (deploy/data-oldest: ${oldest}) is not in the format the code reads. Raise deploy/data-oldest to the first map that is.`);
    process.exit(1);
  }
}
console.log(`Maps ${oldest} to ${version} are accepted (${iVersion - iOldest + 1}).`);
