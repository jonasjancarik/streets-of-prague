import type { Kind } from './weather.ts';

// The weather in Prague right now, from Open-Meteo (no key needed), for the start
// screen. Null when it can't be had in a few seconds, and the game rolls its own.
const URL = 'https://api.open-meteo.com/v1/forecast?latitude=50.0875&longitude=14.4213&current=weather_code&timezone=Europe%2FPrague';

// WMO weather codes: https://open-meteo.com/en/docs
export function kindOfCode(code: number): Kind | null {
  if (code <= 1) return 'clear';
  if (code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'mist';
  if (code >= 51 && code <= 67) return 'rain'; // drizzle, rain and freezing rain
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain'; // showers
  if (code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'storm';
  return null;
}

export async function liveWeather(timeoutMs = 4000): Promise<Kind | null> {
  try {
    const r = await fetch(URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const code: unknown = ((await r.json()) as { current?: { weather_code?: unknown } }).current?.weather_code;
    return typeof code === 'number' ? kindOfCode(code) : null;
  } catch {
    return null;
  }
}
