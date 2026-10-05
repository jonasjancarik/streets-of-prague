#!/usr/bin/env node
// Runs test scenarios (scenarios/*.ts) and bits of script in the real game, in headless
// Chrome, through the test API in src/testkit.ts (window.__test, `t` below).
//
//   node scripts/scene.mjs serve [--show] [--port 5199]   keep a browser with the map loaded
//   node scripts/scene.mjs run lamp-knock [wall-crash …]    scenarios by name, or `all`
//   node scripts/scene.mjs eval "await t.go('karlova'); return t.probe()"
//   node scripts/scene.mjs shot [name]                      a screenshot of the game as it is
//   node scripts/scene.mjs list | stop
//
// Common options: [--url http://localhost:5191/] [--out dir for screenshots (default
// $TMPDIR/scene)] [--place staromak] [--time 14:00] [--weather clear] [--graphics high]
// [--date 10-20 (or spring, summer, autumn, winter; today's date otherwise)]
// [--extra "&area=centrum" (more of the game's URL parameters)] [--size 1920x1080 (the
// window; t.film saves footage frame by frame at that size)] [--jpeg (screenshots as JPEG)].
// With a server running (serve), each command takes a second or two instead of the
// 30–60 s of loading the map; without one, it opens a browser just for the command.
// The server follows the dev server's reloads: a command waits for the game to load
// again. A command waits while another session benchmarks (game-lock.mjs). Exits 1 if
// a scenario fails or the page throws. Needs the dev server
// (npm run dev) and Playwright (PLAYWRIGHT_PATH or the usual places).

import { createRequire } from 'node:module';
import { createServer, request } from 'node:http';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIn } from './game-lock.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const args = {}, pos = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
const PORT = Number(args.port || 5199);
const URL_BASE = args.url || 'http://localhost:5191/';
const OUT = args.out || join(tmpdir(), 'scene');
const ROOT = new URL('..', import.meta.url).pathname;

// Talking to a running server.
const call = (body) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
const alive = () => call({ cmd: 'ping' }).then(() => true, () => false);

// ---- The browser side --------------------------------------------------------

// Not while another session benchmarks (game-lock.mjs). A turn lasts for a command; a
// server rests between commands, its page standing still under a benchmark.
let slot = null;
const takeTurn = async () => { slot ||= await checkIn('game', `scene.mjs ${cmd}`); await slot.take(); };

async function openGame({ show = false } = {}) {
  await takeTurn();
  const require = createRequire(import.meta.url);
  const tryReq = (p) => { try { return require(p); } catch { return null; } };
  const pw = tryReq(process.env.PLAYWRIGHT_PATH || 'playwright') || tryReq(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
  if (!pw) throw new Error('Playwright not found; set PLAYWRIGHT_PATH');
  const browser = await pw.chromium.launch({
    headless: !show, channel: args.browser === 'chromium' ? undefined : 'chrome',
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
  });
  const [width, height] = String(args.size || '1280x800').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
  mkdirSync(OUT, { recursive: true });
  const shots = [];
  await page.exposeFunction('__shot', async (name) => {
    // (--jpeg: quicker to save and a tenth the size, for footage that is only a preview.)
    const path = join(OUT, `${String(name).replace(/[^\w.-]+/g, '-')}.${args.jpeg ? 'jpg' : 'png'}`);
    await page.screenshot(args.jpeg ? { path, type: 'jpeg', quality: 86 } : { path });
    shots.push(path);
  });
  // For footage with sound (t.film's `sound`): a file's bytes (base64) into the screenshots' folder.
  await page.exposeFunction('__saveFile', async (name, base64) => {
    const path = join(OUT, String(name).replace(/[^\w.-]+/g, '-'));
    writeFileSync(path, Buffer.from(base64, 'base64'));
    return path;
  });
  const place = args.place || 'staromak';
  const q = `?place=${place}&go&day=wed&time=${args.time || '14:00'}&weather=${args.weather || 'clear'}&graphics=${args.graphics || 'high'}&dpr=1${args.date ? `&date=${args.date}` : ''}${args.extra || ''}`;
  const t0 = Date.now();
  await page.goto(URL_BASE + q);
  const ready = async () => {
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__test, null, { timeout: 180000, polling: 200 });
  };
  await ready();
  await page.keyboard.press('KeyH'); // fold the controls card away
  console.error(`Game loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // Each command: wait for the game (it reloads when the source changes), run, and
  // hand back what it returned with the page errors and screenshots meanwhile.
  const run = async (fn) => {
    await takeTurn();
    await ready();
    await page.evaluate(() => window.__benchPause?.check()); // moving again at once after a benchmark
    errors = [];
    shots.length = 0;
    let value, error;
    try { value = await fn(); } catch (e) { error = e.message; }
    return { value, error, errors: [...errors], shots: [...shots] };
  };
  return {
    close: () => browser.close(),
    scenarios: () => run(() => page.evaluate(() => window.__test.scenarios)),
    scenario: (name) => run(() => page.evaluate((n) => window.__test.run(n), name)),
    eval: (code) => run(() => page.evaluate(async (code) => {
      const body = /\breturn\b|;|\n/.test(code) ? code : `return (${code});`;
      const f = new (Object.getPrototypeOf(async () => {}).constructor)('t', body);
      return await f(window.__test);
    }, code)),
    shot: (name) => run(() => page.evaluate((n) => window.__test.shot(n), name || 'shot')),
  };
}

async function handle(game, { cmd, name, code }) {
  if (cmd === 'ping') return { value: 'ok' };
  if (cmd === 'list') return game.scenarios();
  if (cmd === 'run') return game.scenario(name);
  if (cmd === 'eval') return game.eval(code);
  if (cmd === 'shot') return game.shot(name);
  return { error: `Unknown command ${cmd}` };
}

// ---- Commands ----------------------------------------------------------------

const scenarioNames = () => readdirSync(join(ROOT, 'scenarios')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();

// Through the server if one is running, otherwise in a browser just for this.
async function withGame(bodies) {
  if (await alive()) {
    const out = [];
    for (const b of bodies) out.push(await call(b));
    return out;
  }
  console.error('No scene server running (node scripts/scene.mjs serve); loading the game for this command…');
  const game = await openGame({ show: !!args.show });
  try {
    const out = [];
    for (const b of bodies) out.push(await handle(game, b));
    return out;
  } finally {
    await game.close();
  }
}

const report = (r) => {
  let ok = !r.error && !r.errors?.length;
  if (r.error) console.log(`  error: ${r.error}`);
  for (const e of r.errors || []) console.log(`  page error: ${e}`);
  for (const s of r.shots || []) console.log(`  screenshot: ${s}`);
  return ok;
};

if (cmd === 'serve') {
  if (await alive()) { console.error(`A scene server is already running on port ${PORT}`); process.exit(1); }
  const game = await openGame({ show: !!args.show });
  slot.rest();
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      queue = queue.then(async () => {
        let body;
        try { body = JSON.parse(data || '{}'); } catch { body = {}; }
        if (body.cmd === 'stop') {
          res.end(JSON.stringify({ value: 'stopping' }));
          await game.close();
          process.exit(0);
        }
        const out = await handle(game, body).catch((e) => ({ error: e.message }));
        slot.rest();
        res.end(JSON.stringify(out));
      });
    });
  });
  server.listen(PORT, '127.0.0.1', () => console.error(`Scene server on port ${PORT}; screenshots go to ${OUT}. Stop it with: node scripts/scene.mjs stop`));
} else if (cmd === 'run') {
  const names = pos.includes('all') || !pos.length ? scenarioNames() : pos;
  const results = await withGame(names.map((name) => ({ cmd: 'run', name })));
  let failed = 0;
  results.forEach((r, i) => {
    const s = r.value;
    if (!s) { console.log(`✗ ${names[i]}`); report(r); failed++; return; }
    console.log(`${s.pass ? '✓' : '✗'} ${s.name}: ${s.title} (${(s.ms / 1000).toFixed(1)} s)`);
    for (const c of s.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    if (s.error) console.log(`  error: ${s.error}`);
    if (!report(r) || !s.pass) failed++;
  });
  console.log(failed ? `${failed} of ${names.length} failed` : `All ${names.length} passed`);
  process.exit(failed ? 1 : 0);
} else if (cmd === 'eval') {
  const [r] = await withGame([{ cmd: 'eval', code: pos.join(' ') }]);
  if (r.value !== undefined) console.log(JSON.stringify(r.value, null, 2));
  process.exit(report(r) ? 0 : 1);
} else if (cmd === 'shot') {
  const [r] = await withGame([{ cmd: 'shot', name: pos[0] }]);
  process.exit(report(r) ? 0 : 1);
} else if (cmd === 'list') {
  console.log(scenarioNames().join('\n'));
} else if (cmd === 'stop') {
  if (await alive()) await call({ cmd: 'stop' }).catch(() => {});
  else console.error('No scene server running');
} else {
  console.log('Usage: node scripts/scene.mjs serve | run <name…|all> | eval "<js>" | shot [name] | list | stop  (see the top of the file)');
}
