#!/usr/bin/env node
// Real client request/fallback logic with deferred fixtures; no external requests.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const previousApi = process.env.VITE_WEATHER_API, originalFetch = globalThis.fetch;
process.env.VITE_WEATHER_API = '/api/weather';
globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null };
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { liveWeather, kindOfCode } = await server.ssrLoadModule('/src/liveweather.ts');
  const { Weather } = await server.ssrLoadModule('/src/weather.ts');
  const { Season } = await server.ssrLoadModule('/src/season.ts');
  const response = body => ({ ok: true, json: async () => body });
  const requested = [];
  let serve;
  globalThis.fetch = (url, options) => { requested.push(url); assert.ok(options.signal instanceof AbortSignal); return serve(url, options); };
  serve = async () => response({ kind: 'rain' });
  assert.equal(await liveWeather(), 'rain');
  assert.deepEqual(requested.splice(0), ['/api/weather'], 'valid own source does not ask the fallback');
  for (const fail of [async () => ({ ok: false }), async () => response({ kind: 'hail' }), async () => response(null),
    async () => { throw new DOMException('fixture timeout', 'TimeoutError'); }]) {
    serve = async url => url === '/api/weather' ? fail() : response({ current: { weather_code: 61 } });
    assert.equal(await liveWeather(), 'rain', 'own-source failure falls back');
    assert.equal(requested.length, 2);
    assert.equal(requested.shift(), '/api/weather'); requested.shift();
  }
  serve = async () => { throw new Error('fixture offline'); };
  assert.equal(await liveWeather(), null);
  serve = async () => response({ kind: 'snow' });
  assert.equal(await liveWeather(), 'snow', 'a failed request is not cached into the next attempt');
  requested.length = 0;

  for (const code of [-99, -1, 0.5, 1.5, 51.5, 95.2, NaN, Infinity]) assert.equal(kindOfCode(code), null, `invalid code ${code}`);
  for (const [code, kind] of [[0, 'clear'], [1, 'clear'], [2, 'clear'], [3, 'cloudy'], [45, 'mist'], [61, 'rain'], [71, 'snow'], [95, 'storm']]) assert.equal(kindOfCode(code), kind);
  serve = async url => url === '/api/weather' ? { ok: false } : response({ current: { weather_code: -1 } });
  assert.equal(await liveWeather(), null, 'malformed fallback data is not a clear-sky report');

  const pending = [];
  serve = () => new Promise(resolve => pending.push(resolve));
  const older = liveWeather(), newer = liveWeather();
  pending[1](response({ kind: 'snow' }));
  assert.equal(await newer, 'snow');
  pending[0](response({ kind: 'rain' }));
  assert.equal(await older, 'rain', 'overlapping client calls keep their own responses');

  const weather = new Weather(new URLSearchParams(), 43200, new Season(new URLSearchParams('date=07-15')));
  weather.begin('clear', 43200, true);
  const delayed = liveWeather().then(kind => kind && weather.follow(kind));
  weather.set('snow'); // settings/P/developer selection while the request is pending
  pending.at(-1)(response({ kind: 'storm' }));
  assert.equal(await delayed, false);
  assert.equal(weather.kind, 'snow');
  assert.equal(weather.fixed, true);
  assert.equal(weather.live, false);
  console.log('Live requests: own/fallback responses, HTTP/timeout/malformed errors, recovery, overlapping calls and late manual-choice guards passed.');
} finally {
  globalThis.fetch = originalFetch;
  if (previousApi === undefined) delete process.env.VITE_WEATHER_API;
  else process.env.VITE_WEATHER_API = previousApi;
  await server.close();
}
