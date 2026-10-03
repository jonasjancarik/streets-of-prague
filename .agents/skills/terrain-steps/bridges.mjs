#!/usr/bin/env node
// Measures and photographs every bridge in bridges.json (list_bridges.py) in the running
// game, through the scene server (scripts/scene.mjs serve; see the scene-testing skill).
//
//   node .agents/skills/terrain-steps/bridges.mjs measure [--save now.json] [--against before.json] [--full "most Legií|Karlův most"]
//   node .agents/skills/terrain-steps/bridges.mjs shots <tag> [--only most-legii,karluv-most]
//
// Common: [--port 5199]. `measure` walks each bridge's longest way every 4 m, from 48 m
// before its first end to 48 m past its last, and reads the height underfoot (of the
// bridge levels there the one nearest to the last sample's height, else the ground). Per bridge it prints: the worst kink (second difference,
// m) and where along the way, the steepest grade between two samples on the deck, and
// the joins: every place deck and ground hand over, with the step in metres. `--against`
// puts another run's numbers beside them. `--full` adds the whole profile of the bridges
// named (B on a deck, g on the ground). `shots` saves <tag>-<slug>-a.png, -b.png (the two
// ends, from the south) and -all.png to the scene server's folder ($TMPDIR/scene).
import { readFileSync, writeFileSync } from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const args = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
const BRIDGES = JSON.parse(readFileSync(new URL('./bridges.json', import.meta.url), 'utf8'));
const run = async (code) => {
  const res = await fetch(`http://127.0.0.1:${args.port || 5199}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'eval', code }) });
  const out = await res.json();
  if (out.error || out.errors?.length) throw new Error(out.error || out.errors.join('\n'));
  return out.value;
};

// (In the page: `t` is window.__test, __drive the game's objects.)
const MEASURE = `
const w = __drive.world, STEP = 4, OUT = 48, out = [];
for (const b of BRIDGES) {
  const p = b.pts.map((q) => q.slice());
  const on = (a, c) => { const d = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1; return [c[0] + (c[0] - a[0]) / d * OUT, c[1] + (c[1] - a[1]) / d * OUT]; };
  p.unshift(on(p[1], p[0])); p.push(on(p[p.length - 2], p[p.length - 1]));
  const pts = [];
  for (let i = 0; i < p.length - 1; i++) {
    const d = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]), n = Math.max(1, Math.round(d / STEP));
    for (let k = 0; k < n; k++) pts.push([p[i][0] + (p[i + 1][0] - p[i][0]) * k / n, p[i][1] + (p[i + 1][1] - p[i][1]) * k / n]);
  }
  pts.push(p[p.length - 1]);
  const third = Math.ceil(pts.length / 3), prof = [];
  for (const [k, at] of [[0, b.a], [1, b.mid], [2, b.b]]) {
    await t.camera({ at, height: 200, tilt: 0, heading: 0 });
    for (const [x, y] of pts.slice(k * third, (k + 1) * third)) {
      // Of the bridge levels here, the one nearest in height to where we've just been:
      // the deck we're walking, not a footbridge under it or a flyover over it.
      const tile = w.tileAt(x, y), g = w.terrainAt(x, y), was = prof.length ? prof[prof.length - 1][0] : g;
      const hs = (tile?.levels ?? []).filter((l) => l.level > 0 && l.grid.at(x, y)).map((l) => w.levelAt(x, y, l.level)).filter((h) => !Number.isNaN(h));
      const h = hs.length ? hs.reduce((best, v) => (Math.abs(v - was) < Math.abs(best - was) ? v : best)) : g;
      prof.push([h, hs.length ? 1 : 0]);
    }
  }
  let kink = 0, kinkAt = 0, grade = 0;
  const joins = [];
  for (let i = 1; i < prof.length - 1; i++) {
    const k = Math.abs(prof[i + 1][0] - 2 * prof[i][0] + prof[i - 1][0]);
    if (k > kink) { kink = k; kinkAt = i; }
  }
  for (let i = 1; i < prof.length; i++) {
    if (prof[i][1] && prof[i - 1][1]) grade = Math.max(grade, Math.abs(prof[i][0] - prof[i - 1][0]) / STEP);
    if (prof[i][1] !== prof[i - 1][1]) joins.push([i * STEP - OUT, +(prof[i][0] - prof[i - 1][0]).toFixed(2)]);
  }
  out.push({ name: b.name, kink: +kink.toFixed(2), kinkAt: kinkAt * STEP - OUT, grade: +(grade * 100).toFixed(1), joins,
    prof: FULL.includes(b.name) ? prof.map((q) => q[0].toFixed(1) + (q[1] ? 'B' : 'g')).join(' ') : undefined });
}
t.camera(null);
return out;`;

const SHOTS = `
const w = __drive.world;
t.time('14:00'); t.weather('clear');
for (const b of BRIDGES) {
  if (ONLY.length && !ONLY.includes(b.slug)) continue;
  for (const [end, at, p] of [['a', b.a, b.pts[0]], ['b', b.b, b.pts[b.pts.length - 1]]]) {
    await t.go(at).catch(() => {});
    await t.camera({ at, height: 200, tilt: 0, heading: 0 });
    // height is relative to the terrain at the target, not an absolute eye elevation.
    // h + 55 below is the stored relative setting; record the actual pose for comparisons.
    const h = w.lowestBridge(p[0], p[1])?.h ?? w.terrainAt(p[0], p[1]);
    await t.camera({ at, height: h + 55, tilt: 55, heading: 0 }); await t.wait(0.5); await t.shot(TAG + '-' + b.slug + '-' + end);
  }
  await t.camera({ at: b.mid, height: 260, tilt: 40, heading: 0 }); await t.wait(0.5); await t.shot(TAG + '-' + b.slug + '-all');
}
t.camera(null);
return 'ok';`;

const head = (extra) => `const BRIDGES = ${JSON.stringify(BRIDGES)};\n${extra}\n`;
if (cmd === 'measure') {
  const now = await run(head(`const FULL = ${JSON.stringify(String(args.full || '').split('|'))};`) + MEASURE);
  if (args.save) writeFileSync(args.save, JSON.stringify(now, null, 1));
  const before = args.against ? new Map(JSON.parse(readFileSync(args.against, 'utf8')).map((r) => [r.name, r])) : null;
  for (const r of now) {
    const o = before?.get(r.name);
    const was = (v) => (o ? `${v} → ` : '');
    console.log(`${r.name.padEnd(27)} kink ${was(o?.kink)}${r.kink} (at ${r.kinkAt})  grade ${was(o?.grade)}${r.grade}%  joins ${o ? JSON.stringify(o.joins) + ' → ' : ''}${JSON.stringify(r.joins)}`);
    if (r.prof) console.log(`   ${r.prof}`);
  }
} else if (cmd === 'shots') {
  if (!pos[0]) throw new Error('shots <tag>');
  console.log(await run(head(`const TAG = ${JSON.stringify(pos[0])}, ONLY = ${JSON.stringify(String(args.only || '').split(',').filter(Boolean))};`) + SHOTS));
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
}
