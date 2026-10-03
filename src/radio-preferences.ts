// Station exclusions are saved by ID so reordering the station list is safe.
const KEY = 'radio-preferences';
const listeners: (() => void)[] = [];
let blocked: string[] = [];
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
  if (Array.isArray(saved.blocked)) blocked = saved.blocked.filter((id: unknown) => typeof id === 'string');
} catch {}

export const stationAllowed = (id: string) => !blocked.includes(id);
export function setStationAllowed(id: string, allowed: boolean) {
  blocked = blocked.filter((item) => item !== id);
  if (!allowed) blocked.push(id);
  try { localStorage.setItem(KEY, JSON.stringify({ blocked })); } catch {}
  for (const listener of listeners) listener();
}
export function onRadioPreferencesChange(listener: () => void) { listeners.push(listener); }
