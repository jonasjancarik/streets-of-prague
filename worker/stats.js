// The anonymous statistics the game sends (src/telemetry.ts), taken in at
// POST /api/report by worker/index.js. Each report becomes one row in the Analytics
// Engine dataset bound as TELEMETRY. docs/telemetry.md describes it all.
//
// SCHEMA is the whole format: which reports exist and which column each field lands
// in. Text goes to blob7 onwards and numbers to double1 onwards, in the order listed;
// blob1 to blob6 are the report's name, the game's version, the session, the
// visitor's country (from Cloudflare; the IP address is not stored), the domain the
// game was opened on and the map data version. Add new fields at the end of a list,
// so rows already stored keep their meaning.
// scripts/telemetry-dashboard.mjs reads this to name the columns again.

export const COMMON = ['event', 'version', 'session', 'country', 'host', 'map'];
export const SCHEMA = {
  start: {
    blobs: ['renderer', 'gpu', 'graphics', 'tier', 'lang', 'input', 'game', 'browser', 'os', 'referrer'],
    doubles: ['loadMs', 'width', 'height', 'dpr', 'memory', 'cores'],
  },
  // Totals since the start of the session; `seq` counts the reports, the last one holds the session.
  frames: {
    blobs: ['renderer', 'graphics', 'tier'],
    doubles: ['seq', 'seconds', 'frames', 'medianMs', 'p95Ms', 'hitches', 'stalls', 'tierChanges', 'tileFailures'],
  },
  play: {
    blobs: [],
    doubles: ['seq', 'seconds', 'foot', 'car', 'tram', 'taxi', 'other', 'metres', 'wrecked', 'knocked', 'busted', 'wasted', 'money', 'maxStars', 'tickets', 'saves'],
  },
  setting: { blobs: ['name', 'value'], doubles: [] },
  error: { blobs: ['kind', 'message', 'where', 'renderer'], doubles: [] },
};

const LONGEST = 4000; // characters in a report
const text = (v, most = 600) => (typeof v === 'string' ? v.slice(0, most) : '');
const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// The game sends these with sendBeacon as the page closes, so the answer is never
// read: a status and nothing else. They are not rate limited like the forms, since a
// session sends a handful and nothing is emailed.
export async function report(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  // Only the game itself reports, from the page it was loaded from.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return new Response(null, { status: 403 });
  if (!env.TELEMETRY) return new Response(null, { status: 503 });
  const body = await request.text();
  if (body.length > LONGEST) return new Response(null, { status: 413 });
  let sent;
  try { sent = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
  const schema = sent && Object.hasOwn(SCHEMA, sent.e) ? SCHEMA[sent.e] : null;
  if (!schema) return new Response(null, { status: 400 });
  const fields = sent.f && typeof sent.f === 'object' ? sent.f : {};
  env.TELEMETRY.writeDataPoint({
    indexes: [sent.e],
    blobs: [sent.e, text(sent.v, 40), text(sent.s, 32), text(request.cf?.country, 2), url.hostname.slice(0, 80), text(sent.d, 40), ...schema.blobs.map((name) => text(fields[name]))],
    doubles: schema.doubles.map((name) => number(fields[name])),
  });
  return new Response(null, { status: 204 });
}
