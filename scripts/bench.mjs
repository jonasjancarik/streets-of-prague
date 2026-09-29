#!/usr/bin/env node
// Frame-time benchmark: loads the game in headless Chromium on the real GPU, waits for
// the map, then measures a few scenes (standing on the Old Town Square, driving east
// from it with lane assist, standing in the Petřín woods).
//
//   node scripts/bench.mjs [--url http://localhost:5191/] [--scenes stand,drive,woods]
//     [--seconds 10] [--dpr 2] [--cpu 4] [--profile] [--weather clear] [--time 14:00]
//     [--profile-load] [--runs 1] [--graphics high] [--extra "&osm"] [--eval "js run in the page after loading"] [--json out.json]
//     [--browser chrome|chromium] [--angle metal|swiftshader (software, drawing like
//     a desktop GPU that shades every covered pixel: for overdraw)]
//     [--vs http://localhost:5192/ (compare with another server, taking turns)]
//     [--ab "window.__ab = (on) => { … }" [--window 2]] [--shot /tmp/look-%s.png [--zoom 0.5]]
//
// Per scene it reports the frame rate, frame times (median, 95th, 99th percentile),
// the JavaScript time per frame (the whole requestAnimationFrame callback), how much of
// that is renderer.render, the GPU time (a timer query round render, where the browser
// offers one), draw calls and triangles. --profile adds the functions with the most
// self time (and writes the .cpuprofile to /tmp). --cpu 4 slows the CPU down 4× (a
// stand-in for a phone). Needs the dev server (npm run dev) and Playwright; it takes
// Playwright from PLAYWRIGHT_PATH or the usual places.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

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

const PLACES = {
  stand: { start: '14.4206,50.0873', drive: false },  // Old Town Square
  drive: { start: '14.4052,50.0808', drive: true },   // from Újezd (the game's start, with a car at the kerb), with lane assist
  woods: { start: '14.3965,50.0830', drive: false },  // Petřín: trees and slopes
  suburb: { start: '14.4760,50.0520', drive: false }, // Vršovice/Strašnice edge: gardens
  river: { start: '14.4125,50.0862', drive: false },  // by Charles Bridge: water, quays, the bridge
  tunnel: { start: '14.3905,50.0780', drive: false }, // over the Strahov tunnel (see --eval for getting into it)
  square: { start: '14.4185,50.0760', drive: false }, // Karlovo náměstí: main roads with buses
};

// In the page before anything else: time every animation-frame callback.
const INIT = () => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__bench = { frames: [], js: [], render: [], gpu: [], calls: [], tris: [], on: false };
  window.requestAnimationFrame = (cb) => raf((t) => {
    const t0 = performance.now();
    cb(t);
    const b = window.__bench;
    if (b.on) { b.frames.push(t); b.js.push(performance.now() - t0); }
  });
};

const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');

async function runScene(browser, name, base = URL_BASE) {
  const place = PLACES[name];
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  page.on('pageerror', (e) => console.error(`[${name}] page error:`, e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[${name}] console:`, m.text().slice(0, 3000)); });
  const q = `?start=${place.start}&dpr=${DPR}&graphics=${args.graphics || 'high'}&time=${args.time || '14:00'}&go&day=wed&weather=${args.weather || 'clear'}${args.extra || ''}`;
  // --profile-load: the CPU profile of loading, up to the game starting.
  const loadCdp = args['profile-load'] ? await ctx.newCDPSession(page) : null;
  if (loadCdp) { await loadCdp.send('Profiler.enable'); await loadCdp.send('Profiler.setSamplingInterval', { interval: 200 }); await loadCdp.send('Profiler.start'); }
  const loadStart = Date.now();
  await page.goto(base + q);
  // Loaded: the loading screen is gone and no tiles are being built.
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__drive, null, { timeout: 120000, polling: 100 });
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
    await page.screenshot({ path: String(args.shot).replace('%s', name) });
  }

  const cdp = CPU > 1 || args.profile ? await ctx.newCDPSession(page) : null;
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  if (args.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }

  await page.evaluate(() => {
    const d = window.__drive, b = window.__bench, r = d.renderer, gl = r.getContext();
    const ext = gl.getExtension ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null; // (none on WebGPU)
    const pending = [];
    const render = r.render.bind(r);
    r.render = (s, c) => {
      const t0 = performance.now();
      let q = null;
      if (ext && b.on) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      render(s, c);
      if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); }
      if (b.on) { b.render.push(performance.now() - t0); b.calls.push(r.info.render.calls); b.tris.push(r.info.render.triangles); }
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const p = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) b.gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(p);
      }
    };
    b.gpuAvailable = !!ext;
    b.on = true;
  });
  if (args.ab) return abScene(page, ctx, name);
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
  let profile = null;
  if (args.profile) {
    ({ profile } = await cdp.send('Profiler.stop'));
    writeFileSync(`/tmp/bench-${name}.cpuprofile`, JSON.stringify(profile));
  }
  await ctx.close();

  const dts = res.frames.slice(1).map((t, i) => t - res.frames[i]);
  return {
    name, fps: res.frames.length / wall, frameMed: pct(dts, 0.5), frame95: pct(dts, 0.95), frame99: pct(dts, 0.99),
    js: mean(res.js), js95: pct(res.js, 0.95), render: mean(res.render), gpu: res.gpu.length ? mean(res.gpu) : NaN, gpu95: pct(res.gpu, 0.95),
    calls: mean(res.calls), tris: mean(res.tris), people: res.people, traffic: res.traffic, loose: res.loose, tiles: res.tiles,
    ratio: res.ratio, tier: res.tier, speed: res.speed, profile, loadTime,
  };
}

// --ab "js": the code defines window.__ab(on), which switches a change on or off in
// the page. Off and on take turns in short windows (--window seconds, default 2) for
// --seconds in all, so a machine that gets busier or cooler meanwhile affects both alike.
async function abScene(page, ctx, name) {
  await page.evaluate(args.ab);
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
  await ctx.close();
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
const browser = await pw.chromium.launch({
  headless: true, channel: args.browser === 'chromium' ? undefined : 'chrome',
  args: [`--use-angle=${args.angle || 'metal'}`, '--enable-gpu', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--enable-unsafe-webgpu'],
});
const all = [];
try {
  if (args.vs) {
    // Against another server (a worktree of main, say): the two take turns, --runs
    // times each, and the means are compared.
    const res = { vs: {}, url: {} };
    for (let run = 0; run < RUNS; run++) for (const s of SCENES) for (const [k, base] of [['vs', args.vs], ['url', URL_BASE]]) {
      const r = await runScene(browser, s, base);
      delete r.profile;
      (res[k][s] ||= []).push(r);
      console.log(`${s.padEnd(7)} ${k === 'vs' ? 'before' : 'after '} ${f1(r.fps).padStart(6)} fps  ${f1(1000 / r.fps)} ms/frame  js ${f1(r.js)} ms  gpu ${f1(r.gpu)} ms  ${Math.round(r.calls)} calls  loaded in ${f1(r.loadTime)} s`);
    }
    for (const s of SCENES) {
      const ms = (rs) => mean(rs.map((r) => 1000 / r.fps)), a = ms(res.vs[s]), b = ms(res.url[s]);
      console.log(`${s.padEnd(7)} ${f1(a)} → ${f1(b)} ms a frame (${f1((a - b) / a * 100)}% quicker), js ${f1(mean(res.vs[s].map((r) => r.js)))} → ${f1(mean(res.url[s].map((r) => r.js)))} ms`);
    }
    process.exitCode = 0;
  }
  for (let run = 0; run < (args.vs ? 0 : RUNS); run++) for (const s of SCENES) {
    const r = await runScene(browser, s);
    all.push(r);
    if (r.ab) {
      const line = (k, x) => `${r.name.padEnd(7)} ${k.padEnd(4)} ${f1(x.fps).padStart(6)} fps  ${f1(x.ms)} ms/frame  js ${f1(x.js)} ms  gpu ${f1(x.gpu)} ms  [${x.each}]`;
      console.log(`${line('off', r.off)}\n${line('on', r.on)}\n${r.name.padEnd(7)} on is ${f1((r.off.ms - r.on.ms) / r.off.ms * 100)}% quicker a frame`);
      continue;
    }
    console.log(`${r.name.padEnd(7)} ${f1(r.fps).padStart(6)} fps  frame ${f1(r.frameMed)}/${f1(r.frame95)}/${f1(r.frame99)} ms  js ${f1(r.js)} (p95 ${f1(r.js95)}, render ${f1(r.render)}) ms  gpu ${f1(r.gpu)} (p95 ${f1(r.gpu95)}) ms  ${Math.round(r.calls)} calls ${(r.tris / 1e6).toFixed(2)}M tris  ${r.people} people ${r.traffic} traffic ${r.loose} loose ${r.tiles} tiles  ${r.ratio}× ${r.tier}${r.speed ? `  ${Math.round(r.speed)} km/h` : ''}  loaded in ${f1(r.loadTime)} s`);
    if (r.profile) { console.log(topSelf(r.profile).join('\n')); delete r.profile; }
  }
} finally {
  await browser.close();
}
if (args.json) writeFileSync(args.json, JSON.stringify(all, null, 2));
