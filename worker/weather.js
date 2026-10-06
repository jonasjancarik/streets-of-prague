// The weather in Prague now, from the Czech Hydrometeorological Institute's open data
// (ČHMÚ, https://opendata.chmi.cz, CC BY 4.0: free for any use with the source named),
// for the game's live weather (src/liveweather.ts):
//
//   GET /api/weather  → { kind: 'clear' | 'cloudy' | 'rain' | 'storm' | 'mist' | 'snow', at, station, source }
//
// Off unless the setting WEATHER_SOURCE is "chmi" (a 404 otherwise, and the game asks
// Open-Meteo as before). The game can't read the institute's files itself: they carry no
// CORS header, and a day's file for one station is 60–70 kB of every element measured.
//
// What is read: the hourly file of one station (`/meteorology/climate/now/data/
// 1h-<WSI>-<YYYYMMDD>.json`, the day in UTC, added to about twelve minutes after each
// hour). Ruzyně, the airport, reports round the clock what an observer sees: the present
// weather (`ww`, the WMO's code tables 4677, or 4680 plus 100 from an automatic sensor;
// 508 for nothing to report), the cloud cover in eighths (`N`, 9: the sky can't be seen),
// the visibility in km (`VV`), the hour's precipitation in mm (`SRA1H`) and the air
// temperature (`T`). Libuš, in the south of the city, is asked when Ruzyně's file can't
// be had. The answer is kept at Cloudflare's edge for ten minutes, so the institute is
// asked at most a few times an hour from each place, however many people play.

const DATA = 'https://opendata.chmi.cz/meteorology/climate/now/data';
const STATIONS = [['0-20000-0-11518', 'Praha, Ruzyně'], ['0-20000-0-11520', 'Praha, Libuš']];
const ELEMENTS = ['ww', 'N', 'VV', 'SRA1H', 'T'];
const KEEP = 600; // s: how long an answer is good for
const STALE = 3 * 3600 * 1000; // ms: an observation older than this isn't the weather now

// The newest value of each element wanted, and when the newest of them was measured,
// from a file's rows (station, element, time, value, flag, quality).
export function latest(file) {
  const rows = file?.data?.data?.values;
  if (!Array.isArray(rows)) return null;
  const got = {};
  let at = '';
  for (const [, element, time, value] of rows) {
    if (!ELEMENTS.includes(element) || typeof value !== 'number' || typeof time !== 'string') continue;
    if (!got[element] || time >= got[element].time) got[element] = { time, value };
    if (time > at) at = time;
  }
  if (!at) return null;
  // Only what was measured in the newest hour or the one before: an element a station
  // stopped reporting (the cloud cover at night) says nothing about now.
  const recent = (e) => (got[e] && Date.parse(at) - Date.parse(got[e].time) <= 3600 * 1000 ? got[e].value : null);
  return { at, ww: recent('ww'), cloud: recent('N'), visibility: recent('VV'), rain: recent('SRA1H'), temperature: recent('T') };
}

// The game's kind of weather for an observation, or null when it doesn't say.
export function kindOf(o) {
  if (!o) return null;
  const cold = o.temperature !== null && o.temperature <= 0.5;
  const ww = o.ww;
  if (ww !== null && ww < 100) {
    // An observer's code (table 4677).
    if (ww === 17 || ww === 29 || ww >= 91) return 'storm';
    if ((ww >= 36 && ww <= 39) || (ww >= 70 && ww <= 79) || (ww >= 85 && ww <= 90)) return 'snow';
    if ((ww >= 50 && ww <= 69) || (ww >= 80 && ww <= 84)) return cold && ww >= 68 && ww <= 69 ? 'snow' : 'rain';
    if (ww >= 40 && ww <= 49) return 'mist';
  } else if (ww !== null && ww < 200) {
    // An automatic sensor's (table 4680).
    const wa = ww - 100;
    if (wa >= 90 && wa <= 96) return 'storm';
    if ((wa >= 70 && wa <= 78) || (wa >= 85 && wa <= 87) || wa === 24 || wa === 45 || wa === 46) return 'snow';
    if ((wa >= 40 && wa <= 44) || (wa >= 47 && wa <= 68) || (wa >= 80 && wa <= 84) || (wa >= 21 && wa <= 23)) return cold && (wa === 67 || wa === 68) ? 'snow' : 'rain';
    if (wa >= 30 && wa <= 35) return 'mist';
  }
  // No code, or one for nothing much: by what was measured.
  if (o.rain !== null && o.rain >= 0.2) return cold ? 'snow' : 'rain';
  if (o.visibility !== null && o.visibility < 1) return 'mist';
  if (o.cloud === null) return null;
  return o.cloud >= 9 ? 'mist' : o.cloud >= 5 ? 'cloudy' : 'clear';
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');

// One station's newest observation: today's file (UTC), or yesterday's in the first
// hour of the day, before today's has anything in it.
async function observe(wsi, now, get) {
  for (const date of [day(now), day(now - 86400e3)]) {
    try {
      const r = await get(`${DATA}/1h-${wsi}-${date}.json`);
      if (!r.ok) continue;
      const o = latest(await r.json());
      if (o && now - Date.parse(o.at) < STALE) return o;
    } catch { /* the next file, or the next station */ }
  }
  return null;
}

// `get`: fetch, or a stand-in for it (scripts/check-live-weather.mjs).
export async function current(now = Date.now(), get = (url) => fetch(url, { signal: AbortSignal.timeout(6000) })) {
  for (const [wsi, station] of STATIONS) {
    const o = await observe(wsi, now, get), kind = kindOf(o);
    if (kind) return { kind, at: o.at, station, source: 'ČHMÚ' };
  }
  return null;
}

export async function weather(request, env, ctx) {
  if (env.WEATHER_SOURCE !== 'chmi') return new Response(null, { status: 404 });
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const key = new Request(new URL('/api/weather', request.url).toString());
  const kept = await caches.default.match(key);
  if (kept) return kept;
  const found = await current();
  // (A failure is kept for a minute, so a broken source isn't asked by every player.)
  const response = new Response(JSON.stringify(found ?? { error: 'unavailable' }), {
    status: found ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${found ? KEEP : 60}`, 'Access-Control-Allow-Origin': '*' },
  });
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}
