#!/usr/bin/env node
// How well the building-based parking occupancy (src/parkingDemand.ts) matches what TSK
// measured in paid-parking sections. Needs the sample made by scripts/parking-demand-sample.py
// (its path, or $TMPDIR/parking-demand.json):  node scripts/check-parking-demand.mjs [sample.json]
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  const source = readFileSync(new URL(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
}});
const { Demand, occupancy, useOf } = await import('../src/parkingDemand.ts');
const rows = JSON.parse(readFileSync(process.argv[2] ?? `${process.env.TMPDIR ?? '/tmp'}/parking-demand.json`, 'utf8'));
const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? NaN; };
const groups = new Map();
const all = [];
for (const r of rows) {
  const d = new Demand(r.b.map(([x, y, area, h, kind]) => { const s = Math.sqrt(area) / 2; return { kind, h, rings: [[[x - s, y - s], [x + s, y - s], [x + s, y + s], [x - s, y + s]]] }; }));
  let day = 0, night = 0; const fl = { flats: 0, terrace: 0, houses: 0, work: 0 };
  for (const [x, y] of r.samp) {
    const f = d.floors(x, y);
    day += occupancy(f, false) * 100; night += occupancy(f, true) * 100;
    for (const k in fl) fl[k] += f[k];
  }
  const n = r.samp.length, total = Object.values(fl).reduce((a, b) => a + b, 0);
  if (total < 500 * n) continue;
  const dom = Object.entries(fl).sort((a, b) => b[1] - a[1])[0];
  const kind = dom[1] / total > 0.6 ? dom[0] : 'mixed';
  const row = { kind, dist: Math.hypot(r.x, r.y), td: r.day, tn: r.night, pd: day / n, pn: night / n, total: total / n };
  all.push(row);
  if (!groups.has(kind)) groups.set(kind, []);
  groups.get(kind).push(row);
}
const report = (name, rs) => {
  if (rs.length < 5) return;
  const e = (a, b) => Math.sqrt(mean(rs.map((r) => (r[a] - r[b]) ** 2)));
  console.log(`${name.padEnd(14)} n=${String(rs.length).padStart(4)}  day TSK ${median(rs.map((r) => r.td)).toFixed(0).padStart(3)} / rule ${median(rs.map((r) => r.pd)).toFixed(0).padStart(3)}   night TSK ${median(rs.map((r) => r.tn)).toFixed(0).padStart(3)} / rule ${median(rs.map((r) => r.pn)).toFixed(0).padStart(3)}   rmse ${e('td', 'pd').toFixed(0)}/${e('tn', 'pn').toFixed(0)}`);
};
for (const [lo, label] of [[0, 'whole city'], [4000, 'outer (>4 km)']]) {
  console.log(`--- ${label}: median measured vs rule, sections grouped by the dominant kind of building`);
  const sub = all.filter((r) => r.dist >= lo);
  for (const [k, rs] of [...groups]) report(k, rs.filter((r) => r.dist >= lo));
  report('all', sub);
  const flat = (a) => mean(sub.map((r) => r[a]));
  const tsk = Math.sqrt(mean(sub.map((r) => (r.td - flat('td')) ** 2)));
  console.log(`   (a fixed number scores rmse ${tsk.toFixed(0)} day; the rule ${Math.sqrt(mean(sub.map((r) => (r.td - r.pd) ** 2))).toFixed(0)})`);
}
