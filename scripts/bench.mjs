#!/usr/bin/env node
// Frame-time benchmark: loads the game in headless Chromium on the real GPU, waits for
// the map, then measures a few scenes (standing on the Old Town Square, driving east
// from it with lane assist, standing in the Petřín woods).
//
//   node scripts/bench.mjs [--url http://localhost:5191/] [--scenes stand,drive,woods]
//     [--seconds 10] [--dpr 2] [--cpu 4] [--profile] [--weather clear] [--time 14:00]
//     [--profile-load] [--load-progress] [--require-webgpu] [--init "js before loading"] [--runs 1] [--graphics high] [--extra "&osm"] [--eval "js after loading"] [--eval-after "js after timing"] [--json out.json] [--stack (page errors with their stack)]
//     [--browser chrome|chromium] [--angle metal|swiftshader (software, drawing like
//     a desktop GPU that shades every covered pixel: for overdraw)]
//     [--vs http://localhost:5192/ (compare with another server, taking turns)] [--fresh-browser] [--loading-frames]
//     [--ab "window.__ab = (on) => { … }" [--window 2] [--warmup 2]] [--shot /tmp/look-%v-%s.png (%v = baseline/candidate, %s = scene) [--zoom 0.5]]
//     [--stalls (what each long task was: shader builds, pipelines, uploads, tile builds)]
//     [--android [serial] (Chrome on a phone over adb instead of headless Chrome here)]
//
// Per scene it reports the frame rate, frame times (median, 95th, 99th percentile),
// the JavaScript time per frame (the whole requestAnimationFrame callback), how much of
// that is renderer.render, the GPU time (a timer query round render, where the browser
// offers one), draw calls and triangles. --profile adds the functions with the most
// self time (and writes the .cpuprofile to /tmp). --cpu 4 slows the CPU down 4× (a
// stand-in for a phone, but only for the page's main thread: not its workers or the GPU
// process). --android runs on a real phone instead: its Chrome is started and driven over
// adb (the dev server's ports are passed through, so the phone reaches it on its own
// localhost), the battery temperature is printed after each scene (a phone slows as it
// warms), and the phone's screen and pixel ratio stand in for the window here. It waits
// for other sessions' scenes and benchmarks to finish first (game-lock.mjs). Needs the
// dev server (npm run dev) and Playwright; it takes Playwright from PLAYWRIGHT_PATH or
// the usual places.

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkIn } from './game-lock.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const URL_BASE = args.url || 'http://localhost:5191/';
const SCENES = String(args.scenes || 'stand,drive,woods').split(',');
const SECONDS = Number(args.seconds || 10);
const DPR = Number(args.dpr || 2);
const CPU = Number(args.cpu || 1);
const RUNS = Number(args.runs || 1);

const require = createRequire(import.meta.url);
const tryReq = (p) => { try { return require(p); } catch { return null; } };
const pw = tryReq(process.env.PLAYWRIGHT_PATH || 'playwright') || tryReq(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
if (!pw) { console.error('Playwright not found; set PLAYWRIGHT_PATH'); process.exit(1); }

// --android: the phone, its Chrome's DevTools on a local port, and the dev servers'
// ports passed through to it.
const ANDROID = args.android ? setUpAndroid(typeof args.android === 'string' ? args.android : process.env.ANDROID_SERIAL) : null;
function setUpAndroid(serial) {
  const run = (...a) => execFileSync('adb', serial ? ['-s', serial, ...a] : a, { encoding: 'utf8' }).trim();
  if (!serial) {
    const devices = execFileSync('adb', ['devices'], { encoding: 'utf8' }).split('\n').slice(1).filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0]);
    if (devices.length !== 1) { console.error(`--android: ${devices.length} devices attached (${devices.join(', ')}); give one: --android <serial>`); process.exit(1); }
    serial = devices[0];
  }
  const ports = [...new Set([URL_BASE, args.vs].filter(Boolean).map((u) => {
    const url = new URL(u);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) { console.error(`--android needs a local dev server, not ${u}`); process.exit(1); }
    return url.port || '80';
  }))];
  for (const p of ports) run('reverse', `tcp:${p}`, `tcp:${p}`);
  run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  run('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', 'com.android.chrome');
  const devtools = String(args['android-port'] || 9333);
  run('forward', `tcp:${devtools}`, 'localabstract:chrome_devtools_remote');
  const model = run('shell', 'getprop', 'ro.product.model'), version = run('shell', 'getprop', 'ro.build.version.release');
  const temperature = () => { const m = run('shell', 'dumpsys', 'battery').match(/temperature: (\d+)/); return m ? Number(m[1]) / 10 : NaN; };
  console.log(`On ${model} (Android ${version}, ${serial}), battery at ${temperature()} °C`);
  const cleanUp = () => {
    for (const p of ports) try { run('reverse', '--remove', `tcp:${p}`); } catch {}
    try { run('forward', '--remove', `tcp:${devtools}`); } catch {}
  };
  return { devtools, temperature, cleanUp };
}

const PLACES = {
  stand: { start: '14.4206,50.0873', drive: false },  // Old Town Square
  drive: { start: '14.4052,50.0808', drive: true },   // from Újezd (the game's start, with a car at the kerb), with lane assist
  woods: { start: '14.3965,50.0830', drive: false },  // Petřín: trees and slopes
  slatiny: { start: '14.4845,50.0610', drive: false }, // Na Slatinách, Strašnice: garden suburb, many shrubs
  park: { start: '14.4275,50.0930', drive: false },   // Letná park
  suburb: { start: '14.4760,50.0520', drive: false }, // Vršovice/Strašnice edge: gardens
  estate: { start: '14.4210,50.1318', drive: false },  // Kobylisy housing estate by the school: streets lined with flats, many parked cars (see --eval "__test.view(3)")
  river: { start: '14.4125,50.0862', drive: false },  // by Charles Bridge: water, quays, the bridge
  tunnel: { start: '14.3905,50.0780', drive: false }, // over the Strahov tunnel (see --eval for getting into it)
  strana: { start: '14.4030,50.0883', drive: false }, // Malá Strana, by the Malostranské náměstí: courtyards and lanes
  square: { start: '14.4185,50.0760', drive: false }, // Karlovo náměstí: main roads with buses
  florenc: { start: '14.4420,50.0894', drive: false }, // Florenc bus station and its unmapped yards: much photo-classified ground
  barrandov: { start: '14.3862,50.0309', drive: false }, // Barrandov villas: woods and gardens in the cover
  bubenec: { start: '14.4315,50.1051', drive: false }, // Bubeneč railway edge: ballast, gravel and trees from the photos
  plaska: { start: '14.4070,50.0782', drive: false },  // Plaská, Malá Strana/Smíchov: roofs and facades from above (plan 005)
};

// In the page before anything else: time every animation-frame callback.
const INIT = (loadingFrames = false) => {
  window.__benchLoad = { adapter: 'not requested', device: 'not requested' };
  // A pending GPU request has no network request or page error. Record it so a
  // loading timeout can distinguish browser/driver startup from tile building.
  if (navigator.gpu) {
    const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      window.__benchLoad.adapter = 'pending';
      const adapter = await requestAdapter(...args);
      window.__benchLoad.adapter = adapter ? 'ready' : 'unavailable';
      if (adapter) {
        const requestDevice = adapter.requestDevice.bind(adapter);
        adapter.requestDevice = async (...args) => {
          window.__benchLoad.device = 'pending';
          const device = await requestDevice(...args);
          window.__benchLoad.device = 'ready';
          device.lost.then((info) => { window.__benchLoad.device = `lost: ${info.reason} ${info.message}`; });
          return device;
        };
      }
      return adapter;
    };
  }
  const raf = window.requestAnimationFrame.bind(window);
  window.__bench = { frames: [], js: [], render: [], gpu: [], calls: [], tris: [], on: false, rendering: 0 };
  if (loadingFrames) {
    // Keep headless Chrome's frame scheduler active while it creates the device.
    // Use the original RAF and stop at startup, so this never contributes samples.
    const tick = () => { if (!window.__drive) raf(tick); };
    raf(tick);
  }
  window.requestAnimationFrame = (cb) => raf((t) => {
    const t0 = performance.now();
    const b = window.__bench;
    b.rendering = 0;
    cb(t);
    // (render: all of renderer.render in the frame, e.g. the lamps' light map and the scene.)
    if (b.on) { b.frames.push(t); b.js.push(performance.now() - t0); b.render.push(b.rendering); }
  });
};

const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');

async function runScene(browser, name, base = URL_BASE) {
  const place = PLACES[name];
  // (On a phone: its Chrome's own context, and a new tab in it.)
  const ctx = ANDROID ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  let closing = false;
  const close = async () => {
    closing = true;
    // Release the owned device before opening the next context. Context closure
    // alone can leave GPU resources queued for reclamation between --vs scenes.
    await page.evaluate(() => {
      const r = window.__drive?.renderer;
      r?.setAnimationLoop(null);
      r?.backend?.device?.destroy();
    }).catch(() => {});
    if (ANDROID) await page.close();
    else await ctx.close();
  };
  await page.addInitScript(INIT, !!args['loading-frames']);
  if (args.init) await page.addInitScript(args.init);
  page.on('pageerror', (e) => { if (closing) return; errors.push(e.message); console.error(`[${name}] page error:`, args.stack ? e.stack : e.message); });
  page.on('console', (m) => { if (closing) return; if (m.type() === 'info' && m.text().startsWith('Renderer:')) console.log(`[${name}] ${m.text()}`); if (m.type() === 'error' && !errors.includes(m.text())) { errors.push(m.text()); console.error(`[${name}] console:`, m.text().slice(0, 3000)); } });
  const q = `?start=${place.start}&dpr=${DPR}&graphics=${args.graphics || 'high'}&time=${args.time || '14:00'}&go&day=wed&weather=${args.weather || 'clear'}${args.extra || ''}`;
  // --profile-load: the CPU profile of loading, up to the game starting.
  const loadCdp = args['profile-load'] ? await ctx.newCDPSession(page) : null;
  if (loadCdp) { await loadCdp.send('Profiler.enable'); await loadCdp.send('Profiler.setSamplingInterval', { interval: 200 }); await loadCdp.send('Profiler.start'); }
  const loadStart = Date.now();
  const pending = new Set();
  page.on('request', (r) => pending.add(r.url()));
  page.on('requestfinished', (r) => pending.delete(r.url()));
  page.on('requestfailed', (r) => pending.delete(r.url()));
  await page.goto(base + q);
  // Loaded: the loading screen is gone and the game is available.
  const loadingState = () => page.evaluate(() => ({
    stage: document.getElementById('loading-text')?.textContent,
    done: document.getElementById('loading')?.classList.contains('done'),
    game: !!window.__drive, hidden: document.hidden, ...window.__benchLoad,
  }));
  const progress = args['load-progress'] ? setInterval(async () => {
    try { console.log(`[${name}] loading ${f1((Date.now() - loadStart) / 1000)} s`, await loadingState(), 'requests', [...pending]); } catch {}
  }, 5000) : null;
  try {
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__drive, null, { timeout: 120000, polling: 100 });
  } catch (e) {
    console.error(`[${name}] load did not finish`, await loadingState().catch(() => null), 'requests', [...pending]);
    throw e;
  } finally {
    if (progress) clearInterval(progress);
  }
  const backend = await page.evaluate(() => {
    const r = window.__drive.renderer;
    return r.backend ? (r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2') : 'WebGL';
  });
  if (args['require-webgpu'] && backend !== 'WebGPU') throw new Error(`Required WebGPU, got ${backend}; refusing to time a fallback`);
  const loadTime = (Date.now() - loadStart) / 1000;
  if (loadCdp) {
    const { profile } = await loadCdp.send('Profiler.stop');
    writeFileSync(`/tmp/bench-${name}-load.cpuprofile`, JSON.stringify(profile));
    console.log(`${name}: loading\n${topSelf(profile).join('\n')}`);
  }
  await page.keyboard.press('KeyH'); // fold the help card away
  if (place.drive) {
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(300);
    const inCar = await page.evaluate(() => !!window.__drive.car);
    if (!inCar) console.warn(`[${name}] could not get into the car`);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
  }
  // Settle: the streets round the view load, the shaders compile.
  await page.waitForTimeout(place.drive ? 3000 : 6000);
  await page.waitForFunction(() => window.__drive.world.inFlight.size === 0, null, { timeout: 60000, polling: 200 }).catch(() => {});
  if (args.eval) { const out = await page.evaluate(args.eval); if (out !== undefined) console.log(typeof out === "string" ? out : JSON.stringify(out, null, 1)); await page.waitForTimeout(1000); }
  if (args.shot) {
    // A still for comparing looks: the clock and the crowd held, so two runs match.
    if (args.zoom) await page.evaluate((z) => window.__drive.view(z), Number(args.zoom));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: String(args.shot).replace('%v', base === args.vs ? 'baseline' : 'candidate').replace('%s', name), timeout: 60000 });
  }

  const cdp = CPU > 1 || args.profile ? await ctx.newCDPSession(page) : null;
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  if (args.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }

  await page.evaluate(() => {
    const d = window.__drive, b = window.__bench, r = d.renderer, gl = r.getContext();
    const ext = gl.getExtension ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null; // (none on WebGPU)
    const pending = [];
    const render = r.render.bind(r);
    let depth = 0;
    r.render = (s, c) => {
      // Only the outermost render: three.js's WebGPU renderer draws the shadow maps with
      // renderer.render from inside the main one.
      if (depth) return render(s, c);
      depth++;
      try { return outer(s, c); } finally { depth--; }
    };
    const outer = (s, c) => {
      const t0 = performance.now();
      let q = null;
      if (ext && b.on) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      render(s, c);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
      b.rendering += performance.now() - t0;
      if (b.on && s === d.scene) { b.calls.push(r.info.render.drawCalls ?? r.info.render.calls); b.tris.push(r.info.render.triangles); }
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const p = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) b.gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(p);
      }
    };
    b.gpuAvailable = !!ext;
    b.on = true;
  });
  if (args.stalls && !args.ab) await page.evaluate(readFileSync(new URL('./bench-stalls.js', import.meta.url), 'utf8'));
  if (args.ab) {
    const result = await abScene(page, ctx, name, close);
    result.errors = errors;
    return result;
  }
  const t0 = Date.now();
  await page.waitForTimeout(SECONDS * 1000);
  const res = await page.evaluate(() => {
    const b = window.__bench, d = window.__drive;
    b.on = false;
    return { frames: b.frames, js: b.js, render: b.render, gpu: b.gpu, calls: b.calls, tris: b.tris, gpuAvailable: b.gpuAvailable,
      people: d.crowd.people.length, traffic: d.traffic.agents.length, loose: d.loose.length, tiles: d.world.loaded.size, building: d.world.inFlight.size,
      ratio: d.renderer.getPixelRatio(), tier: d.graphics.tier, speed: d.car ? d.car.speed * 3.6 : 0 };
  });
  const wall = (Date.now() - t0) / 1000;
  if (args.stalls && !args.ab) for (const line of await page.evaluate(() => window.__stalls.report())) console.log(`[${name}] ${line}`);
  if (args['eval-after']) {
    const out = await page.evaluate(args['eval-after']);
    if (out !== undefined) console.log(`[${name}] after timing`, typeof out === 'string' ? out : JSON.stringify(out));
  }
  let profile = null;
  if (args.profile) {
    ({ profile } = await cdp.send('Profiler.stop'));
    writeFileSync(`/tmp/bench-${name}.cpuprofile`, JSON.stringify(profile));
  }
  await close();

  const dts = res.frames.slice(1).map((t, i) => t - res.frames[i]);
  return {
    name, fps: res.frames.length / wall, frameMed: pct(dts, 0.5), frame95: pct(dts, 0.95), frame99: pct(dts, 0.99),
    js: mean(res.js), js95: pct(res.js, 0.95), render: mean(res.render), gpu: res.gpu.length ? mean(res.gpu) : NaN, gpu95: pct(res.gpu, 0.95),
    calls: mean(res.calls), tris: mean(res.tris), people: res.people, traffic: res.traffic, loose: res.loose, tiles: res.tiles,
    ratio: res.ratio, tier: res.tier, speed: res.speed, profile, loadTime, errors, backend, temperature: ANDROID ? ANDROID.temperature() : null,
  };
}

// --ab "js": the code defines window.__ab(on), which switches a change on or off in
// the page. Off and on take turns in short windows (--window seconds, default 2) for
// --seconds in all, so a machine that gets busier or cooler meanwhile affects both alike.
async function abScene(page, ctx, name, close) {
  await page.evaluate(args.ab);
  // Both paths must draw before timing: shadow/MSAA changes create new pipelines,
  // which can take longer than the short gap between measurement windows.
  for (const on of [false, true]) {
    await page.evaluate((on) => { window.__ab(on); window.__bench.on = false; }, on);
    await page.waitForTimeout(Number(args.warmup || 2) * 1000);
  }
  const win = Number(args.window || 2) * 1000, sums = { off: [], on: [] };
  for (let t = 0, k = 0; t < SECONDS * 1000; t += win, k++) {
    const on = k % 2 === 1;
    await page.evaluate((on) => { window.__ab(on); const b = window.__bench; b.on = false; }, on);
    await page.waitForTimeout(400); // (a changed shader compiles, the frame queue drains)
    await page.evaluate(() => { const b = window.__bench; for (const k of ['frames', 'js', 'render', 'gpu', 'calls', 'tris']) b[k] = []; b.on = true; });
    const t0 = Date.now();
    await page.waitForTimeout(win);
    const res = await page.evaluate(() => { const b = window.__bench; b.on = false; return { n: b.frames.length, js: b.js, gpu: b.gpu }; });
    sums[on ? 'on' : 'off'].push({ fps: res.n / ((Date.now() - t0) / 1000), js: mean(res.js), gpu: res.gpu.length ? mean(res.gpu) : NaN });
  }
  await close();
  const agg = (xs) => ({ fps: mean(xs.map((x) => x.fps)), ms: mean(xs.map((x) => 1000 / x.fps)), js: mean(xs.map((x) => x.js)), gpu: mean(xs.map((x) => x.gpu)), each: xs.map((x) => Math.round(x.fps)).join(' ') });
  const off = agg(sums.off), on = agg(sums.on);
  return { name, ab: true, off, on };
}

function topSelf(profile, n = 25) {
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]));
  const self = new Map();
  const dt = profile.timeDeltas;
  let total = 0;
  profile.samples.forEach((id, i) => {
    const nd = byId.get(id), f = nd.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0));
    total += dt[i] || 0;
  });
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`);
}

// Google Chrome itself by default (--browser chromium for Playwright's own build, whose
// MSAA costs several times more than Chrome's on a Mac).
const launchBrowser = () => (ANDROID ? pw.chromium.connectOverCDP(`http://localhost:${ANDROID.devtools}`) : pw.chromium.launch({
  headless: true, channel: args.browser === 'chromium' ? undefined : 'chrome',
  args: [`--use-angle=${args.angle || 'metal'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu'],
}));
// The machine to itself (game-lock.mjs): waits for other sessions' scenes and benchmarks
// to finish, and games open from a dev server stand still until this ends. A phone's
// frame rate doesn't depend on what else runs here.
if (!ANDROID) await (await checkIn('bench', `bench.mjs ${process.argv.slice(2).join(' ')}`.trim())).take();
// Some Chrome/Metal sessions leave the next context's requestDevice pending.
// A fresh process per scene keeps the same --vs order without timing fallbacks.
const browser = args['fresh-browser'] ? null : await launchBrowser();
async function measure(name, base = URL_BASE) {
  const current = browser || await launchBrowser();
  try { return await runScene(current, name, base); }
  finally { if (!browser) await current.close(); }
}
const all = [];
try {
  if (args.vs) {
    // Against another server (a worktree of main, say): the two take turns, --runs
    // times each, and the means are compared.
    const res = { vs: {}, url: {} };
    for (let run = 0; run < RUNS; run++) for (const s of SCENES) for (const [k, base] of [['vs', args.vs], ['url', URL_BASE]]) {
      const r = await measure(s, base);
      delete r.profile;
      (res[k][s] ||= []).push(r);
      if (args.json) writeFileSync(args.json, JSON.stringify([{ comparison: true, before: res.vs, after: res.url }], null, 2));
      console.log(`${s.padEnd(7)} ${k === 'vs' ? 'before' : 'after '} ${f1(r.fps).padStart(6)} fps  ${f1(1000 / r.fps)} ms/frame  js ${f1(r.js)} ms  gpu ${f1(r.gpu)} ms  ${Math.round(r.calls)} calls  loaded in ${f1(r.loadTime)} s${r.temperature ? `  ${r.temperature} °C` : ''}`);
    }
    all.push({ comparison: true, before: res.vs, after: res.url });
    for (const s of SCENES) {
      const ms = (rs) => mean(rs.map((r) => 1000 / r.fps)), a = ms(res.vs[s]), b = ms(res.url[s]);
      console.log(`${s.padEnd(7)} ${f1(a)} → ${f1(b)} ms a frame (${f1((a - b) / a * 100)}% quicker), js ${f1(mean(res.vs[s].map((r) => r.js)))} → ${f1(mean(res.url[s].map((r) => r.js)))} ms`);
    }
    process.exitCode = 0;
  }
  for (let run = 0; run < (args.vs ? 0 : RUNS); run++) for (const s of SCENES) {
    const r = await measure(s);
    all.push(r);
    if (r.ab) {
      if (r.errors.length) console.warn(`[${r.name}] ${r.errors.length} errors: inspect before trusting these timings`);
      const line = (k, x) => `${r.name.padEnd(7)} ${k.padEnd(4)} ${f1(x.fps).padStart(6)} fps  ${f1(x.ms)} ms/frame  js ${f1(x.js)} ms  gpu ${f1(x.gpu)} ms  [${x.each}]`;
      console.log(`${line('off', r.off)}\n${line('on', r.on)}\n${r.name.padEnd(7)} on is ${f1((r.off.ms - r.on.ms) / r.off.ms * 100)}% quicker a frame`);
      continue;
    }
    console.log(`${r.name.padEnd(7)} ${f1(r.fps).padStart(6)} fps  frame ${f1(r.frameMed)}/${f1(r.frame95)}/${f1(r.frame99)} ms  js ${f1(r.js)} (p95 ${f1(r.js95)}, render ${f1(r.render)}) ms  gpu ${f1(r.gpu)} (p95 ${f1(r.gpu95)}) ms  ${Math.round(r.calls)} calls ${(r.tris / 1e6).toFixed(2)}M tris  ${r.people} people ${r.traffic} traffic ${r.loose} loose ${r.tiles} tiles  ${r.ratio}× ${r.tier}${r.speed ? `  ${Math.round(r.speed)} km/h` : ''}  loaded in ${f1(r.loadTime)} s${r.temperature ? `  ${r.temperature} °C` : ''}`);
    if (r.profile) { console.log(topSelf(r.profile).join('\n')); delete r.profile; }
  }
} finally {
  if (browser) await browser.close();
  ANDROID?.cleanUp();
}
if (args.json) writeFileSync(args.json, JSON.stringify(all, null, 2));
