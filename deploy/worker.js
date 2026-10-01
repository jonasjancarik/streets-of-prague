// The Worker in front of the game's static files on Cloudflare. Files are served
// without it; it only runs for addresses that are no file, and the one it answers is
// POST /t, where the game sends its anonymous statistics (src/telemetry.ts). Each
// report becomes one row in the Analytics Engine dataset bound as TELEMETRY.
//
// SCHEMA is the whole format: which reports exist and which column each field lands
// in. Text goes to blob5 onwards and numbers to double1 onwards, in the order listed;
// blob1 to blob4 are the report's name, the game's version, the session and the
// visitor's country (from Cloudflare; the IP address is not stored). Add new fields at
// the end of a list, so rows already stored keep their meaning.
// scripts/telemetry-dashboard.mjs reads this to name the columns again.

export const COMMON = ['event', 'version', 'session', 'country'];
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/t') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    // Only the game itself reports, from the page it was loaded from.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response(null, { status: 403 });
    const body = await request.text();
    if (body.length > LONGEST) return new Response(null, { status: 413 });
    let report;
    try { report = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
    const schema = report && Object.hasOwn(SCHEMA, report.e) ? SCHEMA[report.e] : null;
    if (!schema) return new Response(null, { status: 400 });
    const fields = report.f && typeof report.f === 'object' ? report.f : {};
    env.TELEMETRY.writeDataPoint({
      indexes: [report.e],
      blobs: [report.e, text(report.v, 40), text(report.s, 32), text(request.cf?.country, 2), ...schema.blobs.map((name) => text(fields[name]))],
      doubles: schema.doubles.map((name) => number(fields[name])),
    });
    return new Response(null, { status: 204 });
  },
};
