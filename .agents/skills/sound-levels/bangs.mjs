#!/usr/bin/env node
// How loud the code-made one-off sounds are: the crashes (src/crashsound.ts at the levels
// crashMix in src/soundmix.ts gives them) and, to compare, a gunshot, a car blowing up
// and a door shutting (Sound.shot, boom, doorShut in src/audio.ts). Each is rendered with
// an OfflineAudioContext in headless Chrome on the dev server's origin (the game itself
// isn't loaded, so it takes seconds) and measured as heard (ITU BS.1770: K-weighted, the
// loudest 400 ms, "momentary") with its peak. Right by it, before the mixer and the
// master's compressor.
//
//   node .claude/skills/sound-levels/bangs.mjs [--kinds car,wall,post] [--kmh 5,10,30,55]
//     [--url http://localhost:5191/] [--wav <dir>] [--noclips]
//   --wav: also write each as a WAV to play; --noclips: without the recordings (what's
//   heard before they've loaded).
//
// For scale: your engine with the pedal down measures about -38 LUFS (see ROTORS in
// src/soundmix.ts), a door shut -29, a gunshot -21, a car blowing up -12.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const req = createRequire(new URL('../../../package.json', import.meta.url).pathname);
const tryReq = (p) => { try { return req(p); } catch { return null; } };
const pw = tryReq(process.env.PLAYWRIGHT_PATH || 'playwright') || tryReq(`${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`);
if (!pw) throw new Error('Playwright not found; set PLAYWRIGHT_PATH');

const kinds = String(args.kinds || 'car,wall,post,fence,hedge,rail,tram,person').split(',');
const kmh = String(args.kmh || '5,10,20,30,40,55').split(',').map(Number);
const cases = [];
for (const k of kinds) for (const v of kmh) cases.push([`${k} ${v} km/h`, v / 3.6, k, 1400, 0]);
cases.push(['car 40 km/h, a bus', 40 / 3.6, 'car', 12000, 0], ['car 40 km/h, a bicycle', 40 / 3.6, 'car', 90, 0]);
for (const d of [10, 30, 60, 120]) cases.push([`car 40 km/h, ${d} m off`, 40 / 3.6, 'car', 1400, d]);
const refs = [['gunshot', 'shot', [0, 0]], ['car blowing up', 'boom', [0, 0]], ['door shutting', 'doorShut', [0, 0]]];

const browser = await pw.chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.goto(new URL('src/soundmix.ts', args.url || 'http://localhost:5191/').href, { timeout: 30000 });
  const res = await page.evaluate(async ({ cases, refs, wav, noclips }) => {
    const { playCrash, CRASH_CLIPS } = await import('/src/crashsound.ts');
    // The recordings, decoded once at the rendering rate (noclips: the made-up sound alone).
    const clips = {};
    if (!noclips) {
      const dec = new OfflineAudioContext(1, 1, 48000);
      for (const name of Object.keys(CRASH_CLIPS)) clips[name] = await dec.decodeAudioData(await (await fetch(`/audio/${name}.m4a`)).arrayBuffer());
    }
    const { crashMix, crashFalloff } = await import('/src/soundmix.ts');
    const { Sound } = await import('/src/audio.ts');
    const SR = 48000, LEN = 2;
    const measure = (buf) => {
      const d = buf.getChannelData(0), n = d.length, a = new Float32Array(n), k = new Float32Array(n);
      const biquad = (x, y, b, f) => { let x1 = 0, x2 = 0, y1 = 0, y2 = 0; for (let i = 0; i < n; i++) { const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - f[1] * y1 - f[2] * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; } };
      biquad(d, a, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]);
      biquad(a, k, [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
      let peak = 0, most = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
      const w = SR * 0.4;
      for (let s = 0; s + w <= n; s += SR * 0.05) { let e = 0; for (let i = s; i < s + w; i++) e += k[i] * k[i]; most = Math.max(most, e / w); }
      let pcm = null;
      if (wav) {
        const b = new Uint8Array(Int16Array.from(d, (v) => Math.max(-32767, Math.min(32767, v * 32767))).buffer);
        let str = '';
        for (let i = 0; i < b.length; i += 8192) str += String.fromCharCode(...b.subarray(i, i + 8192));
        pcm = btoa(str);
      }
      return { m: most > 0 ? -0.691 + 10 * Math.log10(most) : -Infinity, peak: peak > 0 ? 20 * Math.log10(peak) : -Infinity, pcm };
    };
    const noiseOf = (ctx) => {
      const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return b;
    };
    const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647); // the same grains each run
    const out = [];
    for (const [name, speed, kind, mass, d] of cases) {
      const ctx = new OfflineAudioContext(1, SR * LEN, SR);
      playCrash(ctx, ctx.destination, noiseOf(ctx), crashMix(speed, kind, mass), d ? crashFalloff(d) : 1, 12000 - Math.min(d, 150) * 60, 0.05, seeded(7), clips);
      out.push([name, measure(await ctx.startRendering())]);
    }
    // Sound's own methods, with the offline context standing in for the live one.
    for (const [name, fn, a] of refs) {
      const ctx = new OfflineAudioContext(1, SR * LEN, SR);
      const live = new Proxy(ctx, { get: (t, k) => k === 'state' ? 'running' : k === 'currentTime' ? 0.05 : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
      Sound.prototype[fn].call({ ctx: live, on: true, noise: noiseOf(ctx), right: null, buses: { bangs: ctx.destination } }, ...a);
      out.push([`(${name})`, measure(await ctx.startRendering())]);
    }
    return out;
  }, { cases, refs, wav: !!args.wav, noclips: !!args.noclips });
  console.log(`${'sound'.padEnd(28)} LUFS (M max)   peak dBFS`);
  for (const [name, { m, peak }] of res) console.log(name.padEnd(28), m.toFixed(1).padStart(12), peak.toFixed(1).padStart(11));
  if (args.wav) {
    mkdirSync(args.wav, { recursive: true });
    for (const [name, { pcm }] of res) {
      const data = Buffer.from(pcm, 'base64'), h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
      h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(96000, 28);
      h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
      writeFileSync(`${args.wav}/${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.wav`, Buffer.concat([h, data]));
    }
    console.log(`WAVs in ${args.wav}`);
  }
} finally {
  await browser.close();
}
