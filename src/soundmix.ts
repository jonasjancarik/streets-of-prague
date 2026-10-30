// How loud each of the city's sound loops (public/audio/amb-*.m4a) plays, for where
// you are and when: the game's Ambience (src/audio.ts) sets its gains from this, and
// the sound-levels skill (.claude/skills/sound-levels) measures the mix offline with
// the same numbers, so keep it free of browser APIs and imports.
//
// People and their footsteps and voices on busy streets by day, traffic in the
// distance by day and a quieter hum by night, and birds where it's quiet (a blackbird
// at dawn and dusk, the small garden birds by day, a whole morning chorus early on),
// strongest on spring mornings, fewer in late summer, nearly silent in winter;
// none of them in rain or snow. (Two crowds of different lengths are layered, so
// together they repeat only every few minutes.)

// Each loop's gain at full strength. The loops are all evened out to about -20 dBFS
// by pipeline/build_audio.py, so these set their levels against each other.
export const AMBIENCE: Record<string, number> = { crowd: 0.25, crowd2: 0.25, traffic: 0.3, night: 0.3, blackbird: 0.07, garden: 0.07, morning: 0.06 };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// 0 outside [a, d], 1 within [b, c], smooth in between (hours, round midnight too).
export function span(h: number, a: number, b: number, c: number, d: number) {
  const x = (((h - a) % 24) + 24) % 24, len = (((d - a) % 24) + 24) % 24;
  const b1 = (((b - a) % 24) + 24) % 24, c1 = (((c - a) % 24) + 24) % 24;
  if (x > len) return 0;
  const up = b1 > 0 ? clamp(x / b1, 0, 1) : 1, down = len > c1 ? clamp((len - x) / (len - c1), 0, 1) : 1;
  const e = Math.min(up, down);
  return e * e * (3 - 2 * e);
}

// The existing season.ts curves, passed by reference from the game. Optional for
// older offline callers, which retain the original summer reference mix.
export interface BirdSeason { fresh: number; dry: number; cold: number }

export function birdActivity(hour: number, season?: BirdSeason) {
  if (!season) return 1;
  // The dry curve passes 0.2 just after mid-July: July 15 stays exactly familiar.
  const lateSummer = clamp((season.dry - 0.2) / 0.8, 0, 1);
  const springMorning = season.fresh * span(hour, 4, 5, 8, 10);
  return (1 + 0.4 * springMorning) * (1 - 0.65 * lateSummer) * (1 - 0.97 * season.cold);
}

// How loud each class of road is against a trunk road's roar, for roadNoise.
export const ROAD_NOISE: Record<string, number> = {
  motorway: 1, trunk: 1, primary: 1, motorway_link: 0.8, trunk_link: 0.8, primary_link: 0.8,
  secondary: 0.6, secondary_link: 0.5,
};
export const ROAD_NEAR = 40; // m: within this of a road it drowns the birds
export const ROAD_FAR = 150; // m: from this on it doesn't

// How near a big road is, 0–1: 1 within ROAD_NEAR of a trunk or primary road, nothing
// from ROAD_FAR, a smaller main road counting for less (ROAD_NOISE). The footfall map
// counts people, so a road with six lanes and no pavement (Barrandovský most) is
// as quiet to it as a field. `edges`: the streets for cars within ROAD_FAR.
export function roadNoise(edges: Iterable<{ hw: string; pts: [number, number][] }>, x: number, y: number) {
  let most = 0;
  for (const e of edges) {
    const w = ROAD_NOISE[e.hw] ?? 0;
    if (w <= most) continue;
    let d = Infinity;
    for (let i = 0; i < e.pts.length - 1; i++) {
      const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1], dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const s = len ? clamp(((x - ax) * dx + (y - ay) * dy) / len, 0, 1) : 0;
      d = Math.min(d, Math.hypot(ax + s * dx - x, ay + s * dy - y));
    }
    const near = clamp((ROAD_FAR - d) / (ROAD_FAR - ROAD_NEAR), 0, 1);
    most = Math.max(most, w * near * near * (3 - 2 * near));
  }
  return most;
}

// Each loop's gain: `busy` how busy the streets within 150 m are, 0 (the edge of town)
// to 1 (the Old Town, from the footfall map), `hour` 0–24, `wet` how hard it rains or
// snows, 0–1, `road` how near a big road is (roadNoise).
export function ambienceGains(busy: number, hour: number, wet: number, season?: BirdSeason, road = 0): Record<string, number> {
  // Birds only well away from the centre: none from 0.1 up (the inner city, even
  // Vinohrady's side streets), all of them below 0.006 (the suburbs), on a log scale
  // (half the city is under 0.01). The parks in town, at 0.03–0.06, get a little.
  // And none beside a big road, whatever the footfall.
  const far = clamp((-1 - Math.log10(Math.max(busy, 1e-4))) / 1.2, 0, 1);
  const quiet = far * far * (3 - 2 * far) * (1 - road), dry = 1 - wet;
  const birds = quiet * dry * birdActivity(hour, season);
  const awake = 0.15 + 0.85 * span(hour, 5.5, 8, 21, 24); // how many people are about
  const night = 1 - span(hour, 5, 6.5, 22, 23.5);
  const level: Record<string, number> = {
    // The crowd is the Old Town's: full only on the busiest squares, well down on a
    // side street (0.36 about -12 dB, 0.09 about -27 dB), and muffled there too (see
    // ambienceMuffle).
    crowd: busy ** 1.3 * awake,
    crowd2: busy ** 1.3 * awake,
    traffic: (0.35 + 0.65 * busy) * (1 - night),
    night: (0.5 + 0.5 * busy) * night,
    blackbird: birds * Math.max(span(hour, 3.5, 4.5, 7, 9), 0.8 * span(hour, 18, 19.5, 21, 22), 0.25 * span(hour, 9, 10, 17, 18)),
    garden: birds * Math.max(span(hour, 6, 8, 17, 19.5), 0.5 * span(hour, 4.5, 5.5, 6, 8)),
    morning: birds * span(hour, 4, 5, 8, 10),
  };
  return Object.fromEntries(Object.entries(AMBIENCE).map(([name, full]) => [name, (level[name] ?? 0) * full]));
}

// How muffled each loop is (a lowpass, Hz; missing: not at all). The crowd, heard from
// a side street, is round the corner: its highs go, on a log scale, from none at
// busy 0.6 and up to about 1.4 kHz at 0.09 (Vinohrady's side streets) and 700 Hz
// at 0.05 and below.
export function ambienceMuffle(busy: number): Record<string, number> {
  const hz = Math.min(20000, 700 * Math.max(1, busy / 0.05) ** 1.26);
  return { crowd: hz, crowd2: hz };
}

// The sirens of emergency vehicles (src/audio.ts): how loud one is at `d` metres, up to
// SIREN_RANGE, where it's gone. An engine is a little louder than a police car.
export const SIREN_RANGE = 450;
export const SIREN_LEVEL: Record<string, number> = { fire: 0.12, police: 0.1, ambulance: 0.11 };
export function sirenGain(kind: string, d: number) {
  return (SIREN_LEVEL[kind] ?? 0.05) * (25 / (25 + d)) * clamp(1 - d / SIREN_RANGE, 0, 1);
}
