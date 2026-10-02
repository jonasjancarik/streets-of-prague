// Anonymous statistics: how well the game runs, what goes wrong and what gets played,
// sent to the Worker (worker/stats.js), which stores them (docs/telemetry.md has the
// full list). Nothing here identifies anyone: no cookie, no stored id, no position on
// the map; `session` is a random number that lives until the page is closed.
//
// Only builds that set VITE_TELEMETRY_URL send anything (scripts/deploy-cloudflare.sh
// and deploy-mbxp.sh, for the beta) do; local development and test runs (?go) never do. The settings panel has
// the switch, remembered in the browser.

const URL_ = import.meta.env.VITE_TELEMETRY_URL as string | undefined;
// Cloudflare Web Analytics (visits, countries, page load), behind the same switch.
const BEACON = import.meta.env.VITE_CF_BEACON_TOKEN as string | undefined;
declare const __APP_VERSION__: string; // set by vite.config.js
declare const __DATA_VERSION__: string;

export type Mode = 'foot' | 'car' | 'tram' | 'taxi' | 'other';
type Fields = Record<string, string | number>;

const HITCH = 100;  // ms: a frame this long is felt as a stutter
const STALL = 250;  // …and this long as a freeze
const PAUSE = 2000; // longer is the tab coming back, not a frame
const MOST_ROWS = 40; // activities in one request (worker/stats.js takes no more)
const MOST_ERRORS = 5; // a session; an error that repeats every frame is sent once

export const available = !!URL_ && !new URLSearchParams(location.search).has('go');
let on = available;
try { if (localStorage.getItem('telemetry') === 'off') on = false; } catch {}
export const enabled = () => on;
export function setEnabled(value: boolean) {
  on = available && value;
  try { localStorage.setItem('telemetry', value ? 'on' : 'off'); } catch {}
  if (on) beacon();
}

const session = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

// `rows`: several reports of one kind in one request (the Worker stores each).
function send(event: string, fields: Fields, rows?: Fields[]) {
  if (!on || !URL_) return;
  const body = JSON.stringify({ e: event, v: __APP_VERSION__, d: __DATA_VERSION__, s: session, ...(rows ? { rows } : { f: fields }) });
  // sendBeacon still goes out while the page is closing.
  try {
    if (!navigator.sendBeacon?.(URL_, body)) void fetch(URL_, { method: 'POST', body, keepalive: true }).catch(() => {});
  } catch {}
}

let beaconed = false;
function beacon() {
  if (!on || !BEACON || beaconed) return;
  beaconed = true;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.dataset.cfBeacon = JSON.stringify({ token: BEACON });
  document.head.appendChild(s);
}
beacon();

// ---- Errors -----------------------------------------------------------------
let renderer = '';
const sent = new Set<string>();
export function error(kind: string, e: unknown, where = '') {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  if (sent.size >= MOST_ERRORS || sent.has(kind + message)) return;
  sent.add(kind + message);
  // The first lines of the stack, without the page's address in front of every file.
  const stack = e instanceof Error && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ').replaceAll(location.origin, '') : '';
  send('error', { kind, message, where: (where || stack).slice(0, 600), renderer });
}
if (available) {
  window.addEventListener('error', (e) => error('error', e.error ?? e.message, e.error ? '' : `${e.filename.replace(location.origin, '')}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => error('rejection', e.reason));
}

// ---- The start of a game ----------------------------------------------------
// The graphics card's name, as the browser gives it (renderer.ts sets it for WebGPU).
let gpu = '';
export function setGpu(name: string) { gpu = name; }

function browser() {
  const ua = navigator.userAgent;
  const m = /(Edg|OPR|Firefox|Chrome)\/(\d+)/.exec(ua) ?? /(Version)\/(\d+).*Safari/.exec(ua);
  const names: Record<string, string> = { Edg: 'Edge', OPR: 'Opera', Version: 'Safari' };
  return m ? `${names[m[1]] ?? m[1]} ${m[2]}` : 'Other';
}
function os() {
  const ua = navigator.userAgent;
  return /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
}

// `rendererName`: which renderer the game ended up with; `loadMs`: from opening the page
// to the map being ready behind the start screen.
export function begin(info: { renderer: string; graphics: string; tier: string; lang: string; touch: boolean; resumed: boolean; loadMs: number }) {
  renderer = info.renderer;
  let referrer = '';
  try { if (document.referrer) referrer = new URL(document.referrer).hostname; } catch {}
  if (referrer === location.hostname) referrer = '';
  lastTier = info.tier;
  send('start', {
    renderer, gpu: gpu.slice(0, 120), graphics: info.graphics, tier: info.tier, lang: info.lang,
    input: info.touch ? 'touch' : 'keyboard', game: info.resumed ? 'continued' : 'new', browser: browser(), os: os(), referrer,
    loadMs: Math.round(info.loadMs), width: screen.width, height: screen.height, dpr: devicePixelRatio,
    memory: (navigator as { deviceMemory?: number }).deviceMemory ?? 0, cores: navigator.hardwareConcurrency ?? 0,
  });
  started = true;
}

export function setting(name: string, value: string) { send('setting', { name, value }); }

// ---- Frames and play, added up and sent when the tab is hidden or closed -----
let started = false, dirty = false, seq = 0;
const histogram = new Uint32Array(STALL + 1); // frames by whole milliseconds
let frames = 0, hitches = 0, stalls = 0, tierChanges = 0, lastTier = '';
let seconds = 0, metres = 0, lastX = NaN, lastY = NaN;
const modes: Record<Mode, number> = { foot: 0, car: 0, tram: 0, taxi: 0, other: 0 };
const counts: Record<string, number> = {};
let graphicsNow = '';
let totals: () => Fields = () => ({});

// Things the player does (riding a tram, honking, being arrested) and what money goes
// on: how often, and how many seconds into the session the first time. The names are
// free text, shown as they are on the dashboard, so new ones need no other change.
interface Activity { times: number; firstAt: number; amount: number }
const activities = new Map<string, Activity>(), changed = new Set<string>(), going = new Set<string>();
function activity(key: string) {
  let a = activities.get(key);
  if (!a) activities.set(key, (a = { times: 0, firstAt: Math.round(seconds), amount: 0 }));
  changed.add(key);
  dirty = true;
  return a;
}
// The player did this, once more.
export function did(name: string) { if (started) activity(`did\n${name}`).times++; }
// Something that lasts (holding the horn, lane assist): counted each time it begins.
export function doing(name: string, on: boolean) {
  if (!on) { going.delete(name); return; }
  if (going.has(name)) return;
  going.add(name);
  did(name);
}
// Money that left the wallet, by what it went on.
export function spent(what: string, amount: number) {
  if (!started || amount <= 0) return;
  const a = activity(`spent\n${what}`);
  a.times++;
  a.amount += amount;
}

// What the game counts itself (cars wrecked, money…), read when a summary is sent.
export function summary(read: () => Fields) { totals = read; }
export function count(name: string, by = 1) { counts[name] = (counts[name] ?? 0) + by; }
export function most(name: string, value: number) { counts[name] = Math.max(counts[name] ?? 0, value); }

// Once a frame: how long it took, and what the player is doing where.
export function tick(ms: number, dt: number, mode: Mode, x: number, y: number, graphics: string, tier: string) {
  if (!started || ms > PAUSE) { lastX = x; lastY = y; return; }
  dirty = true;
  frames++;
  histogram[Math.min(STALL, Math.round(ms))]++;
  if (ms > STALL) stalls++; else if (ms > HITCH) hitches++;
  if (tier !== lastTier) { tierChanges++; lastTier = tier; }
  graphicsNow = graphics;
  seconds += dt;
  modes[mode] += dt;
  const d = Math.hypot(x - lastX, y - lastY);
  if (d < 5) metres += d; // (more in one frame is a jump: the metro, a hospital, a saved game)
  lastX = x; lastY = y;
}

function percentile(p: number) {
  let n = 0;
  for (let ms = 0; ms <= STALL; ms++) if ((n += histogram[ms]) >= frames * p) return ms;
  return STALL;
}

function flush() {
  if (!started || !dirty) return;
  dirty = false;
  seq++;
  const r = Math.round;
  send('frames', {
    renderer, graphics: graphicsNow, tier: lastTier, seq, seconds: r(seconds), frames,
    medianMs: percentile(0.5), p95Ms: percentile(0.95), hitches, stalls, tierChanges, tileFailures: counts.tileFailures ?? 0,
  });
  send('play', {
    seq, seconds: r(seconds), foot: r(modes.foot), car: r(modes.car), tram: r(modes.tram), taxi: r(modes.taxi), other: r(modes.other),
    metres: r(metres), tickets: counts.tickets ?? 0, saves: counts.saves ?? 0, maxStars: counts.maxStars ?? 0, ...totals(),
  });
  // Only what changed since the last report, in one request.
  const rows = [...changed].map((key) => {
    const [kind, name] = key.split('\n'), a = activities.get(key)!;
    return { kind, name, seq, times: a.times, firstAt: a.firstAt, amount: a.amount };
  });
  changed.clear();
  for (let i = 0; i < rows.length; i += MOST_ROWS) send('activity', {}, rows.slice(i, i + MOST_ROWS));
}
if (available) {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}
