#!/usr/bin/env node
// Select weather through the real developer controls while the world is paused.
import { spawnSync } from 'node:child_process';
const index = process.argv.indexOf('--url');
const url = index < 0 ? 'http://localhost:5191/' : process.argv[index + 1];
const check = `(async () => {
  const weather = window.__drive.weather, kit = window.__test;
  const select = document.querySelector('#dev-weather');
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  assert(select, 'The developer weather control is missing');
  const expected = {
    clear: [0, 0, 0, 0, 0, 0, 0],
    cloudy: [0.55, 0, 0, 0, 0, 0, 0],
    rain: [1, 1, 0, 0, 0.12, 1, 0],
    storm: [1, 1, 1, 0, 0.2, 1, 0],
    mist: [0.6, 0, 0, 0, 1, 0, 0],
    snow: [0.95, 0, 0, 1, 0.15, 0, 1],
  };
  const fields = ['cloud', 'rain', 'storm', 'snow', 'mist', 'wet', 'cover'];
  const choose = kind => { select.value = kind; select.dispatchEvent(new Event('change', { bubbles: true })); };
  const paused = kit.paused;
  kit.paused = true;
  try {
    // Keep Mist's tuning section open while switching to other weather.
    choose('clear');
    document.querySelector('#dev-mist summary').click();
    assert(weather.kind === 'mist' && weather.now.mist === 1, 'Opening Mist did not preview it immediately');
    for (const kind of ['clear', 'rain', 'snow', 'mist', 'storm', 'cloudy', 'clear']) {
      choose(kind);
      assert(weather.fixed && weather.kind === kind, kind + ': selected weather was not applied');
      for (const [i, field] of fields.entries()) assert(Math.abs(weather.now[field] - expected[kind][i]) < 0.000001,
        kind + ': ' + field + ' has not changed immediately: ' + weather.now[field]);
      await new Promise(resolve => requestAnimationFrame(resolve));
      assert(weather.kind === kind, kind + ': the open Mist controls overrode the choice');
    }
    const conditions = JSON.stringify(weather.now);
    choose('auto');
    assert(!weather.fixed, 'Changing by itself did not resume automatic weather');
    assert(JSON.stringify(weather.now) === conditions, 'Automatic weather unexpectedly reset current conditions');
    choose('clear');
    return 'Developer weather checks passed: all six kinds, wet/snow cover, paused simulation, open Mist controls and automatic weather';
  } finally { kit.paused = paused; }
})()`;
const run = spawnSync(process.execPath, ['scripts/bench.mjs', '--url', url, '--scenes', 'stand', '--seconds', '1', '--dpr', '1',
  '--weather', 'mist', '--time', '14:00', '--graphics', 'high', '--extra', '&dev', '--eval', check,
  '--shot', '/tmp/dev-weather-clear.png', '--fresh-browser', '--loading-frames'], { encoding: 'utf8' });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.status !== 0 || /console:|page error:/.test(run.stderr || '')) process.exit(run.status || 1);
