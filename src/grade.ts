// The tone curve and grade every pixel ends with: a filmic curve per channel (the fit
// to the ACES curve by Krzysztof Narkowicz, with a softer toe), then a little more
// saturation. Sunlit stone sits on the straight middle of the curve, so a roof's sunny
// and shaded slopes stay apart, and what lies in shade is properly dark; the curve
// before it (an extended Reinhard, ?grade=old) held everything sunlit on its shoulder,
// which read as flat and washed out.
//
// The numbers live here so that the three places that need the curve agree: the WebGPU
// shader (webgpu/grade.ts), the old renderer's GLSL (sky.ts) and the curve undone on the
// CPU for colours meant for the screen (the fog).
const asked = new URLSearchParams(globalThis.location?.search ?? '').get('grade');
export const OLD_GRADE = asked === 'old';

export const GRADE = {
  // y = x (a x + b) / (x (c x + d) + e)
  a: 2.51, b: 0.15, c: 2.43, d: 0.59, e: 0.14,
  // How much of the light the curve takes in: the moods' exposures (sky.ts) were set for
  // the old curve, whose mid-grey this brings to about the same brightness.
  gain: 0.52,
  // Saturation after the curve (1 leaves it)…
  sat: 0.9,
  // …and how much of it bright colours lose on top, from where their strongest channel
  // passes `fadeFrom` to where it clips: sunlit tiles at sunset glowed like neon. (Not
  // undone in ungrade: what goes through that is near grey.)
  fade: 0.34, fadeFrom: 0.5,
};

// The look laid over the curve, which changes with the hour and the weather (lookAt): the
// dark end of the picture is tinted one way and the light end another, colours are made
// stronger or weaker, and the middle steepened a little. WebGPU only; ?look=off leaves it
// out. (The fog's and the rain's colours, worked back through the curve, don't take it
// into account: they come out tinted with the rest, by these few per cent.)
export const LOOK_ON = new URLSearchParams(globalThis.location?.search ?? '').get('look') !== 'off';
export interface Look { shadow: [number, number, number]; light: [number, number, number]; sat: number; contrast: number }
export const LOOK: Look = { shadow: [1, 1, 1], light: [1, 1, 1], sat: 1, contrast: 0 };
// Adjustments from the developer panel (dev.ts), 1 (and 0 for the contrast) as the game
// ships: the exposure, how strongly the hour's look is laid on, and the saturation and
// contrast on top of it. All but the exposure need the look (WebGPU).
export const GRADE_TUNE = { exposure: 1, look: 1, sat: 1, contrast: 0 };
export const GRADE_TUNE_DEFAULT = { ...GRADE_TUNE };
// Broad daylight, the low sun's hour, dusk and dawn's blue, night under the lamps, and a
// clouded sky (rain, snow, mist: `dull`). Kept within a few per cent: a mood, not a filter.
const LOOKS: Record<'day' | 'golden' | 'blue' | 'night' | 'dull', Look> = {
  day: { shadow: [0.98, 1, 1.03], light: [1.02, 1, 0.98], sat: 1.04, contrast: 0.1 },
  golden: { shadow: [0.94, 0.99, 1.07], light: [1.06, 1.01, 0.93], sat: 1.08, contrast: 0.16 },
  blue: { shadow: [0.93, 0.98, 1.09], light: [1.0, 1.0, 1.02], sat: 0.96, contrast: 0.1 },
  night: { shadow: [0.92, 0.98, 1.1], light: [1.06, 1.0, 0.9], sat: 1.02, contrast: 0.14 },
  dull: { shadow: [0.98, 1, 1.02], light: [0.98, 1, 1.02], sat: 0.84, contrast: 0 },
};
// The look for a sun `deg` degrees above the horizon and a sky `dull` (0 clear to 1 wholly
// clouded, misty or snowing), written into LOOK.
export function lookAt(deg: number, dull: number) {
  const step = (x: number, a: number, b: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const weights: [Look, number][] = [
    [LOOKS.night, 1 - step(deg, -9, -4)],
    [LOOKS.blue, step(deg, -9, -4) * (1 - step(deg, -2, 3))],
    [LOOKS.golden, step(deg, -2, 3) * (1 - step(deg, 10, 24))],
    [LOOKS.day, step(deg, 10, 24)],
  ];
  // (Clouds hide the low sun's colours altogether, and half of the night's: the lamps still shine.)
  const flat = dull * (1 - 0.5 * weights[0][1]);
  const mix = (get: (l: Look) => number) => weights.reduce((sum, [l, w]) => sum + get(l) * w, 0) * (1 - flat) + get(LOOKS.dull) * flat;
  for (let i = 0; i < 3; i++) { LOOK.shadow[i] = mix((l) => l.shadow[i]); LOOK.light[i] = mix((l) => l.light[i]); }
  LOOK.sat = mix((l) => l.sat); LOOK.contrast = mix((l) => l.contrast);
  const k = GRADE_TUNE.look;
  for (let i = 0; i < 3; i++) { LOOK.shadow[i] = 1 + (LOOK.shadow[i] - 1) * k; LOOK.light[i] = 1 + (LOOK.light[i] - 1) * k; }
  LOOK.sat = (1 + (LOOK.sat - 1) * k) * GRADE_TUNE.sat;
  LOOK.contrast = Math.max(-0.5, LOOK.contrast * k + GRADE_TUNE.contrast);
  return LOOK;
}

const LUMA = [0.2126, 0.7152, 0.0722];

// The curve for one channel (without the saturation, which keeps the brightness).
export function filmic(x: number) {
  const { a, b, c, d, e } = GRADE;
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)));
}

// The value the curve turns into `y`.
export function unfilmic(y: number) {
  const { a, b, c, d, e } = GRADE;
  const v = Math.min(0.999, Math.max(0, y));
  const A = a - c * v, B = b - d * v;
  return (-B + Math.sqrt(B * B + 4 * A * e * v)) / (2 * A);
}

// The colour (linear, before the exposure) that the grade turns into `seen` (linear, as
// it should reach the screen), for an exposure that already holds the gain.
export function ungrade(seen: { r: number; g: number; b: number }, exposure: number, out: { setRGB(r: number, g: number, b: number): unknown }) {
  const c = [seen.r, seen.g, seen.b];
  const luma = LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];
  const x = c.map((v) => unfilmic(luma + (v - luma) / GRADE.sat) / exposure);
  return out.setRGB(x[0], x[1], x[2]);
}
