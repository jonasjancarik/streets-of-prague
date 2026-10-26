#!/usr/bin/env node
// Reads the frames recorded by bench.mjs --hitches --raw and says what each hitch
// was. A hitch is a frame interval over --over ms (default 50) and over twice the
// median. The interval ending at frame n is charged to the work in frame n−1's
// callback, the tasks between the two callbacks (long animation frames), and frame
// n's own callback; each kind of work is reported apart, not added into one cause.
//
//   node scripts/hitch-report.mjs file.json [more.json] [--over 50] [--detail] [--from seated] [--table]
//
// --detail lists every hitch with its neighbours; without it, the totals and the
// ten slowest. --table prints one line a file instead, for comparing runs.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
const files = argv.filter((a) => a.endsWith('.json'));
const OVER = Number(opt('over', 50)), DETAIL = argv.includes('--detail'), FROM = opt('from', 'seated'), TABLE = argv.includes('--table');

const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (x) => (x == null || !Number.isFinite(x) ? '–' : (Math.round(x * 10) / 10).toString());
const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] || 0), 0);

if (TABLE) {
  console.log('file  °C  frames  median/p95/p99/max ms  >50/min  >100  ms over 100 | after warm-up: >100, max | tiles made, tile tasks: max, sum ms (lanes max) | arrival median/max ms | player tile undrawn | 10 s after the jump back: worst ms, over 100, node builds ms (rebuilds)');
  for (const file of files) table(file);
  process.exit(0);
}
function table(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8')), m = raw.meta || {};
  const from = raw.marks.find((x) => x.name === FROM)?.t ?? raw.t0, again = raw.marks.find((x) => x.name === 'again')?.t ?? Infinity;
  const fs = raw.frames.filter((f) => f.t != null), i0 = Math.max(1, fs.findIndex((f) => f.end >= from));
  const ivs = [];
  // (The jump back to the start for the second pass redraws it at once: its first
  // 10 s are left out.)
  for (let n = i0; n < fs.length; n++) if (!(fs[n].end > again && fs[n].end < again + 10000)) ivs.push({ n, dt: fs[n].t - fs[n - 1].t });
  const dts = ivs.map((x) => x.dt), secs = dts.reduce((a, b) => a + b, 0) / 1000;
  const warmEnd = fs.findLast((f) => f.asyncBuildsDone || f.asyncPipesDone)?.end ?? -Infinity;
  const late = ivs.filter((x) => fs[x.n].end > warmEnd + 1000);
  const made = fs.slice(i0).flatMap((f) => f.made || []);
  const task = made.map((x) => (x.ms.meshes || 0) + (x.ms.parkingWait == null ? x.ms.parking || 0 : 0)), lanes = made.map((x) => x.ms.lanes || 0);
  const arrivals = [];
  for (const t of Object.values(raw.tiles)) for (const x of t.drawn) if (x.e >= from && x.wanted != null && !(x.e > again && x.e < again + 10000)) arrivals.push(x.e - x.wanted);
  const big = dts.filter((d) => d > 100);
  // The 10 s after the jump back, kept out of the rest: everything round the start is
  // drawn again at once, the heaviest return visit.
  let jWorst = 0, jOver = 0, jBuild = 0, jRe = 0;
  for (let n = i0; n < fs.length; n++) {
    if (!(fs[n].end > again && fs[n].end < again + 10000)) continue;
    const dt = fs[n].t - fs[n - 1].t;
    jWorst = Math.max(jWorst, dt); if (dt > 100) jOver++;
    jBuild += fs[n].buildMs || 0; jRe += fs[n].rebuilds || 0;
  }
  console.log([file.split('/').pop(), m.temperature, dts.length, [0.5, 0.95, 0.99].map((p) => f1(pct(dts, p))).concat(f1(Math.max(...dts))).join('/'),
    f1(dts.filter((d) => d > Math.max(OVER, 2 * pct(dts, 0.5))).length / (secs / 60)), big.length, Math.round(big.reduce((a, b) => a + b, 0)),
    '|', late.filter((x) => x.dt > 100).length, f1(Math.max(...late.map((x) => x.dt))),
    '|', made.length, f1(Math.max(...task)), Math.round(task.reduce((a, b) => a + b, 0)), `(${f1(Math.max(0, ...lanes))})`,
    '|', `${f1(pct(arrivals, 0.5))}/${f1(Math.max(...arrivals))}`, '|', fs.slice(i0).filter((f) => f.drawnHere === false && !(f.end > again && f.end < again + 10000)).length,
    '|', Number.isFinite(again) ? `${Math.round(jWorst)}  ${jOver}  ${Math.round(jBuild)} (${jRe})` : '–'].join('  '));
}

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const m = raw.meta || {};
  const from = raw.marks.find((x) => x.name === FROM)?.t ?? raw.t0;
  const again = raw.marks.find((x) => x.name === 'again')?.t ?? Infinity;
  const fs = raw.frames.filter((f) => f.t != null);
  const i0 = fs.findIndex((f) => f.end >= from);
  console.log(`\n== ${file}\n${m.name} ${m.backend} ${m.base} seated after ${f1(m.seated)} s, loaded in ${f1(m.loadTime)} s${m.temperature ? `, ${m.temperature} °C` : ''}; long animation frames ${raw.loafSupported ? 'recorded' : 'unsupported (unknown)'}`);

  const ivs = [];
  for (let n = Math.max(1, i0); n < fs.length; n++) ivs.push({ n, dt: fs[n].t - fs[n - 1].t, ret: fs[n].end >= again });
  const med = pct(ivs.map((x) => x.dt), 0.5);
  const limit = Math.max(OVER, 2 * med);
  const secs = (fs.at(-1).t - fs[Math.max(0, i0)].t) / 1000;
  const describe = (set, label) => {
    const dts = set.map((x) => x.dt), h = set.filter((x) => x.dt > limit), h100 = set.filter((x) => x.dt > 100);
    const s = set.length ? (fs[set.at(-1).n].t - fs[set[0].n - 1].t) / 1000 : 0;
    console.log(`${label.padEnd(8)} ${set.length} frames in ${f1(s)} s: median ${f1(pct(dts, 0.5))}, p95 ${f1(pct(dts, 0.95))}, p99 ${f1(pct(dts, 0.99))}, max ${f1(Math.max(...dts))} ms; hitches >${f1(limit)} ms: ${h.length} (${f1(h.length / (s / 60))}/min, ${Math.round(sum(h, 'dt'))} ms in all, mean ${f1(sum(h, 'dt') / (h.length || 1))}), >100 ms: ${h100.length}`);
  };
  describe(ivs, 'all');
  // The loading screen's compileAsync can still be compiling into the drive (it is
  // raced against 10 s): the frames after its last piece are free of it.
  const warmEnd = fs.findLast((f) => f.asyncBuildsDone || f.asyncPipesDone)?.end ?? -Infinity;
  if (warmEnd > from) describe(ivs.filter((x) => fs[x.n].end > warmEnd + 1000), 'after warm-up');
  if (Number.isFinite(again)) {
    describe(ivs.filter((x) => !x.ret), 'first');
    // (The jump back redraws the start at once: its first 10 s are left out here.)
    describe(ivs.filter((x) => x.ret && fs[x.n].end > again + 10000), 'again');
  }

  const win = fs.slice(Math.max(0, i0));
  const tot = (k) => Math.round(sum(win, k) * 10) / 10;
  console.log(`work: node builds ${tot('builds')} (${tot('buildMs')} ms, rebuilds of evicted keys ${tot('rebuilds')}, evictions ${tot('evicted')}); pipelines ${tot('pipes')} (re-created ${tot('pipeRe')}, released ${tot('pipeFree')}), programs ${tot('progs')} (released ${tot('progFree')}), shader modules ${tot('modules')}; in createRenderPipeline ${tot('pipeCallMs')} ms, createShaderModule ${tot('shaderCallMs')} ms, submit ${tot('submitMs')} ms, writeBuffer ${tot('wbMs')} ms`);
  console.log(`async (compileAsync): node builds started ${tot('asyncBuilds')}, finished ${tot('asyncBuildsDone')}; pipelines started ${tot('asyncPipes')}, finished ${tot('asyncPipesDone')}; last finished at ${f1(((win.findLast((f) => f.asyncBuildsDone || f.asyncPipesDone)?.end ?? from) - from) / 1000)} s`);
  const pk = new Map();
  for (const f of win) for (const k of f.pipeKinds || []) pk.set(k, (pk.get(k) || 0) + 1);
  console.log(`new pipelines by kind: ${[...pk].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`).join('; ') || '-'}`);
  console.log(`resources: buffers +${tot('bufs')} (${(sum(win, 'bufBytes') / 1e6).toFixed(1)} MB) −${tot('bufFree')}, textures +${tot('tex')} −${tot('texFree')}; tiles made ${win.reduce((a, f) => a + (f.made?.length || 0), 0)}, drawn ${win.reduce((a, f) => a + (f.drawn?.length || 0), 0)}, undressed ${tot('undressN')} (${tot('undress')} ms), dropped ${tot('dropN')} (${tot('drop')} ms)`);
  console.log(`per frame mean: render ${f1(sum(win, 'render') / win.length)}, before render ${f1(sum(win, 'pre') / win.length)}, traffic ${f1(sum(win, 'traffic') / win.length)}, crowd ${f1(sum(win, 'crowd') / win.length)}, trams ${f1(sum(win, 'trams') / win.length)}, tiles.update ${f1(sum(win, 'world') / win.length)} ms`);
  const kinds = new Map();
  for (const f of win) for (const k of f.kinds || []) { const e = kinds.get(k.kind) || { n: 0, ms: 0, re: 0, max: 0 }; e.n++; e.ms += k.ms; e.re += k.re ? 1 : 0; e.max = Math.max(e.max, k.ms); kinds.set(k.kind, e); }
  for (const [k, e] of [...kinds].sort((a, b) => b[1].ms - a[1].ms)) console.log(`  build ${e.n}× (${e.re} rebuilt) ${Math.round(e.ms)} ms, max ${f1(e.max)}: ${k}`);

  // Tile arrival: from first wanted drawn to drawn.
  const arrivals = [];
  for (const [k, t] of Object.entries(raw.tiles)) t.drawn.forEach((x, v) => { if (x.e >= from && x.wanted != null) arrivals.push({ k, v: v + 1, ms: x.e - x.wanted, laps: x.ms }); });
  const first = arrivals.filter((a) => a.v === 1).map((a) => a.ms), revisits = arrivals.filter((a) => a.v > 1).map((a) => a.ms);
  console.log(`tile arrival (wanted → drawn): first visits ${first.length}, median ${f1(pct(first, 0.5))}, max ${f1(Math.max(...first))} ms; return visits ${revisits.length}, median ${f1(pct(revisits, 0.5))}, max ${f1(revisits.length ? Math.max(...revisits) : NaN)} ms; frames with the player's tile undrawn ${win.filter((f) => f.drawnHere === false).length}/${win.length}`);
  const meshLaps = arrivals.map((a) => a.laps?.meshes).filter((x) => x != null);
  console.log(`  tile insertion on the main thread (assemble's meshes lap): median ${f1(pct(meshLaps, 0.5))}, max ${f1(Math.max(...meshLaps))} ms`);

  // Each hitch: work in the frame before, between, and in the frame itself.
  const hitches = ivs.filter((x) => x.dt > limit);
  const cause = { builds: 0, gpuCalls: 0, tile: 0, sim: 0, between: 0, unknown: 0 };
  const lines = [];
  for (const h of hitches) {
    const a = fs[h.n - 1], b = fs[h.n];
    const cbA = a.end - a.start, gap = b.start - a.end;
    const loafs = raw.loaf.filter((l) => l.s < b.start && l.s + l.d > a.start);
    const scripts = loafs.flatMap((l) => l.scripts).filter((s) => s.d >= 5 && s.s >= a.end - 1 && s.s < b.start);
    const tileBetween = scripts.filter((s) => /make|assemble|dress|build|parking|drop/i.test(s.fn || '') || /tiles/.test(s.url));
    const parts = {
      builds: (a.buildMs || 0) + (b.buildMs || 0),
      gpuCalls: (a.pipeCallMs || 0) + (a.shaderCallMs || 0) + (a.submitMs || 0) + (a.wbMs || 0) + (b.pipeCallMs || 0) + (b.shaderCallMs || 0) + (b.submitMs || 0) + (b.wbMs || 0),
      // (Parking spread over frames, `parkingWait`, isn't in the frame the tile is made.)
      tile: (a.made || []).concat(b.made || []).reduce((s, x) => s + (x.ms?.meshes || 0) + (x.ms?.parkingWait == null ? x.ms?.parking || 0 : 0), 0) + (a.drawn || []).concat(b.drawn || []).reduce((s, x) => s + (x.ms?.meshes || 0), 0) + (a.undress || 0) + (a.drop || 0) + tileBetween.reduce((s, x) => s + x.d, 0),
      sim: (a.traffic || 0) + (a.crowd || 0) + (a.trams || 0) + (a.lamps || 0),
      between: scripts.filter((s) => !tileBetween.includes(s)).reduce((s, x) => s + x.d, 0),
    };
    const top = Object.entries(parts).sort((x, y) => y[1] - x[1])[0];
    const explained = top[1] >= 0.3 * (h.dt - med) ? top[0] : 'unknown';
    cause[explained] += h.dt;
    lines.push({ h, a, b, cbA, gap, parts, explained, scripts });
  }
  // Hitches whose interval the main thread mostly sat out (no script ran for most of
  // the gap): presentation waited on something else, such as the GPU process. How
  // often new pipelines came in the three frames before, against all frames.
  const recentPipes = (n) => [1, 2, 3].some((d) => (fs[n - d]?.pipes || 0) > 0);
  const idle = lines.filter(({ h, a, b, scripts }) => {
    const busy = (b.start - a.start) - (b.start - a.end) + scripts.reduce((x, y) => x + y.d, 0);
    return busy < 0.5 * h.dt;
  });
  const base = ivs.filter((x) => recentPipes(x.n)).length / ivs.length;
  console.log(`idle-gap hitches ${idle.length} (${Math.round(sum(idle.map((x) => x.h), 'dt'))} ms), ${idle.filter((x) => recentPipes(x.h.n)).length} with new pipelines in the 3 frames before (any frame: ${f1(base * 100)}%); over 100 ms: ${idle.filter((x) => x.h.dt > 100).length}, ${idle.filter((x) => x.h.dt > 100 && recentPipes(x.h.n)).length} after new pipelines`);
  console.log(`hitch time by largest recorded part (≥30% of the excess, else unknown): ${Object.entries(cause).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')}`);
  const big = lines.filter((x) => x.h.dt > 100), byCause = {};
  for (const x of big) { const c = `${x.explained}${x.h.ret ? ' (again)' : ''}${fs[x.h.n].end <= warmEnd + 1000 ? ' (warm-up)' : ''}`; byCause[c] = (byCause[c] || 0) + 1; }
  console.log(`over 100 ms by part: ${Object.entries(byCause).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`);
  const show = DETAIL ? lines : [...lines].sort((x, y) => y.h.dt - x.h.dt).slice(0, 10);
  for (const { h, a, b, cbA, gap, parts, explained, scripts } of show) {
    const w = (f) => `cb ${f1(f.end - f.start)} (before render ${f1(f.pre)}, render ${f1(f.render)}) builds ${f.builds}${f.rebuilds ? `/${f.rebuilds} re` : ''} ${f1(f.buildMs)} ms, pipes ${f.pipes}${f.pipeRe ? `/${f.pipeRe} re` : ''}${f.pipeKinds ? ` [${f.pipeKinds.join('; ')}]` : ''} (call ${f1(f.pipeCallMs)})${f.asyncBuildsDone || f.asyncPipesDone ? ` async done ${f.asyncBuildsDone}/${f.asyncPipesDone}` : ''} modules ${f.modules} (call ${f1(f.shaderCallMs)}), submit ${f1(f.submitMs)}, wb ${f.wbN}/${(f.wb / 1e3).toFixed(0)} KB ${f1(f.wbMs)} ms (max ${f1(f.wbMax)}), bufs +${f.bufs}−${f.bufFree} tex +${f.tex}−${f.texFree}, sim ${f1(f.traffic + f.crowd + f.trams)}${f.made ? `, made ${f.made.map((x) => `${x.k} ${JSON.stringify(x.ms)}`).join(' ')}` : ''}${f.drawn ? `, drawn ${f.drawn.map((x) => `${x.k}#${x.visit} ${JSON.stringify(x.ms)}`).join(' ')}` : ''}${f.undressN ? `, undressed ${f.undressN} ${f1(f.undress)} ms` : ''}${f.dropN ? `, dropped ${f.dropN} ${f1(f.drop)} ms` : ''}${f.kinds ? ` [${f.kinds.map((k) => `${k.kind}${k.re ? ' (re)' : ''} ${k.ms}`).join('; ')}]` : ''}`;
    console.log(`\n${f1((fs[h.n].t - from) / 1000)} s ${h.ret ? 'again' : 'first'}: ${f1(h.dt)} ms → ${explained} (${Object.entries(parts).map(([k, v]) => `${k} ${f1(v)}`).join(', ')}); gap between callbacks ${f1(gap)} ms at ${b.kmh} km/h`);
    console.log(`  before: ${w(a)}`);
    console.log(`  this:   ${w(b)}`);
    if (scripts.length) console.log(`  between: ${scripts.map((s) => `${s.inv} ${s.fn || '?'}@${s.url} ${f1(s.d)}`).join(', ')}`);
    const lo = raw.loaf.filter((l) => l.s < b.start && l.s + l.d > a.start);
    if (lo.length) console.log(`  long animation frames: ${lo.map((l) => `at ${f1(l.s - a.start)} for ${f1(l.d)} (blocking ${f1(l.block)}, rendering from ${f1(l.render - l.s)}, style ${f1(l.style - l.s)}, scripts ${f1(l.scripts.reduce((x, y) => x + y.d, 0))}: ${l.scripts.filter((x) => x.d >= 3).map((x) => `${x.inv} ${x.fn || '?'}@${x.url} ${f1(x.d)}`).join(', ') || '-'})`).join('; ')}`);
    else console.log('  no long animation frame overlaps: the main thread was not busy for 50 ms at a stretch');
  }
}
