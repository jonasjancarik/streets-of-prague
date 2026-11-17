#!/usr/bin/env node
// Runs scripts/tin-bench.html (the time to make each tile's ground from its mesh file) in
// headless Chrome here, or with --android [serial] in Chrome on a phone over adb (as
// bench.mjs does: the dev server's port passed through, DevTools on a local port).
//
//   node scripts/tin-bench.mjs [--url http://localhost:5204/] [--map ujezd-lidar] [--runs 3] [--android 09081FDD4001DA]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const base = new URL(args.url || 'http://localhost:5191/');
const page = new URL(`scripts/tin-bench.html?map=${args.map || 'ujezd-lidar'}&runs=${args.runs || 3}`, base).href;
const require = createRequire(import.meta.url);
const tryReq = (p) => { try { return require(p); } catch { return null; } };
const pw = tryReq(process.env.PLAYWRIGHT_PATH || 'playwright') || tryReq(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
if (!pw) { console.error('Playwright not found; set PLAYWRIGHT_PATH'); process.exit(1); }

let browser, cleanUp = () => {};
if (args.android) {
  const serial = typeof args.android === 'string' ? args.android : process.env.ANDROID_SERIAL;
  const run = (...a) => execFileSync('adb', serial ? ['-s', serial, ...a] : a, { encoding: 'utf8' }).trim();
  const devtools = String(args['android-port'] || 9333);
  run('reverse', `tcp:${base.port}`, `tcp:${base.port}`);
  run('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  run('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'about:blank', 'com.android.chrome');
  run('forward', `tcp:${devtools}`, 'localabstract:chrome_devtools_remote');
  console.log(`On ${run('shell', 'getprop', 'ro.product.model')} (${serial ?? 'the one attached'})`);
  cleanUp = () => { try { run('reverse', '--remove', `tcp:${base.port}`); } catch {} try { run('forward', '--remove', `tcp:${devtools}`); } catch {} };
  await new Promise((r) => setTimeout(r, 1500));
  browser = await pw.chromium.connectOverCDP(`http://localhost:${devtools}`);
} else {
  browser = await pw.chromium.launch({ headless: true, channel: 'chrome' });
}
try {
  const context = browser.contexts()[0] ?? await browser.newContext();
  const tab = await context.newPage();
  await tab.goto(page);
  await tab.waitForFunction(() => window.__result, null, { timeout: 180000 });
  const result = await tab.evaluate(() => window.__result);
  await tab.close();
  const { rows, ...summary } = result;
  console.log(JSON.stringify(summary, null, 1));
  if (args.rows) for (const r of rows) console.log(JSON.stringify(r));
} finally {
  if (!args.android) await browser.close();
  cleanUp();
}
