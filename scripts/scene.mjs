#!/usr/bin/env node
// Runs test scenarios (scenarios/*.ts) and bits of script in the real game, in headless
// Chrome, through the test API in src/testkit.ts (window.__test, `t` below).
//
//   node scripts/scene.mjs run lamp-knock [wall-crash …]    scenarios by name, or `all`
//   node scripts/scene.mjs eval "await t.go('karlova'); return t.probe()"
//   node scripts/scene.mjs eval --stdin <<'EOF' … EOF        a longer script
//   node scripts/scene.mjs shot [name]                      a screenshot of the game as it is
//   node scripts/scene.mjs serve [--show] [--port 5199]   keep a browser with the map loaded
//   node scripts/scene.mjs servers                          the scene servers running here
//   node scripts/scene.mjs list | stop [--all]
//
// The first run, eval or shot starts a scene server in the background (as `serve` would,
// with the same options) and leaves it running, so the next command finds the game
// loaded. Each Claude Code session gets a port of its own (from CLAUDE_CODE_SESSION_ID;
// 5199 elsewhere). A server stops itself after --idle minutes without a command (10; 0:
// never), when the Claude Code session that started it ends, or when its dev server has
// gone; `stop` stops it at once, `stop --all` every one on the machine. --once loads the
// game just for the command, as before. A running server keeps the options it started
// with: a command passing others says so (stop it, or use --fresh for a one-off).
//
// Common options: [--url http://localhost:5191/ (the default: this checkout's dev
// server, 5191 or a git worktree's own port, scripts/worktree-setup.mjs)] [--out dir
// for screenshots (default $TMPDIR/scene)] [--place staromak] [--time 14:00]
// [--weather clear] [--graphics high]
// [--date 10-20 (or spring, summer, autumn, winter; today's date otherwise)]
// [--extra "&area=centrum" (more of the game's URL parameters)] [--size 1920x1080 (the
// window; t.film saves footage frame by frame at that size)] [--jpeg (screenshots as JPEG)]
// [--map <folder> (the game's files it holds, data/praha_now/… as <folder>/praha_now/…,
// come from there: a few tiles built on their own)].
// With a server running, each command takes a second or two instead of the 10–60 s of
// loading the map. --fresh always opens a new browser (just for the command) so URL
// options apply.
// The server follows the dev server's reloads: a command waits for the game to load
// again. A command waits while another session benchmarks (game-lock.mjs). Exits 1 if
// a scenario fails or the page throws. Needs the dev server
// (npm run dev) and Playwright (PLAYWRIGHT_PATH or the usual places).

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer, get, request } from 'node:http';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutOf, devPort } from './checkout.mjs';
import { checkIn } from './game-lock.mjs';
import { gpuFlags } from './gpu-flags.mjs';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const args = {}, pos = [];
// (Flags that take no value, so that `eval --once "…"` keeps its script.)
const FLAGS = new Set(['show', 'fresh', 'jpeg', 'stdin', 'once', 'all']);
for (let i = 0; i < rest.length; i++) {
  const key = rest[i].slice(2);
  if (rest[i].startsWith('--')) args[key] = !FLAGS.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  else pos.push(rest[i]);
}
// A port for each Claude Code session, so that sessions don't move each other's player.
const sessionPort = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return 5300 + (h % 400); };
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || '';
const PORT = Number(args.port || (SESSION ? sessionPort(SESSION) : 5199));
// This checkout's dev server: in a git worktree, its own (docs/handbook.md, "Scenes in a
// busy checkout"), so that a session there drives the game as its own files have it.
const DEV_PORT = devPort(checkoutOf(fileURLToPath(new URL('..', import.meta.url))));
const URL_BASE = args.url || (DEV_PORT ? `http://localhost:${DEV_PORT}/` : null);
const OUT = args.out || join(tmpdir(), 'scene');
// How long the game may take to load: minutes on a machine busy with other sessions
// (SOP_LOAD_TIMEOUT, in seconds).
const LOAD_TIMEOUT = Number(process.env.SOP_LOAD_TIMEOUT || 180) * 1000;
const ROOT = new URL('..', import.meta.url).pathname;
// The options a server keeps from its start (passed on when a command starts one).
const SERVER_OPTS = ['url', 'out', 'place', 'time', 'weather', 'graphics', 'date', 'extra', 'size', 'jpeg', 'map', 'browser', 'show', 'idle'];
// Each scene server running on the machine: a file per process (`servers`, `stop --all`).
const SERVERS = join(process.env.SOP_LOCK_DIR ? join(process.env.SOP_LOCK_DIR, '..') : join(homedir(), '.cache', 'streets-of-prague'), 'scene-servers');
const living = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`; };
function servers() {
  let names = [];
  try { names = readdirSync(SERVERS); } catch { return []; }
  const out = [];
  for (const name of names) {
    let s;
    try { s = JSON.parse(readFileSync(join(SERVERS, name), 'utf8')); } catch { continue; }
    if (living(s.pid)) out.push(s);
    else try { unlinkSync(join(SERVERS, name)); } catch {}
  }
  return out.sort((a, b) => a.port - b.port);
}

// Whether the dev server answers.
const devUp = () => new Promise((resolve) => {
  if (!URL_BASE) return resolve(false);
  const req = get(URL_BASE, (res) => { res.resume(); resolve(true); });
  req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  req.on('error', () => resolve(false));
});
const noDevServer = () => new Error(!URL_BASE ? 'This worktree has no dev server port of its own yet: run node scripts/worktree-setup.mjs, then npm run dev (or pass --url)' : `No dev server answers at ${URL_BASE}${args.url ? '' : ', the one for this checkout'}: start it with npm run dev in ${fileURLToPath(new URL('..', import.meta.url))}, or pass --url`);

// Talking to a running server.
const call = (body, port = PORT) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  });
  req.on('error', reject);
  req.end(JSON.stringify(body));
});
// (The reply carries the options the server started with.)
const ping = () => call({ cmd: 'ping' }).then((r) => r, () => null);
const alive = async () => !!(await ping());

// A server in the background with this command's options, for this and later commands.
async function startServer() {
  const pass = [];
  for (const k of SERVER_OPTS) if (args[k] !== undefined) pass.push(`--${k}`, ...(args[k] === true ? [] : [String(args[k])]));
  mkdirSync(OUT, { recursive: true });
  const log = join(tmpdir(), `scene-serve-${PORT}.log`);
  const fd = openSync(log, 'w');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--port', String(PORT), ...pass], {
    detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
  });
  closeSync(fd);
  child.unref();
  let gone = null;
  child.on('exit', (code) => { gone = code ?? 'a signal'; });
  console.error(`Starting a scene server on port ${PORT} (log: ${log})…`);
  const t0 = Date.now();
  while (Date.now() - t0 < LOAD_TIMEOUT + 30_000) {
    if (gone !== null) {
      let tail = '';
      try { tail = readFileSync(log, 'utf8').trim().split('\n').slice(-8).join('\n'); } catch {}
      throw new Error(`The scene server stopped while starting (exit ${gone}):\n${tail}`);
    }
    if (await alive()) {
      const idle = Number(args.idle ?? process.env.SOP_SCENE_IDLE ?? 10);
      console.error(`Scene server up in ${((Date.now() - t0) / 1000).toFixed(0)} s. It stays for the next commands and stops ${idle ? `after ${idle} min without one` : 'only when told'}, when this session ends or with: node scripts/scene.mjs stop`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The scene server didn't come up in ${LOAD_TIMEOUT / 1000 + 30} s (log: ${log})`);
}

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
    args: gpuFlags(),
  });
  const [width, height] = String(args.size || '1280x800').split('x').map(Number);
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  // --map <folder>: a map folder of a few tiles (the terrain-steps skill's window.py
  // --data) answers for the files it has, the dev server's map for the rest.
  if (args.map) {
    const own = new Set(readdirSync(args.map, { recursive: true }).map(String));
    const file = (url) => decodeURIComponent(new URL(url).pathname).split('/data/')[1];
    await page.route((url) => own.has(file(url)), (route) => route.fulfill({ path: join(args.map, file(route.request().url())) }));
    console.error(`Map files from ${args.map}: ${own.size}`);
  }
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
  // For t.look's contact sheet: the window as it is (JPEG, base64), and the sheet made of
  // such pictures saved and listed with the command's screenshots.
  await page.exposeFunction('__grab', async () => (await page.screenshot({ type: 'jpeg', quality: 92 })).toString('base64'));
  await page.exposeFunction('__saveShot', async (name, base64) => {
    const path = join(OUT, String(name).replace(/[^\w.-]+/g, '-'));
    writeFileSync(path, Buffer.from(base64, 'base64'));
    shots.push(path);
    return path;
  });
  const place = args.place || 'staromak';
  const q = `?place=${place}&go&day=wed&time=${args.time || '14:00'}&weather=${args.weather || 'clear'}&graphics=${args.graphics || 'high'}&dpr=1${args.date ? `&date=${args.date}` : ''}${args.extra || ''}`;
  const t0 = Date.now();
  await page.goto(URL_BASE + q, { timeout: LOAD_TIMEOUT });
  const ready = async () => {
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__test, null, { timeout: LOAD_TIMEOUT, polling: 200 });
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

const startedWith = () => Object.fromEntries(SERVER_OPTS.filter((k) => k !== 'idle' && args[k] !== undefined).map((k) => [k, args[k]]));

async function handle(game, { cmd, name, code }) {
  if (cmd === 'ping') return { value: 'ok', opts: startedWith(), url: URL_BASE };
  if (cmd === 'list') return game.scenarios();
  if (cmd === 'run') return game.scenario(name);
  if (cmd === 'eval') return game.eval(code);
  if (cmd === 'shot') return game.shot(name);
  return { error: `Unknown command ${cmd}` };
}

// ---- Commands ----------------------------------------------------------------

const scenarioNames = () => readdirSync(join(ROOT, 'scenarios')).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3)).sort();

// Through this session's server, started first if there is none; with --fresh or --once,
// in a browser just for this.
async function withGame(bodies) {
  if (!args.fresh && !args.once) {
    let up = await ping();
    if (!up) {
      if (!(await devUp())) throw noDevServer();
      await startServer();
      up = await ping();
    }
    if (up) {
      // Options that only apply when a server starts.
      const had = up.opts || {}, own = startedWith();
      const differ = Object.keys(own).filter((k) => String(own[k]) !== String(had[k] ?? ''));
      if (up.url && up.url !== URL_BASE) console.error(`Note: the scene server on port ${PORT} plays the game from ${up.url}, not ${URL_BASE} (node scripts/scene.mjs stop first to change).`);
      if (differ.length) console.error(`Note: the scene server on port ${PORT} started with ${Object.entries(had).map(([k, v]) => `--${k} ${v}`).join(' ') || 'the defaults'}; this command's ${differ.map((k) => `--${k}`).join(', ')} don't apply to it (node scripts/scene.mjs stop first, or --fresh for a one-off).`);
      const out = [];
      for (const b of bodies) out.push(await call(b));
      return out;
    }
  }
  if (!(await devUp())) throw noDevServer();
  console.error(args.fresh ? 'Loading the game in a fresh browser…' : 'Loading the game for this command…');
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
  if (!URL_BASE) throw noDevServer();
  const game = await openGame({ show: !!args.show });
  slot.rest();
  // When to go: after IDLE without a command, once the Claude Code session that started
  // it has ended (its process, CLAUDE_PID), or when the dev server has stopped answering.
  const IDLE = Number(args.idle ?? process.env.SOP_SCENE_IDLE ?? 10) * 60_000;
  const OWNER = Number(args.owner || process.env.CLAUDE_PID || 0);
  const started = Date.now();
  let last = started, busy = 0, devMisses = 0;
  mkdirSync(SERVERS, { recursive: true });
  const entry = join(SERVERS, `${process.pid}.json`);
  const record = () => writeFileSync(entry, JSON.stringify({
    pid: process.pid, port: PORT, url: URL_BASE, out: OUT, owner: OWNER || null, session: SESSION.slice(0, 8) || null,
    checkout: ROOT, started, last, idle: IDLE / 60_000, opts: startedWith(),
  }));
  record();
  process.on('exit', () => { try { unlinkSync(entry); } catch {} });
  const quit = async (why) => {
    console.error(`Scene server on port ${PORT} stopping: ${why}`);
    try { unlinkSync(entry); } catch {}
    await game.close().catch(() => {});
    process.exit(0);
  };
  setInterval(async () => {
    if (busy) return;
    if (IDLE && Date.now() - last > IDLE) return quit(`no command for ${IDLE / 60_000} min`);
    if (OWNER && !living(OWNER)) return quit(`the session that started it (process ${OWNER}) has ended`);
    devMisses = (await devUp()) ? 0 : devMisses + 1;
    if (devMisses >= 3 && !busy) quit(`the dev server at ${URL_BASE} has stopped answering`);
  }, 20_000).unref();
  let queue = Promise.resolve();
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      busy++;
      queue = queue.then(async () => {
        let body;
        try { body = JSON.parse(data || '{}'); } catch { body = {}; }
        try {
          if (body.cmd === 'stop') {
            res.end(JSON.stringify({ value: 'stopping' }));
            await quit('asked to');
          }
          const out = await handle(game, body).catch((e) => ({ error: e.message }));
          slot.rest();
          // (A value that refers to itself, a mesh say, is the command's mistake, not the server's.)
          let reply;
          try { reply = JSON.stringify(out); } catch (e) { reply = JSON.stringify({ error: `the result can't be sent: ${e.message.split('\n')[0]}` }); }
          res.end(reply);
        } finally {
          busy--;
          // (A ping is no use of the game.)
          if (body.cmd !== 'ping') { last = Date.now(); record(); }
        }
      });
    });
  });
  server.listen(PORT, '127.0.0.1', () => console.error(`Scene server on port ${PORT}; screenshots go to ${OUT}. It stops ${IDLE ? `after ${IDLE / 60_000} min without a command` : 'only when told'}${OWNER ? `, when process ${OWNER} (the Claude Code session) ends` : ''} or with: node scripts/scene.mjs stop`));
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
  const [r] = await withGame([{ cmd: 'eval', code: args.stdin ? readFileSync(0, 'utf8') : pos.join(' ') }]);
  if (r.value !== undefined) console.log(JSON.stringify(r.value, null, 2));
  process.exit(report(r) ? 0 : 1);
} else if (cmd === 'shot') {
  const [r] = await withGame([{ cmd: 'shot', name: pos[0] }]);
  process.exit(report(r) ? 0 : 1);
} else if (cmd === 'list') {
  console.log(scenarioNames().join('\n'));
} else if (cmd === 'stop' && args.all) {
  // Every scene server on the machine (other sessions' next command starts its own again).
  const all = servers();
  for (const s of all) {
    await call({ cmd: 'stop' }, s.port).catch(() => { try { process.kill(s.pid); } catch {} });
    console.error(`Stopped the scene server on port ${s.port} (process ${s.pid})`);
  }
  if (!all.length) console.error('No scene servers running');
} else if (cmd === 'stop') {
  if (await alive()) { await call({ cmd: 'stop' }).catch(() => {}); console.error(`Stopped the scene server on port ${PORT}`); }
  else console.error(`No scene server running on port ${PORT}`);
} else if (cmd === 'servers') {
  const all = servers();
  for (const s of all) {
    const mine = s.port === PORT ? '  (this session)' : '';
    console.log(`port ${s.port}  process ${s.pid}  up ${ago(s.started)}, last command ${ago(s.last)} ago${s.idle ? `, stops after ${s.idle} min idle` : ''}${s.session ? `  session ${s.session}` : ''}  ${s.url}${mine}`);
  }
  if (!all.length) console.log('No scene servers running');
} else {
  console.log('Usage: node scripts/scene.mjs run <name…|all> | eval "<js>" | shot [name] | serve | servers | list | stop [--all]  (see the top of the file)');
}
