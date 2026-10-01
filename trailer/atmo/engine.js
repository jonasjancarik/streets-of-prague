// Renders the car's engine for the whole of the trailer's engine time, offline, with the
// game's own engine sound (src/audio.ts, the SPORTY voice), following timeline.json's
// speed. Returns the samples (16-bit, base64) and the revs and gear at every frame.
const A = await import('/src/audio.ts');
const SR = 48000, FPS = TL.fps, n = TL.engineFrames, seconds = n / FPS + 0.5;
const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
const car = { forwardSpeed: 0, spec: { vmax: 50 } };
const spec = { idle: 950, redline: 7400, cylinders: 8, gears: [0.17, 0.3, 0.45, 0.62, 0.8, 1.02], rough: 0.02, voice: A.SPORTY };
const out = ctx.createGain(); out.gain.value = 1.6; out.connect(ctx.destination);
const engine = new A.Engine(ctx, A.noiseBuffer(ctx), out, car, spec);
const revs = [], gears = [];
const STEP = 1 / 60;
for (let k = 0; k * STEP < seconds; k++) {
  ctx.suspend(k * STEP).then(() => {
    const f = Math.min(n, (k * STEP) * FPS), i = Math.floor(f), u = f - i;
    car.forwardSpeed = TL.speed[i] + ((TL.speed[Math.min(n, i + 1)] ?? TL.speed[i]) - TL.speed[i]) * u;
    engine.update(STEP, 1);
    if (k % 2 === 0) { revs.push(Math.round(engine.rpm)); gears.push(engine.gear + 1); }
    ctx.resume();
  });
}
const buf = await ctx.startRendering(), data = buf.getChannelData(0);
let peak = 0; for (const v of data) peak = Math.max(peak, Math.abs(v));
const pcm = new Int16Array(data.length);
for (let i = 0; i < data.length; i++) pcm[i] = Math.max(-1, Math.min(1, data[i] / Math.max(peak, 1e-6) * 0.95)) * 32767;
let bin = ''; const bytes = new Uint8Array(pcm.buffer);
for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
return { sr: SR, peak, revs, gears, redline: spec.redline, pcm: btoa(bin) };
