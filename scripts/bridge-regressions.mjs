// Compare the same assembled bridge paths. An improvement at one end must
// never hide a worse join at the other.
export function bridgeRegressions(before, after) {
  const old = new Map(before.rows.map(r => [r.id, r]));
  const newIds = new Set(after.rows.map(r => r.id));
  if (before.built !== after.built || old.size !== before.rows.length || newIds.size !== after.rows.length
      || old.size !== newIds.size || [...newIds].some(id => !old.has(id))) return [{ reason: 'bridge identities differ' }];
  const result = [];
  for (const r of after.rows) {
    const p = old.get(r.id);
    if (r.break > p.break + .05 || r.joins.some((v, j) => Math.abs(v) > Math.abs(p.joins[j]) + .10))
      result.push({ id: r.id, before: p.joins, after: r.joins, breakBefore: p.break, breakAfter: r.break });
  }
  return result;
}
