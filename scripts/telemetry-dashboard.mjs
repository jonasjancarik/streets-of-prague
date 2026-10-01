#!/usr/bin/env node
// The dashboard for the game's anonymous statistics (docs/telemetry.md): reads the
// reports stored by deploy/worker.js through your `cf` login and writes one HTML page.
//
//   node scripts/telemetry-dashboard.mjs              the last 14 days, then opens the page
//   node scripts/telemetry-dashboard.mjs --days 30
//   node scripts/telemetry-dashboard.mjs --sample     made-up numbers, to see the page
//   --out <file>   where to write it (.telemetry/dashboard.html)     --no-open
//
// Reading needs the "Account Analytics: Read" permission, which the `cf` login doesn't
// have: put an API token with it in ~/.config/streets-of-prague/analytics-token (or in
// CLOUDFLARE_API_TOKEN). Nothing here is public: the page is a file on this machine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMON, SCHEMA } from '../deploy/worker.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '7756b12931ecfb3900a31049e157d706', DATASET = 'streets_telemetry';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DAYS = Math.max(1, Math.min(90, Number(option('--days', 14)) || 14)); // (Analytics Engine keeps three months)
const OUT = resolve(option('--out', join(ROOT, '.telemetry/dashboard.html')));

// ---- The reports ----------------------------------------------------------------
// One stored row back into a report with named fields (the reverse of the Worker).
function named(row) {
  const schema = SCHEMA[row.blob1];
  if (!schema) return null;
  const r = { at: `${row.timestamp.replace(' ', 'T')}Z` };
  COMMON.forEach((name, i) => { r[name] = row[`blob${i + 1}`] ?? ''; });
  schema.blobs.forEach((name, i) => { r[name] = row[`blob${COMMON.length + i + 1}`] ?? ''; });
  schema.doubles.forEach((name, i) => { r[name] = Number(row[`double${i + 1}`] ?? 0); });
  return r;
}

const TOKEN_FILE = join(homedir(), '.config/streets-of-prague/analytics-token');

async function fetchRows() {
  const blobs = COMMON.length + Math.max(...Object.values(SCHEMA).map((s) => s.blobs.length));
  const doubles = Math.max(...Object.values(SCHEMA).map((s) => s.doubles.length));
  const columns = ['timestamp', ...Array.from({ length: blobs }, (_, i) => `blob${i + 1}`), ...Array.from({ length: doubles }, (_, i) => `double${i + 1}`)];
  const sql = `SELECT ${columns.join(', ')} FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${DAYS}' DAY ORDER BY timestamp FORMAT JSON`;
  const token = process.env.CLOUDFLARE_API_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '');
  if (token) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: sql });
    const said = await r.text();
    if (r.ok) return JSON.parse(said).data ?? [];
    // The dataset appears with its first report; before that there is nothing to ask for.
    if (/unknown table|does not exist/i.test(said)) return [];
    console.error(`The statistics could not be read (${r.status}): ${said.trim()}`);
    if (r.status === 401 || r.status === 403) console.error('\nThe API token needs the "Account Analytics: Read" permission for this account.');
    process.exit(1);
  }
  // Without a token, try the `cf` login.
  const file = join(tmpdir(), `streets-telemetry-${process.pid}.sql`);
  writeFileSync(file, sql);
  let out;
  try {
    out = execFileSync('cf', ['analytics_engine', 'sql', 'query', '--file', file, '--quiet'], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const said = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    // The dataset appears with its first report; before that there is nothing to ask for.
    if (/unknown table|does not exist|not found/i.test(said)) return [];
    console.error(said.trim() || e.message);
    console.error(/403|Authorization/.test(said)
      ? `\nThe \`cf\` login may not read the statistics. Create an API token with the "Account Analytics: Read"\npermission and save it in ${TOKEN_FILE} (docs/telemetry.md).`
      : '\nThe statistics could not be read. Is `cf` logged in? Try `cf auth whoami`.');
    process.exit(1);
  }
  const parsed = JSON.parse(out.slice(out.indexOf('{')));
  return parsed.data ?? parsed.result?.data ?? [];
}

// Made-up rows in the stored format, the same every time.
function sampleRows() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = (list) => { let x = rnd() * list.reduce((a, [, w]) => a + w, 0); for (const [v, w] of list) if ((x -= w) < 0) return v; return list[0][0]; };
  const rows = [];
  const put = (at, event, version, session, country, fields) => {
    const old = version === 'v0.3.0';
    const row = { timestamp: at.toISOString().slice(0, 19).replace('T', ' '), blob1: event, blob2: version, blob3: session, blob4: country, blob5: old || parseInt(session, 16) % 4 === 0 ? 'streets.jonasjancarik.cz' : 'streetsofprague.com', blob6: old ? '2026-09-20' : '2026-10-01-b2' };
    SCHEMA[event].blobs.forEach((n, i) => { row[`blob${COMMON.length + 1 + i}`] = String(fields[n] ?? ''); });
    SCHEMA[event].doubles.forEach((n, i) => { row[`double${1 + i}`] = Number(fields[n] ?? 0); });
    rows.push(row);
  };
  const GPUS = [['apple metal-3', 5, 11], ['nvidia geforce rtx 3060', 4, 9], ['intel iris xe graphics', 4, 24], ['amd radeon rx 6600', 2, 10], ['qualcomm adreno 740', 3, 22], ['intel uhd graphics 620', 2, 41], ['ANGLE (Intel, Mesa Intel HD 4000)', 1, 62]];
  for (let i = 0; i < 260; i++) {
    const day = Math.floor(rnd() * rnd() * DAYS), at = new Date(Date.now() - day * 864e5 - rnd() * 6e7);
    const s = i.toString(16).padStart(16, '0'), version = day > DAYS * 0.4 ? 'v0.3.0' : 'v0.4.0', country = pick([['CZ', 60], ['SK', 9], ['DE', 8], ['US', 7], ['GB', 4], ['PL', 3], ['NL', 2]]);
    const [gpu, , base] = GPUS[Math.floor(pick(GPUS.map((g, k) => [k, g[1]])))];
    const touch = /adreno/.test(gpu) || rnd() < 0.08, legacy = /Mesa/.test(gpu);
    const renderer = legacy ? 'WebGL (legacy)' : rnd() < 0.08 ? 'WebGL 2' : 'WebGPU';
    const median = Math.round(base * (0.8 + rnd() * 0.5)), tier = median > 35 ? pick([['lowest', 3], ['low', 2]]) : median > 22 ? pick([['medium', 3], ['low', 1]]) : pick([['high', 5], ['medium', 1], ['ultra', 0.4]]);
    put(at, 'start', version, s, country, {
      renderer, gpu, graphics: rnd() < 0.85 ? 'auto' : tier, tier: touch ? 'medium' : 'high', lang: country === 'CZ' || country === 'SK' ? pick([['cs', 8], ['en', 2]]) : 'en',
      input: touch ? 'touch' : 'keyboard', game: rnd() < 0.3 ? 'continued' : 'new', browser: touch ? pick([['Chrome 152', 3], ['Safari 26', 2]]) : pick([['Chrome 152', 6], ['Edge 152', 2], ['Firefox 151', 2], ['Safari 26', 1]]),
      os: touch ? pick([['Android', 3], ['iOS', 2]]) : pick([['Windows', 6], ['macOS', 3], ['Linux', 1]]), referrer: pick([['', 6], ['www.reddit.com', 2], ['news.ycombinator.com', 1], ['t.co', 1]]),
      loadMs: 4000 + rnd() * 9000 + base * 150, width: touch ? 412 : 1920, height: touch ? 915 : 1080, dpr: touch ? 2.6 : 1, memory: 8, cores: 8,
    });
    if (rnd() < 0.12) continue; // left before anything was added up
    const seconds = Math.round(40 + rnd() * rnd() * 2400), drive = 0.25 + rnd() * 0.5, tram = rnd() < 0.3 ? rnd() * 0.25 : 0;
    put(at, 'frames', version, s, country, { renderer, graphics: 'auto', tier, seq: 1, seconds, frames: Math.round((seconds * 1000) / median), medianMs: median, p95Ms: Math.round(median * (1.3 + rnd())), hitches: Math.round((seconds / 60) * rnd() * (base / 6)), stalls: Math.round(rnd() * 3), tierChanges: Math.round(rnd() * 3), tileFailures: rnd() < 0.05 ? 2 : 0 });
    put(at, 'play', version, s, country, {
      seq: 1, seconds, car: seconds * drive, tram: seconds * tram, taxi: rnd() < 0.1 ? seconds * 0.05 : 0, other: rnd() < 0.15 ? seconds * 0.04 : 0, foot: seconds * (1 - drive - tram) * 0.9,
      metres: seconds * drive * 9, wrecked: Math.round(rnd() * seconds / 90), knocked: Math.round(rnd() * seconds / 60), busted: rnd() < 0.3 ? 1 : 0, wasted: rnd() < 0.2 ? 1 : 0,
      money: 10000 - Math.round(rnd() * 3000), maxStars: Math.floor(rnd() * rnd() * 6), tickets: tram ? Math.round(rnd() * 2) : 0, saves: rnd() < 0.1 ? 1 : 0,
    });
    if (rnd() < 0.3) put(at, 'setting', version, s, country, pick([[{ name: 'Graphics', value: 'medium' }, 3], [{ name: 'Graphics', value: 'low' }, 3], [{ name: 'Graphics', value: 'ultra' }, 1], [{ name: 'Weather', value: 'rain' }, 3], [{ name: 'Weather', value: 'snow' }, 3], [{ name: 'Language', value: 'cs' }, 1], [{ name: 'Sound', value: 'off' }, 2], [{ name: 'Car radio', value: 'off' }, 1]]));
    if (legacy || rnd() < 0.06) put(at, 'error', version, s, country, pick([
      [{ kind: 'WebGPU could not start', message: 'WebGPU device initialization timed out', where: 'at within (/assets/index.js:1:2210)', renderer: '' }, 3],
      [{ kind: 'error', message: "Cannot read properties of undefined (reading 'path')", where: 'at Traffic.spawn (/assets/index.js:1:88120)', renderer }, 2],
      [{ kind: 'graphics lost', message: 'WebGL context lost', where: '', renderer }, 1],
    ]));
  }
  return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// ---- The page -------------------------------------------------------------------
// Everything in `app` runs in the page: it holds every report and adds them up again
// whenever a filter changes.
function app(REPORTS, DAYS) {
  for (const r of REPORTS) r.at = new Date(r.at);
  const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const tally = (xs) => { const m = new Map(); for (const x of xs) m.set(x || 'Unknown', (m.get(x || 'Unknown') ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  // `seq` counts a session's reports and each holds its totals so far: keep the last.
  const lastPer = (reports) => { const m = new Map(); for (const r of reports) if (!m.has(r.session) || m.get(r.session).seq <= r.seq) m.set(r.session, r); return [...m.values()]; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)} %` : '–');
  const num = (x, digits = 0) => (Number.isFinite(x) ? x.toFixed(digits) : '–');

  function addUp(reports) {
    const of = (e) => reports.filter((r) => r.event === e);
    const starts = of('start'), frames = lastPer(of('frames')), play = lastPer(of('play')), errors = of('error'), settings = of('setting');
    const framesBy = new Map(frames.map((f) => [f.session, f]));
    const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.now() - (DAYS - 1 - i) * 864e5).toISOString().slice(0, 10));
    const perDay = new Map(days.map((d) => [d, 0]));
    for (const s of starts) { const d = s.at.toISOString().slice(0, 10); if (perDay.has(d)) perDay.set(d, perDay.get(d) + 1); }
    const FPS = [['60 or more', 60, Infinity], ['40 to 59', 40, 60], ['30 to 39', 30, 40], ['20 to 29', 20, 30], ['Under 20', 0, 20]];
    const total = play.reduce((a, p) => a + p.seconds, 0) || 1;
    const cards = new Map();
    for (const s of starts) {
      const f = framesBy.get(s.session);
      if (!f) continue;
      const name = s.gpu || 'Unknown';
      if (!cards.has(name)) cards.set(name, []);
      cards.get(name).push(f);
    }
    const errorGroups = new Map();
    for (const e of errors) {
      const key = `${e.kind}\n${e.message}`;
      if (!errorGroups.has(key)) errorGroups.set(key, { kind: e.kind, message: e.message, where: e.where, n: 0, sessions: new Set(), versions: new Set(), last: e.at });
      const g = errorGroups.get(key);
      g.n++; g.sessions.add(e.session); g.versions.add(e.version); if (e.at > g.last) g.last = e.at;
    }
    const perHour = (name) => (play.reduce((a, p) => a + p[name], 0) / total) * 3600;
    const did = (test) => pct(play.filter(test).length / (play.length || 1));
    return {
      games: starts.length, sessions: play.length,
      minutes: median(play.map((p) => p.seconds)) / 60,
      loading: median(starts.map((s) => s.loadMs)) / 1000,
      fps: 1000 / median(frames.map((f) => f.medianMs)),
      withErrors: starts.length ? new Set(errors.map((e) => e.session)).size / starts.length : NaN,
      perDay: [...perDay],
      fpsGroups: FPS.map(([label, lo, hi]) => [label, frames.filter((f) => f.medianMs > 0 && 1000 / f.medianMs >= lo && 1000 / f.medianMs < hi).length]),
      renderers: tally(starts.map((s) => s.renderer)),
      tiers: tally(frames.map((f) => f.tier)),
      browsers: tally(starts.map((s) => s.browser.replace(/ \d+$/, ''))),
      systems: tally(starts.map((s) => s.os)),
      countries: tally(starts.map((s) => s.country)).slice(0, 8),
      versions: tally(starts.map((s) => s.version)).slice(0, 8),
      hosts: tally(starts.map((s) => s.host)).slice(0, 8),
      inputs: tally(starts.map((s) => s.input)),
      languages: tally(starts.map((s) => ({ cs: 'Czech', en: 'English' }[s.lang] ?? s.lang))),
      began: tally(starts.map((s) => (s.game === 'continued' ? 'Continued a saved game' : 'New game'))),
      referrers: tally(starts.map((s) => s.referrer || 'Opened directly')).slice(0, 8),
      modes: [['Driving', 'car'], ['On foot', 'foot'], ['On a tram', 'tram'], ['In a taxi', 'taxi'], ['Boat, funicular, metro, helicopter', 'other']].map(([label, k]) => [label, play.reduce((a, p) => a + p[k], 0) / total]),
      cards: [...cards].map(([gpu, fs]) => ({ gpu, n: fs.length, median: median(fs.map((f) => f.medianMs)), p95: median(fs.map((f) => f.p95Ms)), stutters: mean(fs.map((f) => ((f.hitches + f.stalls) / Math.max(1, f.seconds)) * 60)), tier: tally(fs.map((f) => f.tier))[0][0] })).sort((a, b) => b.median - a.median).slice(0, 12),
      errors: [...errorGroups.values()].sort((a, b) => b.sessions.size - a.sessions.size).slice(0, 20),
      settings: tally(settings.map((s) => `${s.name} → ${s.value}`)).slice(0, 12),
      play: [
        ['Distance travelled', `${num(mean(play.map((p) => p.metres)) / 1000, 1)} km a session`],
        ['Cars wrecked', `${num(perHour('wrecked'), 1)} an hour`], ['People knocked over', `${num(perHour('knocked'), 1)} an hour`],
        ['Arrested', `${num(perHour('busted'), 1)} times an hour`], ['Killed', `${num(perHour('wasted'), 1)} times an hour`],
        ['Reached three stars or more', did((p) => p.maxStars >= 3)], ['Rode a tram', did((p) => p.tram > 0)], ['Took a taxi', did((p) => p.taxi > 0)],
        ['Bought a ticket', did((p) => p.tickets > 0)], ['Saved the game by hand', did((p) => p.saves > 0)],
      ],
    };
  }

  const tile = (label, value, note = '') => `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-note">${esc(note)}</div></div>`;
  // A list of bars, one row for each thing. `as`: 'share' shows each count and its part
  // of the total, 'count' the count alone, 'fraction' a number that already is a part.
  function bars(title, rows, { as = 'share', note = '' } = {}) {
    const whole = as === 'share' ? rows.reduce((a, [, n]) => a + n, 0) || 1 : 1, most = Math.max(...rows.map(([, n]) => n / whole), 1e-9);
    const body = rows.length ? rows.map(([label, n]) => {
      const value = as === 'share' ? `${n} · ${pct(n / whole)}` : as === 'count' ? `${n}×` : pct(n);
      return `<div class="bar-row" title="${esc(label)}: ${esc(value)}"><span class="bar-label">${esc(label)}</span><span class="bar-track"><span class="bar" style="width:${((n / whole / most) * 100).toFixed(1)}%"></span></span><span class="bar-value">${esc(value)}</span></div>`;
    }).join('') : '<p class="empty">Nothing reported yet.</p>';
    return `<section class="card"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}</section>`;
  }
  function columns(title, rows) {
    const most = Math.max(...rows.map(([, n]) => n), 1), every = Math.ceil(rows.length / 10);
    const body = rows.map(([day, n], i) => `<div class="col" title="${esc(day)}: ${n}"><span class="col-value">${n || ''}</span><span class="col-bar" style="height:${(n / most) * 100}%"></span><span class="col-label">${i % every === 0 ? esc(`${Number(day.slice(8))}. ${Number(day.slice(5, 7))}.`) : ''}</span></div>`).join('');
    return `<section class="card wide"><h2>${esc(title)}</h2><div class="cols">${body}</div></section>`;
  }
  function table(title, head, rows, note = '') {
    const body = rows.length ? `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="empty">Nothing reported yet.</p>';
    return `<section class="card wide"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${body}</section>`;
  }

  function view(d) {
    return `${d.games ? '' : '<p class="sub">No game matching these filters has reported anything in this period.</p>'}
<div class="tiles">
  ${tile('Games started', String(d.games), `${d.sessions} reported how they went`)}
  ${tile('Typical time played', Number.isFinite(d.minutes) ? `${num(d.minutes, d.minutes < 10 ? 1 : 0)} min` : '–', 'half of the games ran longer')}
  ${tile('Typical loading time', Number.isFinite(d.loading) ? `${num(d.loading, 1)} s` : '–', 'from opening the page to a ready map')}
  ${tile('Typical frame rate', Number.isFinite(d.fps) ? `${num(d.fps)} fps` : '–', 'the middle game’s middle frame')}
  ${tile('Games with an error', pct(d.withErrors))}
</div>
<h3>Players</h3>
<div class="grid">
  ${columns('Games started each day', d.perDay)}
  ${bars('Country', d.countries)}
  ${bars('Where they came from', d.referrers)}
  ${bars('Domain', d.hosts)}
  ${bars('Game version', d.versions)}
  ${bars('Browser', d.browsers)}
  ${bars('System', d.systems)}
  ${bars('Controls', d.inputs.map(([k, n]) => [({ touch: 'Touch screen', keyboard: 'Keyboard' }[k] ?? k), n]))}
  ${bars('Language', d.languages)}
  ${bars('How the game began', d.began)}
</div>
<h3>How well it runs</h3>
<div class="grid">
  ${bars('Frame rate', d.fpsGroups, { note: 'Games by their middle frame, in frames a second.' })}
  ${bars('Renderer', d.renderers)}
  ${bars('Graphics level at the end of the game', d.tiers.map(([k, n]) => [k[0].toUpperCase() + k.slice(1), n]))}
  ${table('Graphics cards, slowest first', ['Graphics card', 'Games', 'Middle frame', 'Slow frames (95th percentile)', 'Stutters a minute', 'Usual graphics level'],
    d.cards.map((c) => [esc(c.gpu), c.n, `${num(c.median)} ms · ${num(1000 / c.median)} fps`, `${num(c.p95)} ms`, num(c.stutters, 1), esc(c.tier)]),
    'A stutter is a frame longer than a tenth of a second.')}
</div>
<h3>What goes wrong</h3>
<div class="grid">
  ${table('Errors, by how many games they hit', ['What', 'Message', 'Games', 'Times', 'Game versions', 'Last seen', 'Where'],
    d.errors.map((e) => [esc(e.kind), esc(e.message), e.sessions.size, e.n, esc([...e.versions].join(', ')), esc(e.last.toISOString().slice(0, 10)), `<code>${esc(e.where)}</code>`]))}
</div>
<h3>What gets played</h3>
<div class="grid">
  ${bars('Time spent', d.modes, { as: 'fraction', note: 'Share of all the time played.' })}
  ${bars('Settings changed', d.settings, { as: 'count', note: 'What players switched to, in the settings or with the G and P keys.' })}
  ${table('In a game', ['', ''], d.play.map(([k, v]) => [esc(k), esc(v)]))}
</div>`;
  }

  // The filters: each lists what was reported, most games first. The choice is kept in
  // the address, so a filtered view survives a reload and can be bookmarked.
  const FILTERS = [['version', 'Game version', 'All versions'], ['host', 'Domain', 'All domains'], ['map', 'Map data', 'All maps']];
  const chosen = new URLSearchParams(location.hash.slice(1));
  const starts = REPORTS.filter((r) => r.event === 'start');
  const box = document.getElementById('filters');
  for (const [key, label, all] of FILTERS) {
    const options = tally(starts.map((s) => s[key]));
    box.insertAdjacentHTML('beforeend', `<label>${esc(label)}<select data-key="${key}"><option value="">${esc(all)}</option>${options.map(([v, n]) => `<option value="${esc(v)}"${chosen.get(key) === v ? ' selected' : ''}>${esc(v)} (${n})</option>`).join('')}</select></label>`);
  }
  const draw = () => {
    const picked = [...box.querySelectorAll('select')].filter((s) => s.value).map((s) => [s.dataset.key, s.value]);
    history.replaceState(null, '', picked.length ? `#${new URLSearchParams(picked)}` : location.pathname + location.search);
    document.getElementById('view').innerHTML = view(addUp(REPORTS.filter((r) => picked.every(([k, v]) => (r[k] || 'Unknown') === v))));
  };
  box.addEventListener('change', draw);
  draw();
}

function page(reports, sample) {
  const made = new Date().toISOString().slice(0, 16).replace('T', ' ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Streets of Prague statistics</title>
<style>
  :root { --plane: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781; --line: #e1e0d9; --bar: #2a78d6; --track: #efeee9; }
  @media (prefers-color-scheme: dark) { :root { --plane: #0d0d0d; --surface: #1a1a19; --ink: #fff; --ink-2: #c3c2b7; --muted: #898781; --line: #2c2c2a; --bar: #3987e5; --track: #262624; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 16px 60px; background: var(--plane); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 1120px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .sub { margin: 0 0 16px; color: var(--ink-2); }
  .sample { display: inline-block; margin-left: 8px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 99px; font-size: 12px; vertical-align: middle; }
  #filters { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 20px; }
  #filters label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--ink-2); }
  #filters select { min-width: 190px; padding: 6px 8px; font: inherit; font-size: 14px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  h3 { margin: 30px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-2); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr)); gap: 12px; }
  .tile, .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .tile-label { color: var(--ink-2); font-size: 13px; }
  .tile-value { font-size: 30px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .tile-note { color: var(--muted); font-size: 12px; min-height: 17px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 12px; }
  .wide { grid-column: 1 / -1; }
  h2 { margin: 0 0 10px; font-size: 15px; }
  .note, .empty { margin: -4px 0 10px; color: var(--muted); font-size: 12.5px; }
  .empty { margin: 0; }
  .bar-row { display: grid; grid-template-columns: minmax(90px, 46%) 1fr auto; gap: 10px; align-items: center; padding: 3px 0; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
  .bar-track { height: 10px; background: var(--track); border-radius: 0 4px 4px 0; }
  .bar { display: block; height: 100%; min-width: 2px; background: var(--bar); border-radius: 0 4px 4px 0; }
  .bar-value { min-width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
  .cols { display: flex; align-items: stretch; gap: 2px; height: 170px; padding-top: 18px; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
  .col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 0; }
  .col-bar { width: 100%; max-width: 34px; min-height: 1px; background: var(--bar); border-radius: 4px 4px 0 0; }
  .col-value { font-size: 11px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .col-label { position: absolute; top: 100%; margin-top: 4px; font-size: 11px; color: var(--muted); white-space: nowrap; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 12px 6px 0; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--ink-2); font-weight: 500; font-size: 12.5px; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-2); word-break: break-word; }
</style></head>
<body><main>
<h1>Streets of Prague statistics${sample ? '<span class="sample">Made-up numbers</span>' : ''}</h1>
<p class="sub">The last ${DAYS} days, read ${made} UTC. Only players who left anonymous statistics switched on are counted.</p>
<div id="filters"></div>
<div id="view"></div>
</main>
<script>(${app.toString()})(${JSON.stringify(reports).replaceAll('<', '\\u003c')}, ${DAYS});</script>
</body></html>
`;
}

const sample = flag('--sample');
const reports = (sample ? sampleRows() : await fetchRows()).map(named).filter(Boolean);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page(reports, sample));
console.log(`${reports.length} reports → ${OUT}`);
if (!flag('--no-open')) { try { execFileSync('open', [OUT]); } catch {} }
