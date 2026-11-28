// A crash: a recorded hit (real cars crashing, metal, a body; cut by
// pipeline/build_audio.py, sources in public/audio/SOURCES.md) picked by what was hit
// and how hard, and over it, made with the Web Audio API, glass pieces falling, leaves,
// a pole ringing. Until the recordings are in, the blow and the crumpling are made
// from noise and oscillators too. The levels come from crashMix in src/soundmix.ts.
// Sound.crash (src/audio.ts) plays it in the game; it takes any audio context, so it
// can also be rendered offline to be measured.

import type { CrashMix, CrashKind } from './soundmix.ts';

// The recordings and how much each is turned up or down to match the others, measured
// with .claude/skills/sound-levels/bangs.mjs (each is cut to peak at -1 dBFS).
export const CRASH_CLIPS: Record<string, number> = {
  'crash-car-1': 0.54, 'crash-car-2': 1.15, 'crash-car-3': 0.68, 'crash-mid': 1.07, 'crash-heavy': 0.6,
  'crash-metal': 1.4, 'crash-plastic': 1.3, // (the metal a little under the rest: it rings on)
  'bump-1': 1.02, 'bump-2': 0.99, 'bump-3': 1.23, 'bump-door': 1.05, 'body-1': 1.17, 'body-2': 1.4,
};
// Which recordings a crash into each thing can use: the first row whose `from` (how
// hard, 0 to 1, see crashMix) the crash reaches. 0.12 is about 10 km/h, 0.45 about 27.
// Evened out, the crashes are as loud as each other, the bumps 6 dB under them.
const CARS = ['crash-car-1', 'crash-car-2', 'crash-car-3'], BUMPS = ['bump-1', 'bump-2', 'bump-3', 'bump-door'];
const PICK: Record<CrashKind, [number, string[]][]> = {
  car: [[0.45, CARS], [0.12, ['crash-mid', ...CARS]], [0, BUMPS]],
  wall: [[0.45, CARS], [0.12, ['crash-mid', 'crash-car-2']], [0, BUMPS]],
  tram: [[0.35, ['crash-heavy', 'crash-car-2']], [0.12, ['crash-heavy']], [0, ['bump-door']]],
  post: [[0.6, ['crash-metal', 'crash-car-1']], [0.12, ['crash-metal']], [0, ['bump-door']]],
  rail: [[0.5, ['crash-metal', 'crash-car-3']], [0.12, ['crash-metal']], [0, ['bump-door']]],
  fence: [[0.12, ['crash-plastic']], [0, ['bump-1', 'bump-2']]],
  hedge: [[0, ['body-2']]],
  person: [[0.3, ['body-1']], [0, ['body-2']]],
  bin: [[0.3, ['crash-metal']], [0, ['bump-door', 'bump-2']]],
  container: [[0.3, ['crash-metal', 'crash-plastic']], [0, ['bump-door']]],
  timber: [[0.3, ['crash-plastic']], [0, ['bump-1', 'bump-3']]],
  bottles: [[0.2, ['crash-plastic']], [0, ['bump-door']]],
  panel: [[0.3, ['crash-plastic', 'crash-metal']], [0, ['bump-2']]],
};

// Play `m` into `out` at time `t`, `loud` times its level right by it, its highs above
// `top` Hz taken off (the air, far away). `noise`: a looped noise buffer (noiseBuffer).
// Returns when the last of it has died away.
// `clips`: the recordings decoded so far, by name.
export function playCrash(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, m: CrashMix, loud: number, top: number, t: number, rnd = Math.random, clips: Partial<Record<string, AudioBuffer>> = {}) {
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = top;
  air.connect(out);
  // The blow goes through a soft clipper: it gives the low end overtones a phone or a
  // laptop can play, and squashes it into one heavy hit rather than a note.
  const blow = ctx.createWaveShaper();
  blow.curve = SATURATE;
  blow.oversample = '2x';
  const blowIn = ctx.createGain();
  blowIn.gain.value = 2.2;
  const blowOut = ctx.createGain();
  blowOut.gain.value = 0.65;
  blowIn.connect(blow).connect(blowOut).connect(air);
  let end = t;
  // A grain of noise through a filter: attack in `rise` s, then down to nothing in `len` s.
  const grain = (at: number, level: number, type: BiquadFilterType, hz: number, q: number, len: number, rise = 0.002, to: AudioNode = air) => {
    if (level <= 1e-4) return;
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.85 + rnd() * 0.3;
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + rise);
    g.gain.exponentialRampToValueAtTime(level * 0.001, at + rise + len);
    src.connect(f).connect(g).connect(to);
    src.start(at, rnd() * 1.5);
    src.stop(at + rise + len + 0.02);
    end = Math.max(end, at + rise + len + 0.02);
  };
  // A tone falling from `from` to `to` Hz, gone in `len` s.
  // `drop`: the share of `len` the fall takes.
  const tone = (at: number, level: number, from: number, to: number, len: number, type: OscillatorType = 'sine', dest: AudioNode = air, drop = 0.6) => {
    if (level <= 1e-4) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + len * drop);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.003);
    g.gain.exponentialRampToValueAtTime(level * 0.001, at + len);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + len + 0.02);
    end = Math.max(end, at + len + 0.02);
  };
  const { hard, pitch } = m;

  // The recorded hit: a heavier car plays it lower. A softer crash with a recording
  // made for a harder one is cut short, the pieces still falling faded out.
  // In a middle row, the recording starts 4.4 dB down and comes up to its full level
  // where the next row takes over, so a crash doesn't jump in loudness between them.
  const rows = PICK[m.kind] ?? PICK.wall, row = rows.findIndex(([from]) => hard >= from);
  const names = rows[row]?.[1] ?? [], from = rows[row]?.[0] ?? 0;
  const soft = row > 0 && from > 0 ? 0.6 + 0.4 * Math.min(1, (hard - from) / (rows[row - 1][0] - from)) : 1;
  const name = names[Math.floor(rnd() * names.length)], clip = name ? clips[name] : undefined;
  if (clip) {
    const src = ctx.createBufferSource(), g = ctx.createGain(), level = loud * m.hit * soft * (CRASH_CLIPS[name] ?? 1);
    src.buffer = clip;
    src.playbackRate.value = pitch * (0.94 + rnd() * 0.12);
    const last = Math.min(clip.duration / src.playbackRate.value, 0.35 + 2.2 * hard);
    g.gain.setValueAtTime(level, t);
    g.gain.setValueAtTime(level, t + last * 0.7);
    g.gain.exponentialRampToValueAtTime(level * 0.001, t + last);
    src.connect(g).connect(air);
    src.start(t);
    src.stop(t + last + 0.02);
    end = Math.max(end, t + last + 0.02);
  } else {
    blowAndCrunch();
  }
  // Over a recording, a little less of the glass and the ringing: it has its own.
  const over = clip ? 0.5 : 1;

  function blowAndCrunch() {
    // The blow, mostly noise so it has no note: a click as they touch, the body of it in
    // the low mids (what small speakers play), and under it a punch that drops in a few
    // ms, as a kick drum does, rather than sliding down. A body's is duller and shorter.
    const thud = loud * m.thud;
    const len = (m.dull ? 0.07 : 0.1) + (m.dull ? 0.1 : 0.22) * hard;
    grain(t, thud * (m.dull ? 0.1 : 0.1 + 0.25 * hard), 'highpass', 1800, 0.7, 0.012, 0.0005, blowIn);
    grain(t, thud * 1.6, 'lowpass', (m.dull ? 220 : 320) * pitch, 1.1, len, 0.002, blowIn);
    grain(t, thud * 1.5, 'bandpass', (m.dull ? 130 : 170) * pitch, 1.4, len * 0.7, 0.002, blowIn);
    grain(t + 0.004, thud * 0.5, 'bandpass', (m.dull ? 380 : 520 + 260 * hard) * pitch, 1, len * 0.45, 0.002, blowIn);
    tone(t, thud * 0.65, (m.dull ? 120 : 150) * pitch, (m.dull ? 50 : 46) * pitch, len * 0.9, 'sine', blowIn, 0.12);
    // A heavy hit: the car's mass settling, a lower rumble after the blow.
    if (!m.dull && hard > 0.3) grain(t + 0.02, thud * 0.7 * hard, 'lowpass', 140 * pitch, 0.9, 0.18 + 0.3 * hard, 0.03, blowIn);

    // Crumpling: short grains of noise, most of them at once and fewer after, each its
    // own pitch, so it crackles rather than hisses; under them, the bend of the panel.
    const crunch = loud * m.crunch;
    if (crunch > 1e-4) {
      grain(t, crunch * 0.45, 'bandpass', 1500 * pitch, 0.8, m.length * 0.45, 0.004);
      grain(t, crunch * 0.5, 'bandpass', 420 * pitch, 0.9, m.length * 0.35, 0.003); // the panel's own weight
      const n = Math.round(3 + 15 * hard);
      for (let i = 0; i < n; i++) {
        const u = i / n, at = t + 0.004 + m.length * 0.6 * u * u + rnd() * 0.01;
        grain(at, crunch * (1 - 0.65 * u) * (0.45 + 0.55 * rnd()), 'bandpass', (700 + rnd() * 2800) * pitch, 1.5 + rnd() * 3, 0.012 + rnd() * 0.05);
      }
    }
  }

  // The metal ringing: a few notes that don't fit together, the high ones going first,
  // each mostly noise through a narrow filter, so the metal shimmers instead of
  // playing a tune; only a hollow pole keeps a clear note.
  const ring = loud * m.ring * over;
  if (ring > 1e-4 && m.hz > 0) {
    const clear = m.decay > 0.8 ? 0.5 : 0.15;
    for (const [ratio, level, keep] of [[1, 1, 1], [1.59, 0.6, 0.8], [2.37, 0.4, 0.6], [3.41, 0.25, 0.45]]) {
      const f = m.hz * ratio * (0.97 + rnd() * 0.06);
      grain(t + 0.002, ring * level * 2.6, 'bandpass', f, 18 + rnd() * 10, m.decay * keep, 0.003);
      tone(t + 0.002, ring * level * clear, f, f * 0.995, m.decay * keep * 0.7);
    }
  }

  // Glass: a sharp crack, then the pieces, thick at first and fewer as they settle, each
  // a high ping or two; and for the hardest, some heavier bits falling.
  const glass = loud * m.glass * over;
  if (glass > 1e-4) {
    grain(t + 0.006, glass * 0.9, 'highpass', 3800, 0.7, 0.07, 0.001);
    const n = Math.round(6 + 22 * Math.min(1, m.glass / 0.35));
    for (let i = 0; i < n; i++) {
      const u = rnd(), at = t + 0.03 + 0.9 * u ** 1.8 * (0.5 + 0.5 * hard), f = 2600 + rnd() * 5200, level = glass * 0.22 * (0.3 + 0.7 * rnd()) * (1 - 0.6 * u);
      tone(at, level, f, f, 0.02 + rnd() * 0.05);
      tone(at, level * 0.5, f * 1.47, f * 1.47, 0.015 + rnd() * 0.03);
    }
    if (hard > 0.6) {
      for (let i = 0; i < 5; i++) {
        const at = t + 0.35 + rnd() * 0.8;
        grain(at, glass * 0.25 * (0.4 + 0.6 * rnd()), 'bandpass', 800 + rnd() * 1400, 2, 0.03 + rnd() * 0.04);
      }
    }
  }

  // Leaves and twigs (a hedge), or clothes (someone hit): a soft rush of high noise.
  const rustle = loud * m.rustle;
  if (rustle > 1e-4) grain(t, rustle, 'bandpass', 2600, 0.6, 0.2 + 0.4 * hard, 0.02);
  return end;
}

// tanh, made a little lopsided so it adds even overtones too, as a dented panel does.
const SATURATE = (() => {
  const c = new Float32Array(1025);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(1.6 * x + 0.15 * x * x) / Math.tanh(1.75);
  }
  return c;
})();
