import { getLang, t } from './i18n.ts';
import { kc } from './money.ts';
import type { Kind } from './weather.ts';

// Saved games, in the browser's localStorage. The game saves itself by itself into the
// "auto" slot (every few seconds and when the page is left), so a refresh puts you
// back where you were; the three numbered slots are saved by hand from the settings.
// A save holds you and what you own: where you are, the car you're driving, money,
// ticket, health, police heat, the time and the weather. The rest of the city (the
// traffic, the people, a ride in progress) starts fresh, as it does at a teleport.

export type Slot = 'auto' | '1' | '2' | '3';
export const SLOTS: Slot[] = ['1', '2', '3'];

export interface SaveData {
  v: 1;
  area: string;
  at: number; // Date.now() when it was saved
  x: number; y: number; h: number; // the game's local metres and heading, of you or of your car
  street: string | null;
  car: { type: string; paint: string; box?: string; variant: string | null; damage: number; radio?: number } | null;
  money: number;
  ticket: { from: number; minutes: number } | null;
  health: number;
  heat: number;
  clock: number;
  weather: { kind: Kind; fixed: boolean };
}

const key = (slot: Slot) => `save:${slot}`;
const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function readSave(slot: Slot, area: string): SaveData | null {
  try {
    const raw = localStorage.getItem(key(slot));
    if (!raw) return null;
    const s = JSON.parse(raw) as SaveData;
    if (s.v !== 1 || s.area !== area || ![s.x, s.y, s.h, s.money, s.health, s.heat, s.clock, s.at].every(num) || !s.weather) return null;
    return s;
  } catch { return null; }
}

export function writeSave(slot: Slot, data: SaveData) {
  try { localStorage.setItem(key(slot), JSON.stringify(data)); } catch { /* full or blocked: the game goes on unsaved */ }
}

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
