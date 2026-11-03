import type { Kind } from './weather.ts';

// The weather in Prague right now, for the start screen and, while the player leaves the
// weather to itself, for the game to follow (main.ts). Null when it can't be had in a
// few seconds, and the game rolls its own.
// From the game's own address first when the build names one (VITE_WEATHER_API, e.g.
// /api/weather: ČHMÚ's open data through worker/weather.js, free for any use), and
// from Open-Meteo (no key needed, free for non-commercial use) otherwise or when that fails.
const OWN: string = (import.meta.env?.VITE_WEATHER_API as string | undefined) ?? '';
const URL = 'https://api.open-meteo.com/v1/forecast?latitude=50.0875&longitude=14.4213&current=weather_code&timezone=Europe%2FPrague';

// WMO weather codes: https://open-meteo.com/en/docs
export function kindOfCode(code: number): Kind | null {
  if (!Number.isInteger(code) || code < 0) return null;
  // Partly cloudy (2) counts as clear: fair weather has its drifting cloud shadows, and
  // the grey Cloudy look is kept for an overcast sky (3).
  if (code <= 2) return 'clear';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'mist';
  if (code >= 51 && code <= 67) return 'rain'; // drizzle, rain and freezing rain
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain'; // showers
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return null;
}

const KINDS: Kind[] = ['clear', 'cloudy', 'rain', 'storm', 'mist', 'snow'];

async function ownWeather(timeoutMs: number): Promise<Kind | null> {
  try {
    const r = await fetch(OWN, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const kind: unknown = ((await r.json()) as { kind?: unknown }).kind;
    return KINDS.includes(kind as Kind) ? kind as Kind : null;
  } catch {
    return null;
  }
}

export async function liveWeather(timeoutMs = 4000): Promise<Kind | null> {
  const own = OWN ? await ownWeather(timeoutMs) : null;
  if (own) return own;
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const code: unknown = ((await r.json()) as { current?: { weather_code?: unknown } }).current?.weather_code;
    return typeof code === 'number' ? kindOfCode(code) : null;
  } catch {
    return null;
  }
}
