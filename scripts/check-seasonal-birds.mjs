#!/usr/bin/env node
// Deterministic date/time/weather checks; --clips also measures the existing bird
// recordings with ffmpeg and prints the calculated bird mix before the master bus.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Season } from '../src/season.ts';
import { AMBIENCE, ambienceGains, birdActivity } from '../src/soundmix.ts';

const birds = ['blackbird', 'garden', 'morning'];
const seasons = Object.fromEntries(['04-20', '07-15', '08-20', '01-15'].map(date => [date, new Season(new URLSearchParams(`date=${date}`))]));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
const summer = ambienceGains(0.004, 7, 0, seasons['07-15']);
close(summer.blackbird, 0.07); close(summer.garden, 0.035); close(summer.morning, 0.06);
for (const hour of [0, 4, 5.5, 7, 9, 12, 19.5, 23, 24]) {
  assert.deepEqual(ambienceGains(0.004, hour, 0, seasons['07-15']), ambienceGains(0.004, hour, 0), 'July retains the original reference');
  close(birdActivity(hour, seasons['01-15']), 0.03);
}
close(birdActivity(7, seasons['04-20']), 1.4);
close(birdActivity(12, seasons['04-20']), 1);
assert.ok(birdActivity(7, seasons['08-20']) < 0.4, 'late summer is less active');
for (const season of Object.values(seasons)) for (const hour of [0, 5.5, 7, 12, 19.5, 24]) {
  const base = ambienceGains(0.004, hour, 0);
  const dry = ambienceGains(0.004, hour, 0, season);
  for (const key of Object.keys(AMBIENCE).filter(key => !birds.includes(key))) close(dry[key], base[key]);
  for (const [rain, snow] of [[1, 0], [0, 1], [1, 1]]) {
    const wet = ambienceGains(0.004, hour, Math.max(rain, snow), season);
    for (const key of birds) close(wet[key], 0);
  }
  const halfWet = ambienceGains(0.004, hour, 0.5, season);
  for (const key of birds) close(halfWet[key], dry[key] * 0.5);
  for (const busy of [0.1, 1]) for (const key of birds) close(ambienceGains(busy, hour, 0, season)[key], 0);
  for (const key of birds) close(ambienceGains(0.004, 0, 0, season)[key], 0);
}
const year = new Season(new URLSearchParams('date=365'));
let previous = birdActivity(7, year);
for (let day = 1; day <= 365; day++) {
  year.set(day);
  const activity = birdActivity(7, year);
  assert.ok(Math.abs(activity - previous) < 0.1, `continuous date transition on day ${day}`);
  for (let hour = 0; hour < 24; hour += 0.5) {
    const gains = ambienceGains(0.004, hour, 0, year);
    for (const key of birds) assert.ok(Number.isFinite(gains[key]) && gains[key] >= 0 && gains[key] <= AMBIENCE[key] * 1.4 + 1e-12);
  }
  previous = activity;
}
console.log('Seasonal birds: July reference, spring dawn, late summer, winter, clock windows, weather, busy-place suppression and smooth year passed');

let clipLufs;
if (process.argv.includes('--clips')) {
  clipLufs = Object.fromEntries(birds.map(key => {
    const file = fileURLToPath(new URL(`../public/audio/amb-${key}.m4a`, import.meta.url));
    const result = spawnSync('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(`ffmpeg failed for ${key}: ${result.error ?? result.stderr}`);
    const matches = [...result.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
    assert.ok(matches.length, `LUFS for ${key}`);
    return [key, Number(matches.at(-1)[1])];
  }));
  console.log('Measured recording LUFS:', JSON.stringify(clipLufs));
}
console.log('date   hour  activity  gain change vs July  calculated bird LUFS (quiet suburb, clear)');
for (const [date, season] of Object.entries(seasons)) for (const hour of [7, 12]) {
  const activity = birdActivity(hour, season), gains = ambienceGains(0.004, hour, 0, season);
  const power = clipLufs && birds.reduce((sum, key) => sum + 10 ** (clipLufs[key] / 10) * gains[key] ** 2, 0);
  console.log(`${date} ${String(hour).padStart(4)}  ${activity.toFixed(3)}     ${(20 * Math.log10(activity)).toFixed(2).padStart(6)} dB          ${power ? (10 * Math.log10(power)).toFixed(2) : 'not measured'}`);
}
