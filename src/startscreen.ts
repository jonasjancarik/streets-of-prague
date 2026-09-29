import { KINDS } from './weather.ts';
import type { Kind } from './weather.ts';
import { LANGS, getLang, onLang, setLang, t } from './i18n.ts';
import type { Lang } from './i18n.ts';

// The start of the game, on the loading screen: the time and weather it will begin
// with (the time in Prague now and a weather picked for the season, if nothing was
// asked for in the URL), each one changeable, and sound on or off. The button stays
// grey while the map loads, and pressing it is also what lets the browser play sound.

const TIMES: { id: string; label: string; sec: number }[] = [
  { id: 'morning', label: 'Morning', sec: 8 * 3600 },
  { id: 'midday', label: 'Midday', sec: 13 * 3600 },
  { id: 'evening', label: 'Evening', sec: 19 * 3600 },
  { id: 'night', label: 'Night', sec: 1.5 * 3600 },
];
const WEATHER: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };

export interface StartChoice {
  // Seconds since midnight, or null to keep the clock as it is (the time now).
  time: number | null;
  weather: Kind;
  sound: boolean;
}

const el = (tag: string, cls: string, parent: HTMLElement, text = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
};

export function startScreen(root: HTMLElement, opts: { now: string; weather: Kind; sound: boolean }) {
  const panel = el('div', 'ls-start', root);
  let time: string = 'now', weather: Kind = opts.weather, sound = opts.sound;

  // Text that follows the language: each is given again when it changes.
  const relabel: (() => void)[] = [];
  onLang(() => { for (const f of relabel) f(); });

  // A row of buttons of which one is picked.
  function row<T extends string>(label: string, items: { id: T; label: () => string }[], picked: T, pick: (id: T) => void) {
    const r = el('div', 'ls-row', panel);
    const name = el('span', 'ls-label', r);
    relabel.push(() => { name.textContent = t(label); });
    const chips = el('div', 'ls-chips', r);
    const buttons = items.map((it) => {
      const b = el('button', 'ls-chip', chips) as HTMLButtonElement;
      relabel.push(() => { b.textContent = it.label(); });
      b.type = 'button';
      b.setAttribute('aria-pressed', String(it.id === picked));
      b.addEventListener('click', () => {
        pick(it.id);
        for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
      });
      return b;
    });
  }

  const fixed = (s: string) => () => s;
  row<Lang>('Language', LANGS.map((l) => ({ id: l.id, label: fixed(l.label) })), getLang(), setLang);
  row('Time', [{ id: 'now', label: () => t('Now {time}', { time: opts.now }) }, ...TIMES.map((x) => ({ id: x.id, label: () => t(x.label) }))], 'now', (id) => { time = id; });
  row('Weather', KINDS.map((k) => ({ id: k, label: () => t(WEATHER[k]) })), weather, (id) => { weather = id; });
  row('Sound', [{ id: 'on', label: () => t('On') }, { id: 'off', label: () => t('Off') }], sound ? 'on' : 'off', (id) => { sound = id === 'on'; });

  const go = el('button', 'ls-go', panel) as HTMLButtonElement;
  let ready = false;
  relabel.push(() => { go.textContent = ready ? t('Start game') : t('Loading…'); });
  go.type = 'button';
  go.disabled = true;
  for (const f of relabel) f();

  // Enables the button; resolves with the choice when it's pressed.
  return {
    ready(): Promise<StartChoice> {
      go.disabled = false;
      ready = true;
      go.textContent = t('Start game');
      go.focus();
      return new Promise((resolve) => go.addEventListener('click', () => {
        const t = TIMES.find((x) => x.id === time);
        resolve({ time: t ? t.sec : null, weather, sound });
      }, { once: true }));
    },
  };
}
