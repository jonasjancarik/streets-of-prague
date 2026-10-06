#!/usr/bin/env node
// The live weather: ČHMÚ's observations turned into the game's kinds of weather
// (worker/weather.js), the Worker's route and its setting, and the game following a
// report gradually unless the player chose the weather (src/weather.ts). No browser, no network.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
registerHooks({ load(url, context, next) {
  if (!url.endsWith('.ts')) return next(url, context);
  return { format: 'module', shortCircuit: true, source: ts.transpileModule(
    readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText };
} });
globalThis.location = { search: '' };
globalThis.self = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => null, setItem() {} }, configurable: true });
const { latest, kindOf, current, weather: route } = await import('../worker/weather.js');

// A day's file as the institute writes it: rows of station, element, time, value, flag, quality.
const file = (rows) => ({ data: { data: { header: 'STATION,ELEMENT,DT,VAL,FLAG,QUALITY', values: rows.map(([e, t, v]) => ['0-20000-0-11518', e, t, v, '', 5]) } } });
const hour = (h) => `2026-10-05T${String(h).padStart(2, '0')}:00:00Z`;
const at = (h, o) => Object.entries(o).map(([e, v]) => [e, hour(h), v]);
const seen = (o, h = 12) => kindOf(latest(file([...at(h - 1, { ww: 508, N: 1, VV: 30, SRA1H: 0, T: 12 }), ...at(h, { T: 12, SRA1H: 0, ...o })])));

assert.equal(seen({ ww: 508, N: 1, VV: 25 }), 'clear', 'a nearly clear sky');
assert.equal(seen({ ww: 508, N: 4, VV: 25 }), 'clear', 'half the sky clouded is still a fine day');
assert.equal(seen({ ww: 508, N: 7, VV: 15 }), 'cloudy', 'an overcast sky');
assert.equal(seen({ ww: 10, N: 5, VV: 8 }), 'cloudy', 'haze under cloud is cloudy, not mist');
assert.equal(seen({ ww: 45, N: 9, VV: 0.1 }), 'mist', 'fog reported by the observer');
assert.equal(seen({ ww: 134, VV: 0.3 }), 'mist', 'fog reported by the automatic sensor');
assert.equal(seen({ ww: 508, N: 3, VV: 0.4 }), 'mist', 'low visibility without a code');
assert.equal(seen({ ww: 61, N: 8, VV: 6, SRA1H: 1.2 }), 'rain', 'rain');
assert.equal(seen({ ww: 80, N: 6, VV: 9 }), 'rain', 'a shower');
assert.equal(seen({ ww: 161, VV: 6 }), 'rain', 'rain by the automatic sensor');
assert.equal(seen({ ww: 508, N: 8, VV: 9, SRA1H: 0.6 }), 'rain', 'rain measured in the gauge with no code');
assert.equal(seen({ ww: 508, N: 8, VV: 9, SRA1H: 0.6, T: -2 }), 'snow', 'the same below freezing is snow');
assert.equal(seen({ ww: 71, N: 8, VV: 3, T: -1 }), 'snow', 'snow');
assert.equal(seen({ ww: 172, VV: 3, T: -1 }), 'snow', 'snow by the automatic sensor');
assert.equal(seen({ ww: 95, N: 8, VV: 5 }), 'storm', 'a thunderstorm');
assert.equal(seen({ ww: 192, VV: 5 }), 'storm', 'a thunderstorm by the automatic sensor');
// The cloud cover stops being reported at night at some stations: an old value isn't used.
assert.equal(kindOf(latest(file([...at(6, { N: 8, ww: 508 }), ...at(12, { T: 9, SRA1H: 0 })]))), null, 'a cloud cover six hours old says nothing');
assert.equal(latest(file([])), null, 'an empty file');
assert.equal(latest({}), null, 'not the institute\'s file');

// Ruzyně first, Libuš when it has nothing; yesterday's file just after midnight (UTC); nothing stale.
const now = Date.parse('2026-10-05T12:20:00Z');
const serve = (files) => async (url) => {
  const name = url.split('/').pop();
  return files[name] ? { ok: true, json: async () => files[name] } : { ok: false };
};
const cloudy = file(at(12, { ww: 508, N: 8, VV: 20, SRA1H: 0, T: 10 })), raining = file(at(12, { ww: 61, N: 8, VV: 6, SRA1H: 1, T: 10 }));
assert.deepEqual(await current(now, serve({ '1h-0-20000-0-11518-20261005.json': cloudy, '1h-0-20000-0-11520-20261005.json': raining })),
  { kind: 'cloudy', at: hour(12), station: 'Praha, Ruzyně', source: 'ČHMÚ' });
assert.equal((await current(now, serve({ '1h-0-20000-0-11520-20261005.json': raining }))).station, 'Praha, Libuš', 'the second station when the first has no file');
assert.equal((await current(Date.parse('2026-10-06T00:05:00Z'), serve({ '1h-0-20000-0-11518-20261005.json': file(at(23, { ww: 508, N: 2, VV: 20 })) }))).kind, 'clear', 'yesterday\'s file just after midnight');
assert.equal(await current(Date.parse('2026-10-05T19:00:00Z'), serve({ '1h-0-20000-0-11518-20261005.json': cloudy })), null, 'an observation seven hours old is not the weather now');
assert.equal(await current(now, async () => { throw new Error('down'); }), null, 'the source down');

// The route answers only when the setting is on.
assert.equal((await route(new Request('https://example.test/api/weather'), {}, {})).status, 404, 'off without the setting');
assert.equal((await route(new Request('https://example.test/api/weather', { method: 'POST' }), { WEATHER_SOURCE: 'chmi' }, {})).status, 405, 'GET only');

// The game: a report is followed gradually, the game's own changes wait, and a weather picked by hand stays.
const { Weather, LIVE_LASTS } = await import('../src/weather.ts');
const { Season } = await import('../src/season.ts');
const make = (query = '') => new Weather(new URLSearchParams(query), 12 * 3600, new Season(new URLSearchParams('date=07-15')));
const run = (w, seconds, from = 12 * 3600) => { for (let s = 1; s <= seconds; s++) w.update(1, from + s, 1); return from + seconds; };
let w = make();
w.begin('clear', 12 * 3600, true);
assert.ok(w.live && !w.fixed, 'begun with the real weather');
assert.ok(w.follow('rain'), 'a report is taken');
let t = run(w, 60);
assert.ok(w.now.cloud > 0.2 && w.now.cloud < 0.6 && w.now.rain === 0, `a minute on, the clouds are only gathering (${w.now.cloud.toFixed(2)})`);
t = run(w, 400, t);
assert.ok(w.now.rain > 0.9 && w.kind === 'rain', 'some minutes on it rains');
t = run(w, 2 * 3600 / 4, t);
assert.equal(w.kind, 'rain', 'while reports keep coming the game does not roll its own weather');
assert.ok(w.follow('mist') && w.kind === 'cloudy', 'mist is beta: a misty report is followed as cloud');
w.set('snow');
assert.ok(!w.live && !w.follow('clear') && w.kind === 'snow', 'a weather picked by hand ends the following');
w = make();
w.begin('rain', 12 * 3600, true);
t = run(w, LIVE_LASTS + 3 * 3600);
assert.ok(w.live, 'with no report for long the game changes the weather itself again');
const kinds = new Set();
for (let i = 0; i < 40; i++) { t = run(w, 3600, t); kinds.add(w.kind); }
assert.ok(kinds.size > 1, 'and it does change');
w = make();
w.begin('clear', 12 * 3600);
assert.ok(!w.follow('rain') && w.kind === 'clear', 'a game not begun with the real weather ignores reports');
w = make('weather=storm');
assert.ok(!w.follow('clear') && w.kind === 'storm', 'so does one with the weather in its address');
console.log('Live weather: ČHMÚ observations by code and by measurement, station and file fallbacks, the route\'s setting, gradual following, hand-picked weather kept.');
