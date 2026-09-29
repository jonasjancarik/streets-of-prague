#!/usr/bin/env node
// How loud the game's city sound is at a place and time, measured offline: the loops in
// public/audio/amb-*.m4a at the gains src/soundmix.ts gives them (the same code the
// game runs), their loudness measured once with ffmpeg (EBU R128, LUFS: loudness as
// heard) and added up as the game mixes them. Busyness comes from the footfall map
// the way the game takes it (within 150 m, / 0.2).
//
//   node .claude/skills/sound-levels/levels.mjs
//     [--places "Old Town:14.4213,50.0875;Kunratice:14.4937,50.0141"] (lon,lat; default: a spread from the centre to the suburbs)
//     [--hours 5.5,12,19.5,2] [--wet 0.8 (rain or snow)] [--area praha]
//     [--clips (every clip in public/audio on its own)]
//     [--wav /tmp/mix (a 20 s WAV of each place and hour, to listen to)]
//
// Per place and hour: the whole mix, the loudest layers, and the birds against the
// rest (the crowd, traffic and night hum), in dB. Needs ffmpeg and the map data
// (public/data/<area>_now/index.json and footfall.png).

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('../../../', import.meta.url).pathname;
const AUDIO = join(ROOT, 'public/audio');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const AREA = args.area || 'praha';
const HOURS = String(args.hours || '5.5,12,19.5,2').split(',').map(Number);
const WET = Number(args.wet || 0);
const PLACES = (args.places || [
  'Old Town Square:14.4213,50.0875', 'Wenceslas Square:14.4265,50.0815', 'Náměstí Míru:14.4372,50.0753',
  'Jiřího z Poděbrad:14.4497,50.0779', 'Vinohrady, Slezská:14.4455,50.0745', 'Dejvice:14.4040,50.1005',
  'Stromovka:14.4230,50.1060', 'Petřín:14.3960,50.0815', 'Letná park:14.4235,50.0955',
  'Barrandov:14.3985,50.0330', 'Kunratice:14.4937,50.0141',
].join(';')).split(';').map((p) => { const [name, ll] = p.split(':'); const [lon, lat] = ll.split(',').map(Number); return { name, lon, lat }; });

const { AMBIENCE, ambienceGains } = await import(join(ROOT, 'src/soundmix.ts'));
const proj4 = createRequire(join(ROOT, 'package.json'))('proj4');
const db = (power) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1).padStart(6) : '   off');

// Each clip's loudness (LUFS), measured once and kept while the file stays the same.
const CACHE = join(ROOT, 'pipeline/.cache/audio/loudness.json');
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
function loudness(file) {
  const path = join(AUDIO, file), st = statSync(path), key = `${file}|${st.size}|${st.mtimeMs}`;
  if (cache[key] === undefined) {
    // (ffmpeg prints the ebur128 summary on stderr.)
    const { stderr } = spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', path, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
    cache[key] = m ? Number(m[1]) : -Infinity;
    mkdirSync(join(ROOT, 'pipeline/.cache/audio'), { recursive: true });
    writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  }
  return cache[key];
}

if (args.clips) {
  const files = readdirSync(AUDIO).filter((f) => /\.(m4a|wav)$/.test(f)).sort();
  console.log('Each clip on its own, at full scale (LUFS):');
  for (const f of files) console.log(`  ${f.padEnd(20)} ${fmt(loudness(f))}`);
  console.log();
}

// Busyness: the footfall map (grey = square root of the share), as src/footfall.ts reads it.
const meta = JSON.parse(readFileSync(join(ROOT, `public/data/${AREA}_now/footfall.json`), 'utf8'));
const [W, H] = meta.size, [X0, , , Y1] = meta.box, CELL = meta.cell;
const grey = execFileSync('ffmpeg', ['-v', 'error', '-i', join(ROOT, `public/data/${AREA}_now/footfall.png`), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
const share = (i, j) => (grey[Math.min(H - 1, Math.max(0, j)) * W + Math.min(W - 1, Math.max(0, i))] / 255) ** 2;
function at(x, y) {
  const fx = (x - X0) / CELL - 0.5, fy = (Y1 - y) / CELL - 0.5, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
  return (share(i, j) * (1 - tx) + share(i + 1, j) * tx) * (1 - ty) + (share(i, j + 1) * (1 - tx) + share(i + 1, j + 1) * tx) * ty;
}
function busyAt(x, y, r = 150) {
  let sum = 0, n = 0;
  const step = Math.max(CELL, r / 12);
  for (let dx = -r; dx <= r; dx += step) for (let dy = -r; dy <= r; dy += step) {
    if (dx * dx + dy * dy > r * r) continue;
    sum += at(x + dx, y + dy);
    n++;
  }
  return Math.min(1, sum / n / 0.2);
}
// The game's local metres: a transverse Mercator centred on the area (as in main.ts).
const [w0, s0, e0, n0] = JSON.parse(readFileSync(join(ROOT, `public/data/${AREA}_now/index.json`), 'utf8')).bbox_wgs84;
const tm = `+proj=tmerc +lat_0=${(s0 + n0) / 2} +lon_0=${(w0 + e0) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;

const LUFS = Object.fromEntries(Object.keys(AMBIENCE).map((n) => [n, loudness(`amb-${n}.m4a`)]));
const BIRDS = ['blackbird', 'garden', 'morning'];
console.log(`${'place'.padEnd(22)} busy  ${'hour'.padStart(5)}  ${'total'.padStart(6)}  ${'birds'.padStart(6)} birds vs rest   loudest layers (LUFS)`);
for (const p of PLACES) {
  const [x, y] = proj4('EPSG:4326', tm, [p.lon, p.lat]), busy = busyAt(x, y);
  for (const hour of HOURS) {
    const gains = ambienceGains(busy, hour, WET);
    const power = Object.fromEntries(Object.keys(gains).map((n) => [n, gains[n] > 0 ? 10 ** (LUFS[n] / 10) * gains[n] ** 2 : 0]));
    const sum = (names) => names.reduce((a, n) => a + power[n], 0);
    const birds = sum(BIRDS), rest = sum(Object.keys(power).filter((n) => !BIRDS.includes(n)));
    const top = Object.entries(power).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `${n} ${db(v).toFixed(1)}`).join(', ');
    console.log(`${p.name.padEnd(22)} ${busy.toFixed(3)} ${String(hour).padStart(5)}  ${fmt(db(birds + rest))}  ${fmt(db(birds))}  ${birds && rest ? (db(birds) - db(rest)).toFixed(1).padStart(6) + ' dB' : '      -  '}   ${top}`);
    if (args.wav) {
      const dir = args.wav === true ? '/tmp/sound-levels' : args.wav;
      mkdirSync(dir, { recursive: true });
      const layers = Object.entries(gains).filter(([, g]) => g > 0.001);
      if (!layers.length) continue;
      const inputs = layers.flatMap(([n]) => ['-stream_loop', '-1', '-i', join(AUDIO, `amb-${n}.m4a`)]);
      // (0.8: the game's master gain.)
      const graph = layers.map(([, g], i) => `[${i}]volume=${(g * 0.8).toFixed(4)}[a${i}]`).join(';') + ';' + layers.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${layers.length}:normalize=0`;
      const out = join(dir, `${p.name.replace(/[^\p{L}\d]+/gu, '-')}-${String(hour).replace('.', 'h')}.wav`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-t', '20', out]);
    }
  }
}
if (args.wav) console.log(`\nWAVs in ${args.wav === true ? '/tmp/sound-levels' : args.wav}`);
