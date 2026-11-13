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
