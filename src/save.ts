import { getLang, t } from './i18n.ts';
import { kc } from './money.ts';
import type { Kind } from './weather.ts';

// Saved games, in the browser's localStorage. The game saves itself by itself into the
// "auto" slot (every few seconds and when the page is left), so a refresh puts you
// back where you were; any number of others are saved by hand from the settings.
// A save holds you and what you own: where you are, the car you're driving, money,
// ticket, health, police heat, the date, the time and the weather. The rest of the city (the
// traffic, the people, a ride in progress) starts fresh, as it does at a teleport.

// A save is 'auto' or a hand-made one named by when it was made (its Date.now()).
export type Slot = string;
const HAND = 'save:hand:';

export interface SaveData {
  v: 1;
  area: string;
  at: number; // Date.now() when it was saved
  // Where you are (or your car is) as latitude and longitude and a compass heading, not
  // as the map's local metres, so a save survives a change to the map's origin.
  lat: number; lon: number; heading: number;
  street: string | null;
  car: { type: string; paint: string; box?: string; variant: string | null; damage: number; radio?: number; broken?: number; ram?: boolean } | null;
  money: number;
  ticket: { from: number; minutes: number } | null;
  health: number;
  heat: number;
  clock: number;
  // The day of the year (season.ts); saves from before the game had a date lack it.
  season?: number;
  weather: { kind: Kind; fixed: boolean };
}

const key = (slot: Slot) => `save:${slot}`;
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === 'string';
const optionalNumber = (value: unknown) => value === undefined || num(value);
const between = (value: unknown, min: number, max: number) => num(value) && value >= min && value < max;
const WEATHER_KINDS: readonly Kind[] = ['clear', 'cloudy', 'rain', 'storm', 'mist', 'snow'];

function carData(value: unknown) {
  return value === null || (object(value) && typeof value.type === 'string' && typeof value.paint === 'string'
    && textOrNull(value.variant) && num(value.damage)
    && (value.box === undefined || typeof value.box === 'string')
    && optionalNumber(value.radio) && optionalNumber(value.broken)
    && (value.ram === undefined || typeof value.ram === 'boolean'));
}

function ticketData(value: unknown) {
  return value === null || (object(value) && num(value.from) && num(value.minutes) && value.minutes > 0);
}

// JSON can be syntactically valid yet crash restoration (for example, an unknown
// weather kind). Check nested state as well, keeping older optional fields optional.
function saveData(s: unknown): s is SaveData {
  return object(s) && s.v === 1 && typeof s.area === 'string'
    && [s.money, s.health, s.heat, s.at].every(num)
    && num(s.lat) && Math.abs(s.lat) < 90 && num(s.lon) && Math.abs(s.lon) <= 180
    && between(s.heading, 0, 360) && between(s.clock, 0, 7 * 86400)
    && textOrNull(s.street) && optionalNumber(s.season)
    && carData(s.car) && ticketData(s.ticket)
    && object(s.weather) && typeof s.weather.kind === 'string' && WEATHER_KINDS.includes(s.weather.kind as Kind)
    && typeof s.weather.fixed === 'boolean';
}

type Check = 'ok' | 'other area' | 'unreadable';

// Whether a save is one this version can open. A format change must be handled here,
// by upgrading older `v` values to the current shape, not by dropping them: the
// player's progress would vanish. What can't be opened is kept and shown as such.
function check(raw: string, area: string): { how: Check; data?: SaveData } {
  try {
    const s: unknown = JSON.parse(raw);
    if (!saveData(s)) return { how: 'unreadable' };
    return s.area === area ? { how: 'ok', data: s } : { how: 'other area' };
  } catch { return { how: 'unreadable' }; }
}

const get = (slot: Slot) => { try { return localStorage.getItem(key(slot)); } catch { return null; } };

export function readSave(slot: Slot, area: string): SaveData | null {
  const raw = get(slot);
  return raw ? check(raw, area).data ?? null : null;
}

// There is a save in this slot that this version can't open.
export function unreadable(slot: Slot, area: string) {
  const raw = get(slot);
  return raw !== null && check(raw, area).how === 'unreadable';
}

export function writeSave(slot: Slot, data: SaveData) {
  try { localStorage.setItem(key(slot), JSON.stringify(data)); } catch { /* full or blocked: the game goes on unsaved */ }
}

// The hand-made saves of this area, newest first; `data` is null for one that this
// version can't open (it can still be deleted).
export function listSaves(area: string): { slot: Slot; data: SaveData | null }[] {
  const out: { slot: Slot; data: SaveData | null }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(HAND)) continue;
      const c = check(localStorage.getItem(k) ?? '', area);
      if (c.how !== 'other area') out.push({ slot: k.slice('save:'.length), data: c.data ?? null });
    }
  } catch { /* storage blocked */ }
  return out.sort((a, b) => (b.data?.at ?? 0) - (a.data?.at ?? 0));
}

// A new name for a hand-made save.
export const newSlot = (): Slot => `hand:${Date.now()}`;

export function clearSave(slot: Slot) {
  try { localStorage.removeItem(key(slot)); } catch { /* nothing to remove */ }
}

// "5 min ago".
function ago(at: number) {
  const min = Math.max(0, Math.round((Date.now() - at) / 60000));
  const f = new Intl.RelativeTimeFormat(getLang() === 'cs' ? 'cs' : 'en', { numeric: 'auto' });
  if (min < 1) return f.format(0, 'second');
  if (min < 60) return f.format(-min, 'minute');
  if (min < 1440) return f.format(-Math.round(min / 60), 'hour');
  return f.format(-Math.round(min / 1440), 'day');
}

// One line for a menu: where, what you're in, how much money, and when it was saved.
export function describe(s: SaveData) {
  const hh = Math.floor((s.clock % 86400) / 3600), mm = Math.floor((s.clock % 3600) / 60);
  const place = s.street ?? t('Somewhere in Prague');
  const what = s.car ? '' : ` · ${t('on foot')}`;
  return `${place}${what} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${kc(s.money)} · ${ago(s.at)}`;
}
