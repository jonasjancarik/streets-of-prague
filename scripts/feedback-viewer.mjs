#!/usr/bin/env node
// The tool for the messages players send from the game's feedback form. It reads the copies
// that worker/index.js keeps in R2 (feedback/<date>/<time>-<id>.json) through your `cf` login,
// serves one page on this machine, and lets you mark what you did with each message: a status,
// a note and whether you replied. Those marks are one JSON object in the same bucket
// (feedback-state.json, outside feedback/), written back after every change.
//
//   node scripts/feedback-viewer.mjs              start on http://127.0.0.1:5196 and open it
//   node scripts/feedback-viewer.mjs --sample     made-up messages, marks kept in memory only
//   --port <n>   another port        --host <address>   reachable from elsewhere (default 127.0.0.1)
//   --no-open    don't open the page
//
// The page shows players' addresses and writes to the bucket without a login, so it listens on
// this machine only unless you pass --host. Downloaded messages are cached in .feedback/cache/
// (git-ignored; they hold email addresses). Messages sent before the copies existed are only
// in the inbox.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '7756b12931ecfb3900a31049e157d706', BUCKET = 'streets-of-prague-mail', STATE_KEY = 'feedback-state.json';
const CACHE = join(ROOT, '.feedback/cache'), UPLOAD = join(ROOT, '.feedback/state-upload.json');
const STATUSES = ['new', 'progress', 'done', 'wontdo'];
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(option('--port', 5196)), HOST = option('--host', '127.0.0.1');
const SAMPLE_MODE = flag('--sample');

const cf = (...a) => execFileSync('cf', a, { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const cfMessage = (e) => String(e.stderr || e.message).replace(/[┌│└]/g, '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');

function listKeys() {
  const keys = [];
  let after = '';
  for (;;) { // a page at a time, in key order, which is time order
    const page = JSON.parse(cf('r2', 'objects', 'list', '--bucket-name', BUCKET, '--prefix', 'feedback/', '--per-page', '1000', ...(after ? ['--start-after', after] : [])));
    if (!page.length) break;
    keys.push(...page.map((o) => o.key));
    after = page[page.length - 1].key;
    if (page.length < 1000) break;
  }
  return keys;
}

// Messages never change, so each is downloaded once and kept in .feedback/cache/.
function loadMessages() {
  mkdirSync(CACHE, { recursive: true });
  return listKeys().map((key) => {
    const file = join(CACHE, key.replaceAll('/', '__'));
    try {
      if (existsSync(file)) return { key, ...JSON.parse(readFileSync(file, 'utf8')) };
      const text = cf('r2', 'objects', 'get', key, '--bucket-name', BUCKET);
      const message = JSON.parse(text);
      writeFileSync(file, text);
      return { key, ...message };
    } catch (e) {
      return { key, time: '', message: `(could not be read: ${cfMessage(e)})`, context: '' };
    }
  });
}

// A screenshot is downloaded when first asked for and kept in .feedback/cache/ like the messages.
function screenshot(key) {
  if (SAMPLE_MODE) return SAMPLE_PICTURE;
  const file = join(CACHE, key.replaceAll('/', '__'));
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(CACHE, { recursive: true });
  const bytes = execFileSync('cf', ['r2', 'objects', 'get', key, '--bucket-name', BUCKET], { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(file, bytes);
  return bytes;
}

function loadState() {
  try { return JSON.parse(cf('r2', 'objects', 'get', STATE_KEY, '--bucket-name', BUCKET)) || {}; }
  catch (e) {
    if (/not\s*found|NoSuchKey|10007|404/i.test(cfMessage(e))) return {}; // nothing saved yet
    throw e;
  }
}

function saveState(state) {
  mkdirSync(dirname(UPLOAD), { recursive: true });
  writeFileSync(UPLOAD, JSON.stringify(state));
  cf('r2', 'objects', 'put', STATE_KEY, '--bucket-name', BUCKET, '--file', UPLOAD, '--content-type', 'application/json');
}

// A small gradient standing in for a screenshot (sample mode).
const SAMPLE_PICTURE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
const SAMPLE = [
  { key: 's1', time: '2026-10-02T09:12:00Z', message: 'The tram at Anděl drove through my car.\nIt happened twice.', email: 'player@example.com', lang: 'en', context: 'Version v0.1.2\nChrome 141 on macOS\nSpeed 62 km/h, near Anděl', screenshot: 'sample-shot', scenario: "// Anděl\nawait t.go([50.0711, 14.4034], { heading: 90 });\nt.time('18:30');\nt.weather('rain');" },
  { key: 's2', time: '2026-10-01T18:40:00Z', message: 'Skvělá hra, ale policie střílí příliš přesně.', email: '', lang: 'cs', context: 'Version v0.1.1\nSafari on iPad' },
  { key: 's3', time: '2026-09-30T20:05:00Z', message: 'Could you add a way to change the radio station with the keyboard?', email: 'radio@example.com', lang: 'en', context: 'Version v0.1.1\nFirefox 142 on Windows' },
];

let messages = SAMPLE, state = {};
if (!SAMPLE_MODE) {
  try { messages = loadMessages(); state = loadState(); }
  catch (e) { console.error(`Couldn't read from the bucket: ${cfMessage(e)}`); process.exit(1); }
}
const known = new Set(messages.map((m) => m.key));

// Changes are written one at a time. A change that couldn't be written is taken back, so what
// the page shows is what is saved.
let queue = Promise.resolve();
function change(key, patch) {
  const run = queue.then(() => {
    const before = state[key];
    const next = { status: 'new', note: '', replied: false, ...before, ...patch, updated: new Date().toISOString() };
    state = { ...state, [key]: next };
    try { if (!SAMPLE_MODE) saveState(state); }
    catch (e) {
      state = { ...state, ...(before ? { [key]: before } : {}) };
      if (!before) delete state[key];
      throw e;
    }
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

function validate(body) {
  if (!body || typeof body !== 'object' || !known.has(body.key)) return 'Unknown message';
  const patch = {};
  if ('status' in body) { if (!STATUSES.includes(body.status)) return 'Unknown status'; patch.status = body.status; }
  if ('note' in body) { if (typeof body.note !== 'string' || body.note.length > 5000) return 'Note is not valid'; patch.note = body.note; }
  if ('replied' in body) { if (typeof body.replied !== 'boolean') return 'Replied is not valid'; patch.replied = body.replied; }
  if (!Object.keys(patch).length) return 'Nothing to change';
  return patch;
}

const send = (res, status, data, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // On the loopback address only this machine's own page may ask (guards against other sites in the browser).
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost';
  if (loopbackOnly && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'Not allowed' });
  if (req.method === 'GET' && path === '/') return send(res, 200, PAGE, 'text/html');
  if (req.method === 'GET' && path === '/api/messages') return send(res, 200, { messages, state, sample: SAMPLE_MODE });
  if (req.method === 'GET' && path === '/api/screenshot') {
    const key = new URL(req.url, 'http://x').searchParams.get('key') ?? '';
    if (!messages.some((m) => m.screenshot && m.screenshot === key)) return send(res, 404, { error: 'Not found' });
    try { const bytes = screenshot(key); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); return res.end(bytes); }
    catch (e) { console.error(`Reading the screenshot failed: ${cfMessage(e)}`); return send(res, 502, { error: 'Couldn\'t read it' }); }
  }
  if (req.method === 'POST' && path === '/api/state') {
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Not allowed' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Not valid' }); }
      const patch = validate(body);
      if (typeof patch === 'string') return send(res, 400, { error: patch });
      change(body.key, patch).then((entry) => send(res, 200, { key: body.key, entry }), (e) => { console.error(`Saving failed: ${cfMessage(e)}`); send(res, 502, { error: 'Couldn\'t save' }); });
    });
    return undefined;
  }
  return send(res, 404, { error: 'Not found' });
});

const PAGE = readFileSync(join(ROOT, 'scripts/feedback-viewer.html'), 'utf8'); // read per start; edit the file and restart

server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Pick another with --port.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}/`;
  console.log(`${messages.length} message${messages.length === 1 ? '' : 's'}${SAMPLE_MODE ? ' (sample)' : ''}. Open ${url}`);
  if (!flag('--no-open')) execFileSync('open', [url]);
});
