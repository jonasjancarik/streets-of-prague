#!/usr/bin/env node
// Browser check against an isolated staged area. Source public/data is read only.
// node scripts/check-landmark-colours.mjs --url http://localhost:5240/ \
//   --fixtures /tmp/sop-landmark-colours-010/centrum_now --area centrum
import { createRequire } from 'node:module';
import { checkIn } from './game-lock.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((all, item, index, list) => {
  if (item.startsWith('--')) all.push([item.slice(2), list[index + 1] && !list[index + 1].startsWith('--') ? list[index + 1] : true]);
  return all;
}, []));
const url = String(args.url || 'http://localhost:5240/');
const fixtures = String(args.fixtures || '');
const area = String(args.area || 'centrum');
const variant = args.legacy ? 'legacy' : 'staged';
const time = String(args.time || '14:00');
if (!fixtures) throw new Error('--fixtures must name a staged area directory');
if (!['14:00', '22:00'].includes(time)) throw new Error('--time must be 14:00 or 22:00');
const manifest = JSON.parse(readFileSync(join(fixtures, 'landmarks.json'), 'utf8'));
const chosen = manifest.find((item) => item.name === (args.name || (area === 'praha' ? 'okamura' : 'manes')));
if (!chosen) throw new Error('requested landmark is missing from staged manifest');
const originalPath = join('public/data', `${area}_now`, chosen.file.replace('.warm-v1.glb', '.glb'));
const original = readFileSync(originalPath);
const converted = readFileSync(join(fixtures, chosen.file));
const originalDoc = JSON.parse(original.subarray(20, 20 + original.readUInt32LE(12)).toString('utf8'));
const expectedLegacyPasses = originalDoc.images.length;

function editGlb(raw, edit) {
  const jsonLength = raw.readUInt32LE(12);
  const doc = JSON.parse(raw.subarray(20, 20 + jsonLength).toString('utf8'));
  edit(doc);
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binHeader = 20 + jsonLength;
  const bin = raw.subarray(binHeader + 8, binHeader + 8 + raw.readUInt32LE(binHeader));
  const out = Buffer.alloc(28 + padded.length + bin.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(out, 28 + padded.length);
  return out;
}
const shared = editGlb(original, (doc) => {
  const index = doc.nodes.length;
  doc.nodes.push({ ...doc.nodes[doc.scenes[doc.scene || 0].nodes[0]] });
  doc.scenes[doc.scene || 0].nodes.push(index);
});
const unknown = editGlb(converted, (doc) => {
  doc.scenes[doc.scene || 0].extras.landmarkColourVersion = 999;
});
const synthetic = { 'legacy.glb': original, 'warm.glb': converted, 'shared.glb': shared, 'unknown.glb': unknown };

const require = createRequire(import.meta.url);
const tryReq = (path) => { try { return require(path); } catch { return null; } };
const pw = tryReq(process.env.PLAYWRIGHT_PATH || 'playwright') || tryReq(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
if (!pw) throw new Error('Playwright not found; set PLAYWRIGHT_PATH');
await (await checkIn('game')).take(); // not while another session benchmarks
const browser = await pw.chromium.launch({ headless: true, channel: 'chrome',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const results = [];
try {
  for (const renderer of ['webgpu', 'webgl']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/__landmark-test__/*.glb', (route) => {
      const file = new URL(route.request().url()).pathname.split('/').at(-1);
      return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: synthetic[file] });
    });
    if (variant === 'staged') {
      await page.route(`**/data/${area}_now/landmarks.json`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
      await page.route(`**/data/${area}_now/landmarks/*.warm-v1.glb`, (route) => {
        const file = new URL(route.request().url()).pathname.split('/').at(-1);
        return route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: readFileSync(join(fixtures, 'landmarks', file)) });
      });
    }
    const gameUrl = new URL(url);
    gameUrl.search = `?place=14.416,50.082&go&day=wed&time=${time}&weather=clear&graphics=high&dpr=1&area=${area}&renderer=${renderer}`;
    await page.goto(gameUrl.href);
    await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done') && window.__drive, null, { timeout: 180000, polling: 200 });
    await page.waitForFunction((value) => value === '22:00' ? window.__drive.sky.dark > 0.9 : window.__drive.sky.dark < 0.1, time, { timeout: 10000 });
    const actualRenderer = await page.evaluate(() => window.__drive.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl');
    if (actualRenderer !== renderer) throw new Error(`requested ${renderer} but got ${actualRenderer}`);
    const runDirect = () => page.evaluate(async (expectedLegacyPasses) => {
      const { landmarkModel } = await import('/src/tiles.ts');
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const original = CanvasRenderingContext2D.prototype.putImageData;
      let pixelPasses = 0;
      CanvasRenderingContext2D.prototype.putImageData = function (...args) { pixelPasses++; return original.apply(this, args); };
      const check = async (file, count, canvas, marker) => {
        pixelPasses = 0;
        const model = await landmarkModel(`/__landmark-test__/${file}.glb`);
        const maps = new Set();
        model.traverse((object) => { if (object.isMesh && object.material.map) maps.add(object.material.map); });
        assert(maps.size > 0, `${file}: no texture maps`);
        assert(pixelPasses === count, `${file}: ${pixelPasses} pixel passes, expected ${count}`);
        assert([...maps].every((map) => (map.image instanceof HTMLCanvasElement) === canvas), `${file}: wrong image type`);
        assert(model.userData.landmarkColourVersion === marker, `${file}: scene marker not propagated`);
        return { file, pixelPasses, maps: maps.size, marker: marker ?? null };
      };
      try {
        const warm = await check('warm', 0, false, 1);
        const legacy = await check('legacy', expectedLegacyPasses, true, undefined);
        const shared = await check('shared', expectedLegacyPasses, true, undefined);
        let rejected = false;
        try { await landmarkModel('/__landmark-test__/unknown.glb'); }
        catch (error) { rejected = /Unsupported landmark colour version 999/.test(String(error)); }
        assert(rejected, 'unknown marker was not rejected');
        return [warm, legacy, shared, { file: 'unknown', rejected }];
      } finally {
        CanvasRenderingContext2D.prototype.putImageData = original;
      }
    }, expectedLegacyPasses);
    const target = chosen.polygons[0][0];
    const x = target.reduce((sum, point) => sum + point[0], 0) / target.length;
    const y = target.reduce((sum, point) => sum + point[1], 0) / target.length;
    const cold = await page.evaluate(async ({ name, x, y, variant }) => {
      const world = window.__drive.world;
      if (world.landmarkModels.has(name)) throw new Error(`${name} loaded before cold transition`);
      const original = CanvasRenderingContext2D.prototype.putImageData;
      let pixelPasses = 0;
      CanvasRenderingContext2D.prototype.putImageData = function (...args) { pixelPasses++; return original.apply(this, args); };
      const start = performance.now();
      try { await window.__drive.teleportTo(x, y); }
      finally { CanvasRenderingContext2D.prototype.putImageData = original; }
      const elapsedMs = performance.now() - start;
      const model = await world.landmarkModels.get(name);
      const expectedMarker = variant === 'staged' ? 1 : undefined;
      if (!model || model.userData.landmarkColourVersion !== expectedMarker) throw new Error(`${variant} landmark has the wrong marker`);
      let images = 0, canvases = 0;
      model.traverse((object) => {
        if (object.isMesh && object.material.map) {
          images++;
          if (object.material.map.image instanceof HTMLCanvasElement) canvases++;
        }
      });
      if (!images || (variant === 'staged' ? canvases !== 0 : canvases !== images)) {
        throw new Error(`${variant} first load: ${images} maps, ${canvases} canvases`);
      }
      if (variant === 'staged' ? pixelPasses !== 0 : pixelPasses < 1) {
        throw new Error(`${variant} first load: ${pixelPasses} pixel passes`);
      }
      return { elapsedMs, images, canvases, pixelPasses };
    }, { name: chosen.name, x, y, variant });
    const direct = await runDirect();
    if (errors.length) throw new Error(`${renderer} page errors: ${errors.join(' | ')}`);
    const shots = [];
    if (args.shot) {
      if (args.tilt) {
        await page.evaluate(async ({ x, y, tilt, height, heading }) => {
          const [lon, lat] = window.__drive.dev.toLonLat(x, y);
          await window.__test.camera({ at: [lat, lon], tilt, height, heading });
        }, { x, y, tilt: Number(args.tilt), height: Number(args.height || 80), heading: Number(args.heading || 135) });
      }
      await page.keyboard.press('KeyH');
      await page.waitForTimeout(2000); // Let the scene settle before comparing images.
      const shot = String(args.shot).replace('%s', renderer).replace('%t', time.replace(':', '')).replace('%v', variant);
      await page.screenshot({ path: shot });
      shots.push(shot);
    }
    results.push({ renderer, variant, direct, cold, screenshots: shots });
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ area, landmark: chosen.name, variant, time, results }, null, 2));
if (args.json) writeFileSync(String(args.json), JSON.stringify({ area, landmark: chosen.name, variant, time, results }, null, 2));
