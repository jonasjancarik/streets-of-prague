#!/usr/bin/env node
// The animation loop's physics dispatch while game time is paused (plan 036).
//   node scripts/check-paused-physics.mjs              the production dispatch block, offline
//   node scripts/check-paused-physics.mjs --baseline   the same, reporting what the code does now
//   node scripts/check-paused-physics.mjs --url http://localhost:5191/
//     the real loop and real modals in Chrome (scripts/bench.mjs: the game lock, one rendering game)
// Offline needs no browser, server or map data: it runs the block cut from src/main.ts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv[i + 1];
};
const baseline = process.argv.includes('--baseline');
const url = option('--url');

if (!url) {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  // From the elapsed-time multiplier to the stepping loop, exactly as main.ts has them.
  const block = main.match(/const run = testkit\?\.paused [^\n]*\n[\s\S]*?for \(let i = 0; i < steps; i\+\+\) simulate\([^\n]*\);/)?.[0];
  assert.ok(block, 'locate the animation loop physics dispatch in src/main.ts');
  assert.ok(block.split('\n').length <= 4, 'the dispatch block stays compact (run, steps, loop)');
  const dispatch = new Function('testkit', 'scale', 'metro', 'dt', 'simulate', 'ctl', `${block}\nreturn { run, steps };`);
  const go = ({ dt, scale = 1, speed, paused = false, metro = false }) => {
    const calls = [];
    const ctl = { move: 0 };
    const testkit = speed === undefined && !paused ? undefined : { paused, speed: speed ?? 1 };
    const { run, steps } = dispatch(testkit, scale, { active: metro }, dt, (d, c) => { assert.equal(c, ctl); calls.push(d); }, ctl);
    return { run, steps, calls, total: calls.reduce((a, b) => a + b, 0) };
  };
  // The contract for positive elapsed time, as the loop had it before plan 036.
  const expected = ({ dt, scale = 1, speed, paused = false, metro = false }) => {
    const run = paused ? 0 : scale * (speed ?? 1);
    const steps = metro ? 0 : Math.ceil(run - 1e-6);
    return { run, steps: Math.max(0, steps), step: steps > 0 ? (dt * run) / steps : 0 };
  };
  const cases = [];
  for (const dt of [0, 1 / 60, 1 / 144, 0.05]) {
    for (const scale of [1, 6, 12, 1.37]) cases.push({ dt, scale });
    for (const speed of [0.25, 0.5, 2.5]) cases.push({ dt, scale: 1, speed }, { dt, scale: 6, speed });
    cases.push({ dt, scale: 6, paused: true }, { dt, scale: 1, metro: true }, { dt, scale: 12, metro: true });
  }
  const label = (c) => `dt ${c.dt.toFixed(4)} scale ${c.scale}${c.speed !== undefined ? ` speed ${c.speed}` : ''}${c.paused ? ' dev-paused' : ''}${c.metro ? ' metro' : ''}`;
  let zeroTimeCalls = 0, zeroTimeCases = 0, positive = 0;
  const rows = [];
  for (const c of cases) {
    const got = go(c), want = expected(c);
    assert.equal(got.run, want.run, `${label(c)}: run multiplier unchanged`);
    if (c.metro) {
      // Underground the street waits, as before, with or without elapsed time.
      assert.equal(got.calls.length, 0, `${label(c)}: no street physics in the metro`);
      continue;
    }
    if (c.dt * want.run > 0) {
      // Positive elapsed time: the same steps, each as long, adding up to dt × run.
      positive++;
      assert.equal(got.steps, want.steps, `${label(c)}: step count`);
      assert.equal(got.calls.length, want.steps, `${label(c)}: simulate calls`);
      for (const d of got.calls) assert.equal(d, want.step, `${label(c)}: per-step dt`);
      assert.ok(Math.abs(got.total - c.dt * want.run) < 1e-12, `${label(c)}: total ${got.total} = dt × run ${c.dt * want.run}`);
      continue;
    }
    // No elapsed time (paused by a modal, the developer pause, or underground).
    for (const d of got.calls) assert.equal(d, 0, `${label(c)}: a zero-time call carries no time`);
    if (got.calls.length) { zeroTimeCases++; zeroTimeCalls += got.calls.length; rows.push(`  ${label(c)}: ${got.calls.length} simulate(0) call${got.calls.length === 1 ? '' : 's'}`); }
    if (baseline) {
      // Before plan 036: dt 0 still dispatched one zero-time step per unit of the multiplier.
      assert.equal(got.calls.length, c.dt === 0 ? want.steps : 0, `${label(c)}: baseline zero-time calls`);
    } else {
      assert.equal(got.steps + 0, 0, `${label(c)}: no physics steps without elapsed time`);
      assert.equal(got.calls.length, 0, `${label(c)}: no simulate calls without elapsed time`);
    }
  }
  const mode = baseline ? 'baseline' : 'candidate';
  console.log(`Paused physics (${mode}, offline): ${cases.length} cases from the production dispatch block; ${positive} positive-time cases keep their step count, per-step dt and total dt × run.`);
  console.log(`  zero-time simulate calls: ${zeroTimeCalls} across ${zeroTimeCases} case${zeroTimeCases === 1 ? '' : 's'}`);
  for (const r of rows) console.log(r);
  if (baseline && zeroTimeCalls === 0) {
    console.log('  (no zero-time calls: the dispatch already skips paused physics)');
  }
  process.exit(0);
}

// ---- Browser mode: the real animation loop and the real modal panels ----------------
// Runs inside the page after loading (scripts/bench.mjs --eval). Counts the physics
// work by wrapping traffic/crowd/tram updates, the loop's progress by wrapping
// renderer.render, and restores both whatever happens.
const checks = `(async () => {
  const d = window.__drive, tk = window.__test;
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const report = [];
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const counts = { traffic: 0, crowd: 0, trams: 0, renders: 0, physicsMs: 0, renderMs: 0, pictures: 0 };
  const restore = [];
  const wrap = (obj, key, name, timed) => {
    const original = obj[key];
    obj[key] = function (...args) {
      counts[name]++;
      const t0 = performance.now();
      try { return original.apply(this, args); } finally { counts[timed] += performance.now() - t0; }
    };
    restore.push(() => { obj[key] = original; });
  };
  wrap(d.traffic, 'update', 'traffic', 'physicsMs');
  wrap(d.crowd, 'update', 'crowd', 'physicsMs');
  wrap(d.trams, 'update', 'trams', 'physicsMs');
  wrap(d.renderer, 'render', 'renders', 'renderMs');
  // The feedback form's picture: main.ts copies the frame into a canvas and encodes it.
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (type, ...rest) { if (type === 'image/jpeg') counts.pictures++; return toDataURL.call(this, type, ...rest); };
  restore.push(() => { HTMLCanvasElement.prototype.toDataURL = toDataURL; });
  const longTasks = [];
  const observer = 'PerformanceObserver' in window && PerformanceObserver.supportedEntryTypes?.includes('longtask') ? new PerformanceObserver((list) => longTasks.push(...list.getEntries().map((e) => e.duration))) : null;
  observer?.observe({ type: 'longtask', buffered: false });
  restore.push(() => observer?.disconnect());
  const opened = [];
  const openDialogs = () => [...document.querySelectorAll('dialog')].filter((x) => x.open);
  const owned = (dialog) => { if (dialog && !opened.includes(dialog)) opened.push(dialog); return dialog; };
  const snapshot = () => ({ t: d.clock.t, cars: d.traffic.agents.slice(0, 20).map((a) => [a.car, a.car.x, a.car.y]), people: d.crowd.people.slice(0, 20).map((p) => [p, p.x, p.y]) });
  const still = (a, b) => a.t === b.t && a.cars.every(([c, x, y]) => c.x === x && c.y === y) && a.people.every(([p, x, y]) => p.x === x && p.y === y);
  const paused = () => !!openDialogs().length;
  // A fixed number of rendered frames, with the work done meanwhile.
  const run = async (n, label) => {
    const before = { ...counts }, gaps = [], start = performance.now(), firstLong = longTasks.length;
    let prev = start;
    for (let i = 0; i < n; i++) { const now = await frame(); gaps.push(now - prev); prev = now; }
    const delta = Object.fromEntries(Object.keys(counts).map((k) => [k, counts[k] - before[k]]));
    const sorted = gaps.slice(1).sort((a, b) => a - b), q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const out = { label, frames: n, seconds: (performance.now() - start) / 1000, ...delta, meanMs: mean, p95: q(0.95), p99: q(0.99), longTasks: longTasks.length - firstLong, physicsPerFrame: delta.physicsMs / n, renderPerFrame: delta.renderMs / n };
    report.push(label + ': ' + n + ' frames, renders ' + delta.renders + ', traffic/crowd/trams ' + delta.traffic + '/' + delta.crowd + '/' + delta.trams + ', physics ' + out.physicsPerFrame.toFixed(3) + ' ms/frame, render ' + out.renderPerFrame.toFixed(3) + ' ms/frame, frame mean ' + mean.toFixed(2) + ' p95 ' + out.p95.toFixed(2) + ' p99 ' + out.p99.toFixed(2) + ' ms, long tasks ' + out.longTasks);
    return out;
  };
  // While a modal is open: frames keep coming, physics stays at zero and nothing moves.
  const holdsStill = async (label, n = 75) => {
    assert(paused(), label + ': a modal is open');
    const s = snapshot(), r = await run(n, label + ' (paused)');
    assert(r.renders >= 60, label + ': the loop kept rendering (' + r.renders + ')');
    assert(r.traffic === 0 && r.crowd === 0 && r.trams === 0, label + ': no physics while paused (' + r.traffic + '/' + r.crowd + '/' + r.trams + ')');
    assert(still(s, snapshot()), label + ': clock, traffic and people stayed where they were');
    return r;
  };
  const key = (type, code, target = window, extra = {}) => target.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...extra }));
  const settingsBox = () => document.querySelector('dialog.settings:not(.news)');
  const openSettings = () => { key('keydown', 'Escape'); return owned(settingsBox()); };
  const close = (dialog) => { if (dialog?.open) dialog.close(); };
  const sheets = () => [...document.querySelectorAll('dialog.settings.news')];

  const save = { speed: tk?.speed, weather: d.weather.kind, fixed: d.weather.fixed, graphics: d.graphics.choice };
  try {
    assert(!paused(), 'start with no modal open');
    // Normal play: the reference window, and the clock's rate per frame second.
    const t0 = d.clock.t, normal = await run(90, 'playing');
    assert(normal.traffic >= 90 && normal.crowd >= 90, 'normal play steps physics every frame (' + normal.traffic + '/' + normal.crowd + ')');
    const rate = (d.clock.t - t0) / normal.seconds;

    // Settings (opened with Escape, the way a player opens it).
    const settings = openSettings();
    assert(settings?.open, 'Escape opened the settings');
    const pausedWindow = await holdsStill('settings', 90);
    // Graphics and weather choices still work behind the pause.
    const chipsOf = (label) => [...settings.querySelectorAll('.settings-row')].find((r) => r.querySelector('.settings-label')?.textContent === label)?.querySelectorAll('.settings-chip');
    const pick = (label, changed) => {
      const chips = [...(chipsOf(label) ?? [])];
      assert(chips.length > 1, label + ' chips present');
      const was = chips.find((c) => c.getAttribute('aria-pressed') === 'true'), other = chips.find((c) => c !== was);
      other.click();
      assert(changed(), label + ' choice took effect while paused');
      return was;
    };
    const graphicsWas = pick('Graphics', () => d.graphics.choice !== save.graphics);
    const weatherWas = pick('Weather', () => d.weather.kind !== save.weather || d.weather.fixed !== save.fixed);
    await holdsStill('settings after graphics/weather choice', 60);
    graphicsWas?.click(); weatherWas?.click();
    // The explicit simulation entry point is a separate caller and still steps.
    const tBefore = counts.traffic;
    d.simulate(0); d.simulate(1 / 60);
    assert(counts.traffic === tBefore + 2, 'window.__drive.simulate still steps when called explicitly');
    close(settings);

    // No catch-up: the paused seconds are not replayed once the game runs again.
    const tResume = d.clock.t, firstAfter = await run(1, 'first frame after settings');
    const firstStep = d.clock.t - tResume;
    assert(firstStep <= rate * 0.05 * 1.05 + 1e-9, 'resume: first frame advanced ' + firstStep + ' clock units, at most one capped frame (' + (rate * 0.05) + ')');
    const t1 = d.clock.t, resumed = await run(60, 'resumed');
    const resumedRate = (d.clock.t - t1) / resumed.seconds;
    assert(resumed.traffic >= 60, 'resume: physics steps again');
    assert(Math.abs(resumedRate - rate) <= Math.max(0.25 * rate, 1e-9), 'resume: the clock runs at its normal rate (' + resumedRate + ' vs ' + rate + ')');

    // Desktop credits, then settings-to-credits handoff.
    document.getElementById('credits')?.click();
    owned(document.getElementById('credits-box'));
    await holdsStill('credits', 60);
    close(document.getElementById('credits-box'));
    const s2 = openSettings();
    s2.querySelector('.settings-credits')?.click();
    assert(!s2.open && document.getElementById('credits-box').open, 'settings handed over to credits');
    await holdsStill('settings → credits', 60);
    close(document.getElementById('credits-box'));

    // Settings → feedback (with its requested picture), and settings → newsletter → privacy.
    const linkIn = (box, text) => [...box.querySelectorAll('button.settings-news')].find((b) => b.textContent === text);
    const s3 = openSettings();
    const feedback = linkIn(s3, 'Send feedback');
    if (feedback) {
      const pictures = counts.pictures;
      feedback.click();
      const form = owned(sheets().find((x) => x.open));
      assert(form && !s3.open, 'settings handed over to feedback');
      await holdsStill('settings → feedback', 60);
      assert(counts.pictures > pictures, 'the feedback form got its picture of the game while paused');
      close(form);
    } else { close(s3); report.push('feedback: not configured on this server (no VITE_FEEDBACK_URL), skipped'); }
    const s4 = openSettings();
    const news = linkIn(s4, 'Get news about the game by email');
    if (news) {
      news.click();
      const box = owned(sheets().find((x) => x.open));
      assert(box && !s4.open, 'settings handed over to the newsletter');
      await holdsStill('settings → newsletter', 60);
      box.querySelector('.news-privacy')?.click();
      assert(document.getElementById('credits-box').open, 'privacy stacked over the newsletter');
      await holdsStill('newsletter + privacy', 60);
      close(document.getElementById('credits-box'));
      assert(box.open, 'the newsletter is still open under privacy');
      await holdsStill('newsletter after privacy', 60);
      close(box);
    } else { close(s4); report.push('newsletter: not configured on this server (no VITE_SUBSCRIBE_URL), skipped'); }
    assert(!paused(), 'every test dialog closed');
    const after = await run(30, 'resumed after modals');
    assert(after.traffic >= 30, 'physics resumes after the modal sequence');

    // Accelerated world (the developer speed standing in for a ride's speed-up, which
    // feeds the same multiplier): entering a modal pauses it too, and it resumes accelerated.
    if (tk) {
      tk.speed = 6;
      const fast = await run(30, 'accelerated ×6');
      assert(fast.traffic >= 6 * 30, 'accelerated: six steps a frame (' + fast.traffic + ')');
      const s5 = openSettings();
      await holdsStill('accelerated → settings', 60);
      close(s5);
      const fastAgain = await run(30, 'accelerated after settings');
      assert(fastAgain.traffic >= 6 * 30, 'accelerated again after resuming');
      tk.speed = save.speed ?? 1;
    }

    // Keys released inside a modal: holding W walks, releasing it in the settings stops.
    if (!d.car && !d.heli) {
      const w = d.walker, x0 = w.x, y0 = w.y;
      key('keydown', 'KeyW');
      await run(200, 'walking with W held');
      const walked = Math.hypot(w.x - x0, w.y - y0);
      const s6 = openSettings();
      key('keyup', 'KeyW', s6);
      key('keyup', 'ShiftLeft', s6);
      key('keyup', 'KeyQ', s6);
      key('keyup', 'KeyF', s6);
      await holdsStill('keys released in settings', 60);
      close(s6);
      await run(10, 'settling after release');
      const x1 = w.x, y1 = w.y;
      await run(30, 'after release');
      assert(walked > 0.2, 'W walked before the modal (' + walked.toFixed(2) + ' m)');
      assert(Math.hypot(w.x - x1, w.y - y1) < 0.05, 'W released inside the modal stays released');
    } else report.push('key release: not on foot, skipped');

    report.push('paused vs playing: physics ' + pausedWindow.physicsPerFrame.toFixed(3) + ' vs ' + normal.physicsPerFrame.toFixed(3) + ' ms/frame; frame mean ' + pausedWindow.meanMs.toFixed(2) + ' vs ' + normal.meanMs.toFixed(2) + ' ms');
    report.push('clock rate ' + rate.toFixed(4) + '/s, resumed ' + resumedRate.toFixed(4) + '/s, first frame after resume ' + firstStep.toFixed(5));
  } finally {
    for (const x of opened.reverse()) close(x);
    for (const f of restore.reverse()) f();
    if (tk) tk.speed = save.speed ?? 1;
  }
  return report.join('\\n');
})()`;

const args = ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1', '--graphics', 'high', '--time', '14:00', '--weather', 'clear', '--fresh-browser', '--extra', '&lang=en', '--eval', checks, '--stack'];
const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
