// What the beta (beta.streetsofprague.com) has that the regular game doesn't yet:
// deploy/beta-notes.json, a few lines for players in English and Czech, written when
// deploying to the beta. The game shows them on its start screen (src/testversion.ts).
//
// The notes name the release they were written after ("after"). Once a newer release is
// out, they describe changes the regular game now has too, so the build leaves them out
// until they are written again; the same when the beta is the release itself.
//
// Run by the beta deploy scripts: prints what the notes say, the commits since the last
// release (what the notes should cover) and the commits since the notes were last
// changed, and warns when the notes won't be shown. It never stops a deploy.
// Usage: node scripts/beta-notes.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
const FILE = 'deploy/beta-notes.json';
const git = (args) => { try { return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };

// { notes: { en: string[], cs: string[] } | null, release, why }: `why` says why there are
// no notes, when there are none.
export function betaNotes() {
  const release = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  let file;
  try { file = JSON.parse(readFileSync(join(root, FILE), 'utf8')); } catch (e) { return { notes: null, release, why: `${FILE} can't be read (${e.message})` }; }
  const lines = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s.trim()) : []);
  const en = lines(file.en), cs = lines(file.cs);
  if (release && git(['rev-parse', 'HEAD']) === git(['rev-list', '-n', '1', release])) return { notes: null, release, why: `this commit is the release ${release} itself` };
  if (!en.length) return { notes: null, release, why: 'the notes are empty' };
  if (file.after !== release) return { notes: null, release, why: `the notes were written after ${file.after || 'no release'}, and the latest release is ${release}` };
  // A line missing in Czech is shown in English.
  return { notes: { en, cs: en.map((s, i) => cs[i] || s) }, release, why: '' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { notes, release, why } = betaNotes();
  const since = release ? git(['log', '--oneline', '--no-merges', `${release}..HEAD`]) : '';
  const touched = git(['log', '-n', '1', '--format=%H', '--', FILE]);
  const after = touched ? git(['log', '--oneline', '--no-merges', `${touched}..HEAD`]) : since;
  console.log(`Notes for the beta (${FILE}):`);
  if (notes) for (const line of notes.en) console.log(`  • ${line}`);
  else console.log(`  none shown: ${why}.`);
  console.log(`\nCommits since ${release || 'the start'} (what the notes should cover):\n${since || '  none'}`);
  if (notes && after) console.log(`\nWarning: these commits came after the notes were last changed, so the notes may be behind:\n${after}`);
  if (!notes && since) console.log(`\nWarning: the beta differs from ${release} but shows no notes. Write them in ${FILE} with "after": "${release}" and commit.`);
}
