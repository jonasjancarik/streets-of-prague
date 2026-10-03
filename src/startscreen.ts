import { KINDS } from './weather.ts';
import type { Kind } from './weather.ts';
import { LANGS, getLang, onLang, setLang, t } from './i18n.ts';
import type { Lang } from './i18n.ts';
import { newsletterLink } from './newsletter.ts';
import { updateNotice } from './update.ts';
import { betaNote } from './betanote.ts';
import { SEASONS, pragueToday, seasonOfDay, seasonStartDay } from './season.ts';
import type { SeasonName } from './season.ts';

// The start of the game, on the loading screen: the date, time and weather it will begin
// with (the time in Prague now and a weather picked for the season, if nothing was
// asked for in the URL), each one changeable, and sound on or off. The button stays
// grey while the map loads, and pressing it is also what lets the browser play sound.
// With a saved game, the button continues it (date, time and weather come from the save)
// and "New game" brings those choices back.

const TIMES: { id: string; label: string; sec: number }[] = [
  { id: 'morning', label: 'Morning', sec: 8 * 3600 },
  { id: 'midday', label: 'Midday', sec: 13 * 3600 },
  { id: 'evening', label: 'Evening', sec: 19 * 3600 },
  { id: 'night', label: 'Night', sec: 1.5 * 3600 },
];
const WEATHER: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };
const SEASON_NAMES: Record<SeasonName, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };

export interface StartChoice {
  // Seconds since midnight, or null to keep the clock as it is (the time now).
  time: number | null;
  weather: Kind;
  sound: boolean;
  // Day of the year, including the saved date when continuing.
  season: number;
  // Carry on from the saved game (time and weather are then the save's own).
  resume: boolean;
}

const el = (tag: string, cls: string, parent: HTMLElement, text = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
};

interface StartOptions {
  now: string;
  season: number;
  dateLinked: boolean;
  weather: Kind;
  weatherFixed: boolean;
  weatherForSeason: (day: number) => Kind;
  sound: boolean;
  saved: (() => string) | null;
  savedLook?: { clock: number; weather: Kind; season?: number };
  lost: boolean;
}

export function startScreen(root: HTMLElement, opts: StartOptions) {
  const panel = el('div', 'ls-start', root);
  let time: string = 'now', weather: Kind = opts.weather, sound = opts.sound;
  let weatherPicked = opts.weatherFixed, usingLive = false;
  let day = opts.season, liveKind: Kind | null = null, liveButton: HTMLButtonElement | null = null;
  let useToday = !opts.dateLinked;
  let liveDay: number | null = null;
  const liveAvailable = () => { const today = pragueToday(); return day === today && liveDay === today; };
  let resuming = !!opts.saved;

  // The poster behind shows what is picked: the sky's light for the time of day, and
  // the weather over it (index.html). "Now" shows the part of the day it is now.
  // Carrying on a saved game shows the save's own time and weather.
  const part = (hour: number) => hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'midday' : hour >= 17 && hour < 21 ? 'evening' : 'night';
  const nowPart = part(Number(opts.now.split(':')[0]));
  const show = () => {
    const look = resuming ? opts.savedLook : undefined;
    root.dataset.time = look ? part(Math.floor((look.clock % 86400) / 3600)) : time === 'now' ? nowPart : time;
    root.dataset.weather = look ? look.weather : weather;
    root.dataset.season = seasonOfDay(look?.season ?? day);
    if (liveButton) liveButton.hidden = !liveAvailable();
  };

  // Text that follows the language: each is given again when it changes.
  const relabel: (() => void)[] = [];
  onLang(() => { for (const f of relabel) f(); });

  // A row of buttons of which one is picked.
  function row<T extends string>(label: string, items: { id: T; label: () => string }[], picked: T, pick: (id: T) => void) {
    const r = el('div', 'ls-row', panel);
    const name = el('span', 'ls-label', r);
    relabel.push(() => { name.textContent = t(label); });
    const chips = el('div', 'ls-chips', r);
    chips.setAttribute('role', 'group');
    relabel.push(() => chips.setAttribute('aria-label', t(label)));
    const buttons = items.map((it) => {
      const b = el('button', 'ls-chip', chips) as HTMLButtonElement;
      relabel.push(() => { b.textContent = it.label(); });
      b.type = 'button';
      b.setAttribute('aria-pressed', String(it.id === picked));
      b.addEventListener('click', () => {
        pick(it.id);
        for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
        show();
      });
      return b;
    });
    return { chips, buttons, pick, row: r };
  }

  const fixed = (s: string) => () => s;
  row<Lang>('Language', LANGS.map((l) => ({ id: l.id, label: fixed(l.label) })), getLang(), setLang);
  const seasonRow = row('Season', SEASONS.map(id => ({ id, label: () => t(SEASON_NAMES[id]) })), seasonOfDay(day), (id) => {
    const today = pragueToday();
    day = seasonStartDay(id, today);
    useToday = id === seasonOfDay(today);
    if (!weatherPicked || usingLive) {
      usingLive = liveAvailable() && liveKind !== null;
      weather = usingLive ? liveKind! : opts.weatherForSeason(day);
      weatherPicked = false;
      syncWeather();
    }
  });
  const timeRow = row('Time', [{ id: 'now', label: () => t('Now {time}', { time: opts.now }) }, ...TIMES.map((x) => ({ id: x.id, label: () => t(x.label) }))], 'now', (id) => { time = id; });
  const weatherRow = row('Weather', KINDS.map((k) => ({ id: k, label: () => t(WEATHER[k]) })), weather, (id) => { weather = id; weatherPicked = true; usingLive = false; });
  const syncWeather = () => {
    weatherRow.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(!usingLive && KINDS[i] === weather)));
    liveButton?.setAttribute('aria-pressed', String(usingLive));
  };
  row('Sound', [{ id: 'on', label: () => t('On') }, { id: 'off', label: () => t('Off') }], sound ? 'on' : 'off', (id) => { sound = id === 'on'; });

  // The saved game as a card: where you were, big, and the rest (on foot, the time,
  // money, how long ago) on a line under it.
  const found = el('div', 'ls-saved', panel);
  panel.insertBefore(found, panel.firstChild);
  const foundLabel = el('span', 'ls-saved-label', found);
  const foundPlace = el('span', 'ls-saved-place', found);
  const foundInfo = el('span', 'ls-saved-info', found);
  relabel.push(() => {
    const [place, ...rest] = opts.saved ? opts.saved().split(' · ') : [''];
    foundLabel.textContent = t('Saved game');
    foundPlace.textContent = place;
    foundInfo.textContent = rest.join(' · ');
  });
  // A save this version can't open: said so, and kept in the browser, not dropped.
  const lost = el('div', 'ls-lost', panel);
  relabel.push(() => { lost.textContent = opts.lost ? t('The saved game from an earlier version can’t be opened.') : ''; });
  lost.hidden = !opts.lost;
  const actions = el('div', 'ls-actions', panel);
  const go = el('button', 'ls-go', actions) as HTMLButtonElement;
  const fresh = el('button', 'ls-new', actions) as HTMLButtonElement;
  let ready = false;
  const sync = () => {
    panel.classList.toggle('resume', resuming);
    found.hidden = fresh.hidden = !resuming;
    for (const r of [seasonRow.row, timeRow.row, weatherRow.row]) r.hidden = resuming;
    go.textContent = !ready ? t('Loading…') : resuming ? t('Continue') : opts.saved ? t('Start new game') : t('Start game');
    fresh.textContent = t('New game');
  };
  relabel.push(sync);
  go.type = fresh.type = 'button';
  fresh.addEventListener('click', () => { resuming = false; sync(); show(); go.focus(); });
  go.disabled = true;
  newsletterLink(panel, 'ls-news', { thanks: true });
  updateNotice(panel, 'ls-update');
  for (const f of relabel) f();
  show();

  // Enables the button; resolves with the choice when it's pressed.
  return {
    // The weather in Prague now has come in: a button for it, first, and picked unless
    // the player has picked something already.
    live(kind: Kind) {
      if (liveButton) return;
      liveKind = kind;
      liveDay = pragueToday();
      const b = liveButton = el('button', 'ls-chip', weatherRow.chips) as HTMLButtonElement;
      weatherRow.chips.prepend(b);
      relabel.push(() => { b.textContent = t('Now: {weather}', { weather: t(WEATHER[kind]) }); });
      b.type = 'button';
      const choose = () => {
        if (!liveAvailable()) { show(); return false; }
        weather = kind;
        usingLive = true;
        syncWeather();
        show();
        return true;
      };
      weatherRow.buttons.push(b);
      b.addEventListener('click', () => { if (choose()) weatherPicked = true; });
      relabel[relabel.length - 1]();
      if (!weatherPicked && liveAvailable()) choose();
      show();
    },
    // `noteAgain` shows the beta note even if it has been seen (?menu).
    ready(noteAgain = false): Promise<StartChoice> {
      go.disabled = false;
      ready = true;
      sync();
      go.focus();
      // The first time, the beta note comes between the button and the game.
      return new Promise((resolve) => go.addEventListener('click', () => {
        go.disabled = true;
        const t = TIMES.find((x) => x.id === time);
        void betaNote(noteAgain).then(() => {
          const startDay = resuming ? opts.savedLook?.season ?? day : useToday ? pragueToday() : day;
          // A page or beta note kept open across midnight still starts in today's Prague.
          const startWeather = !resuming && startDay !== day && (!weatherPicked || usingLive) ? opts.weatherForSeason(startDay) : weather;
          resolve({ time: t ? t.sec : null, weather: startWeather, sound, season: startDay, resume: resuming });
        });
      }, { once: true }));
    },
  };
}
