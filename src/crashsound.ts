// A crash, made with the Web Audio API from noise and a few oscillators (no recordings):
// the low blow, metal and plastic crumpling in short grains, the panel or pole ringing
// after, and for a hard one, glass breaking and bits of it falling. The levels come
// from crashMix in src/soundmix.ts. Sound.crash (src/audio.ts) plays it in the game; it
// takes any audio context, so it can also be rendered offline to be measured.

import type { CrashMix } from './soundmix.ts';

// Play `m` into `out` at time `t`, `loud` times its level right by it, its highs above
// `top` Hz taken off (the air, far away). `noise`: a looped noise buffer (noiseBuffer).
// Returns when the last of it has died away.
export function playCrash(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, m: CrashMix, loud: number, top: number, t: number, rnd = Math.random) {
  const air = ctx.createBiquadFilter();
  air.type = 'lowpass';
  air.frequency.value = top;
  air.connect(out);
  let end = t;
  // A grain of noise through a filter: attack in `rise` s, then down to nothing in `len` s.
  const grain = (at: number, level: number, type: BiquadFilterType, hz: number, q: number, len: number, rise = 0.002) => {
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
    src.connect(f).connect(g).connect(air);
    src.start(at, rnd() * 1.5);
    src.stop(at + rise + len + 0.02);
    end = Math.max(end, at + rise + len + 0.02);
  };
  // A tone falling from `from` to `to` Hz, gone in `len` s.
  const tone = (at: number, level: number, from: number, to: number, len: number, type: OscillatorType = 'sine') => {
    if (level <= 1e-4) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, at + len * 0.6);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.003);
    g.gain.exponentialRampToValueAtTime(level * 0.001, at + len);
    o.connect(g).connect(air);
    o.start(at);
    o.stop(at + len + 0.02);
    end = Math.max(end, at + len + 0.02);
  };
  const { hard, pitch } = m;

  // The blow: a falling low note and a burst of dark noise; a body's is duller and shorter.
  const thud = loud * m.thud;
  tone(t, thud, (m.dull ? 85 : 110) * pitch, (m.dull ? 42 : 38) * pitch, 0.14 + 0.28 * hard);
  grain(t, thud * 0.7, 'lowpass', (m.dull ? 450 : 1300 + 900 * hard) * pitch, 0.7, 0.06 + 0.3 * hard, 0.001);

  // Crumpling: short grains of noise, most of them at once and fewer after, each its
  // own pitch, so it crackles rather than hisses; under them, the bend of the panel.
  const crunch = loud * m.crunch;
  if (crunch > 1e-4) {
    grain(t, crunch * 0.45, 'bandpass', 1500 * pitch, 0.8, m.length * 0.45, 0.004);
    const n = Math.round(3 + 15 * hard);
    for (let i = 0; i < n; i++) {
      const u = i / n, at = t + 0.004 + m.length * 0.6 * u * u + rnd() * 0.01;
      grain(at, crunch * (1 - 0.65 * u) * (0.45 + 0.55 * rnd()), 'bandpass', (700 + rnd() * 2800) * pitch, 1.5 + rnd() * 3, 0.012 + rnd() * 0.05);
    }
  }

  // The metal ringing: a few notes that don't fit together, the high ones going first.
  const ring = loud * m.ring;
  if (ring > 1e-4 && m.hz > 0) {
    for (const [ratio, level, keep] of [[1, 1, 1], [1.59, 0.6, 0.8], [2.37, 0.4, 0.6], [3.41, 0.25, 0.45]]) {
      const f = m.hz * ratio * (0.97 + rnd() * 0.06);
      tone(t + 0.002, ring * level, f, f * 0.995, m.decay * keep, 'triangle');
    }
  }

  // Glass: a sharp crack, then the pieces, thick at first and fewer as they settle, each
  // a high ping or two; and for the hardest, some heavier bits falling.
  const glass = loud * m.glass;
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
