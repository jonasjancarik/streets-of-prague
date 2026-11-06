// Keep only trial patches that improve an observed street metric and pass the
// same-map checks of all affected streets, approaches and collision edges.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [patchPath, beforePath, afterPath, stepsPath, output, reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error('Usage: node scripts/screen-road-surfaces.mjs trial.json baseline.json trial-roads.json trial-steps.json accepted.json report.json');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const raw = readFileSync(patchPath, 'utf8');
const digest = createHash('sha256').update(raw).digest('hex');
const file = JSON.parse(raw), before = read(beforePath), after = read(afterPath), steps = read(stepsPath);
if ([before, after, steps].some((x) => x.built !== file.built)) throw new Error('Map builds differ');
if (before.terrainMode !== 'base' || before.patchDigest) throw new Error('Baseline must use unmodified terrain');
if (after.patchDigest !== digest || steps.patchDigest !== digest) throw new Error('Reports must test this exact patch file');
const rows = new Map(before.rows.map((r) => [r.id, r]));
if (rows.size !== after.rows.length || after.rows.some((r) => !rows.has(r.id))) throw new Error('Road identities differ');
const limits = {
  step: [1, .25, .04], bump: [.5, .15, .05], lean: [15, 8, 2],
  crown: [1, .3, .05], twist: [12, 5, 2], off: [10, 4, 0],
};
const scores = new Map(file.patches.map((p) => [p.id, { id: p.id, kind: p.kind, improved: [], rejected: [] }]));
for (const row of after.rows) {
  const baseline = rows.get(row.id);
  const ids = row.patches ?? [];
  if (!ids.length && Object.keys(limits).some((k) => row[k] !== baseline[k]))
    throw new Error(`Changed road ${row.id} has no attributed patch`);
  for (const id of ids) {
    const score = scores.get(id);
    if (!score) throw new Error(`Unexpected patch ${id}`);
    if (ids.length > 1) {
      score.rejected.push({ edge: row.id, reason: 'multiple patches on the same road' });
      continue;
    }
    if (row.unsafeApproach) score.rejected.push({ edge: row.id, reason: 'approach grade or bump' });
    for (const [metric, [hard, soft, margin]] of Object.entries(limits)) {
      const was = Math.abs(baseline[metric]), now = Math.abs(row[metric]);
      if ((now > hard && was <= hard) || (now > soft && now > was + margin))
        score.rejected.push({ edge: row.id, metric, was, now });
      if (was > soft && was - now > Math.max(margin, .01))
        score.improved.push({ edge: row.id, metric, was, now });
    }
  }
}
for (const change of steps.changed) {
  if (change.added || change.removed || change.largerDrops)
    scores.get(change.id).rejected.push({ ...change, reason: 'changed barrier or larger crossing drop' });
}
const accepted = file.patches.filter(({ id }) => {
  const { improved, rejected } = scores.get(id);
  return improved.length && !rejected.length;
});
writeFileSync(output, JSON.stringify({ ...file, patches: accepted }) + '\n');
writeFileSync(reportPath, JSON.stringify([...scores.values()], null, 2) + '\n');
console.log(`Retained ${accepted.length} of ${file.patches.length} survey fits`);
