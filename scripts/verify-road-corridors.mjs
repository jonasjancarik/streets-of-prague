// The browser screen checks paired road samples. This last gate checks the
// whole assembled road graph and collision edges with the retained sidecar.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [currentPath, candidatePath, oldRoadsPath, newRoadsPath, stepsPath, prunedPath] = process.argv.slice(2);
if (!stepsPath) {
  throw new Error('Usage: verify-road-corridors.mjs current.json retained.json baseline-roads.json retained-roads.json retained-steps.json [pruned.json]');
}
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const current = read(currentPath), candidate = read(candidatePath);
const before = read(oldRoadsPath), after = read(newRoadsPath), steps = read(stepsPath);
if ([candidate, before, after, steps].some(r => r.built !== current.built)
    || before.patchDigest !== digest(currentPath) || after.patchDigest !== digest(candidatePath)
    || steps.patchDigest !== after.patchDigest) throw new Error('Road checks do not match the sidecars');
const old = new Map(before.rows.map(r => [r.id, r]));
if (old.size !== before.rows.length || old.size !== after.rows.length
    || new Set(after.rows.map(r => r.id)).size !== old.size
    || after.rows.some(r => !old.has(r.id))) throw new Error('Road identities differ');

const limits = {
  step: [1, .25, .04], bump: [.5, .15, .05], lean: [15, 8, 2],
  crown: [1, .3, .05], twist: [12, 5, 2], off: [10, 4, 0],
};
const regressions = [];
let changed = 0;
for (const row of after.rows) {
  const prev = old.get(row.id);
  if (Object.keys(limits).some(k => row[k] !== prev[k])) changed++;
  if (row.unsafeApproach && !prev.unsafeApproach) regressions.push({ edge: row.id, reason: 'unsafe approach', patches: row.patches });
  for (const [metric, [hard, soft, tolerance]] of Object.entries(limits)) {
    const a = Math.abs(prev[metric]), b = Math.abs(row[metric]);
    if ((b > hard && a <= hard) || (b > soft && b > a + tolerance))
      regressions.push({ edge: row.id, metric, before: prev[metric], after: row[metric], patches: row.patches });
  }
}
const currentIds = new Set(current.patches.map(p => p.id));
const newIds = new Set(candidate.patches.filter(p => !currentIds.has(p.id)).map(p => p.id));
const causes = [...regressions.map(r => (r.patches ?? []).filter(id => newIds.has(id))),
  ...steps.changed.map(r => newIds.has(r.id) ? [r.id] : [])];
const excluded = causes.every(ids => ids.length) ? [...new Set(causes.flat())] : [];
if (prunedPath && excluded.length) {
  const rejected = new Set(excluded);
  writeFileSync(prunedPath, JSON.stringify({ ...candidate, patches: candidate.patches.filter(p => !rejected.has(p.id)) }) + '\n');
}
console.log(JSON.stringify({ segments: old.size, changed, regressions, collisionChanges: steps.changed, excluded }, null, 2));
if (regressions.length || steps.changed.length) process.exitCode = 1;
