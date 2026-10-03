// Station exclusions are saved by ID so reordering the station list is safe.
const KEY = 'radio-preferences';
const listeners: (() => void)[] = [];
let blocked: string[] = [];
export type StationDistribution = 'random' | 'audience';
let distribution: StationDistribution = 'random';
// Daily listeners, thousands: RADIOPROJEKT Oct 2025–Mar 2026, published May 2026.
// Source and missing-station policy: docs/radio-stations.md.
const AUDIENCE: Record<string, number> = { beat: 277, kiss: 500, evropa2: 668, casrock: 38, vltava: 42 };
const FALLBACK = 38; // equal modest weight for stations without comparable figures
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (Array.isArray(saved.blocked)) blocked = saved.blocked.filter((id: unknown) => typeof id === 'string');
  if (saved.distribution === 'audience') distribution = 'audience';
} catch {}

export const stationAllowed = (id: string) => !blocked.includes(id);
export const stationDistribution = () => distribution;
export const stationWeight = (id: string) => distribution === 'audience' ? AUDIENCE[id] ?? FALLBACK : 1;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ blocked, distribution })); } catch {}
  for (const listener of listeners) listener();
}
export function setStationDistribution(value: StationDistribution) {
  distribution = value;
  save();
}
export function setStationAllowed(id: string, allowed: boolean) {
  blocked = blocked.filter((item) => item !== id);
  if (!allowed) blocked.push(id);
  save();
}
export function onRadioPreferencesChange(listener: () => void) { listeners.push(listener); }
