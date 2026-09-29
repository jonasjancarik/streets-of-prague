// How loud each of the city's sound loops (public/audio/amb-*.m4a) plays, for where
// you are and when: the game's Ambience (src/audio.ts) sets its gains from this, and
// the sound-levels skill (.claude/skills/sound-levels) measures the mix offline with
// the same numbers, so keep it free of browser APIs and imports.
//
// People and their footsteps and voices on busy streets by day, traffic in the
// distance by day and a quieter hum by night, and birds where it's quiet (a blackbird
// at dawn and dusk, the small garden birds by day, a whole morning chorus early on),
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

// Each loop's gain: `busy` how busy the streets within 150 m are, 0 (the edge of town)
// to 1 (the Old Town, from the footfall map), `hour` 0–24, `wet` how hard it rains or
// snows, 0–1.
export function ambienceGains(busy: number, hour: number, wet: number): Record<string, number> {
  // Birds only well away from the centre: none from 0.1 up (the inner city, even
  // Vinohrady's side streets), all of them below 0.006 (the suburbs), on a log scale
  // (half the city is under 0.01). The parks in town, at 0.03–0.06, get a little.
  const far = clamp((-1 - Math.log10(Math.max(busy, 1e-4))) / 1.2, 0, 1);
  const quiet = far * far * (3 - 2 * far), dry = 1 - wet;
  const awake = 0.15 + 0.85 * span(hour, 5.5, 8, 21, 24); // how many people are about
  const night = 1 - span(hour, 5, 6.5, 22, 23.5);
  const level: Record<string, number> = {
    crowd: busy ** 0.7 * awake,
    crowd2: busy ** 0.7 * awake,
    traffic: (0.35 + 0.65 * busy) * (1 - night),
    night: (0.5 + 0.5 * busy) * night,
    blackbird: quiet * dry * Math.max(span(hour, 3.5, 4.5, 7, 9), 0.8 * span(hour, 18, 19.5, 21, 22), 0.25 * span(hour, 9, 10, 17, 18)),
    garden: quiet * dry * Math.max(span(hour, 6, 8, 17, 19.5), 0.5 * span(hour, 4.5, 5.5, 6, 8)),
    morning: quiet * dry * span(hour, 4, 5, 8, 10),
  };
  return Object.fromEntries(Object.entries(AMBIENCE).map(([name, full]) => [name, (level[name] ?? 0) * full]));
}
