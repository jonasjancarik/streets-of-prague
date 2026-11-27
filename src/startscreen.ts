import { KINDS, automaticWeather } from './weather.ts';
import type { Kind } from './weather.ts';
import type { StartSources } from './telemetry.ts';
import { LANGS, getLang, onLang, setLang, t } from './i18n.ts';
import { newsletterLink } from './newsletter.ts';
import { updateNotice } from './update.ts';
import { graphicsWarning } from './graphicswarning.ts';
import { betaNote } from './betanote.ts';
import { testVersionNotice } from './testversion.ts';
import { SEASONS, pragueToday, seasonOfDay, seasonStartDay } from './season.ts';
import type { SeasonName } from './season.ts';
import { pickStart } from './startmap.ts';
import type { StartSpot } from './startmap.ts';
import type { PlayerView } from './streetView.ts';
import { leftLabel } from './loadProgress.ts';
import { CHOICES, type Choice, type Tier } from './graphics.ts';

// The start of the game, on the loading screen: where it begins (a random street, or a
// spot picked on a map of Prague, startmap.ts), the date, time and weather it will begin
// with (the time in Prague now and a weather picked for the season, if nothing was
// asked for in the URL), each one changeable, and how you see the city (from above, or
// from the street in first or third person: the settings' Camera view, remembered), and
// the graphics setting (the settings' own). The rarely changed ones, sound and language,
// are quiet toggles in the line of links at the bottom. While the map loads the button
// fills up with how far it has got and the time left (loadProgress.ts), and pressing it
// is also what lets the browser play sound. With a saved game, the button continues it
// (date, time and weather come from the save, the view and graphics are still yours to
// pick) and "New game" brings the
// other choices back. VR isn't one of the views here: it needs the page loaded again
// (renderer.ts), so it keeps its own button, Play in VR, where the phone can show it.

const TIMES: { id: string; label: string; sec: number }[] = [
  { id: 'morning', label: 'Morning', sec: 8 * 3600 },
  { id: 'midday', label: 'Midday', sec: 13 * 3600 },
  { id: 'evening', label: 'Evening', sec: 19 * 3600 },
  { id: 'night', label: 'Night', sec: 1.5 * 3600 },
];
const WEATHER: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };
const SEASON_NAMES: Record<SeasonName, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };
// The views on offer here: all but VR (see above).
export type StartView = Exclude<PlayerView, 'vr'>;
const VIEWS: { id: StartView; label: string }[] = [
  { id: 'overhead', label: 'From above' },
  { id: 'first', label: 'First person' },
  { id: 'third', label: 'Third person' },
];

export interface StartChoice {
  // Seconds since midnight, or null to keep the clock as it is (the time now).
  time: number | null;
  weather: Kind;
  sources: StartSources;
  // The weather is the real one in Prague now ("Live: …"), for the game to keep following.
  live: boolean;
  sound: boolean;
  // Day of the year, including the saved date when continuing.
  season: number;
  // Carry on from the saved game (time and weather are then the save's own).
  resume: boolean;
  // Where to begin, as [lon, lat], from the link or the map; null for a random street.
  at: [number, number] | null;
  // Straight into the headset (the page was opened for VR and Start in VR was pressed).
  vr: boolean;
  // How you see the city once the game begins (when not in the headset).
  view: StartView;
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
  linkedStart: [number, number] | null;
  season: number;
  dateLinked: boolean;
  timeLinked: boolean;
  weather: Kind;
  weatherFixed: boolean;
  sound: boolean;
  saved: (() => string) | null;
  savedLook?: { clock: number; weather: Kind; season?: number };
  lost: boolean;
  // The view picked last time (streetView.ts's initialView), from above if none.
  view?: PlayerView;
  // VR (vr.ts): whether this page was opened for it, whether the phone can show it, and
  // how to switch to it (a reload: VR needs the WebGL renderer, renderer.ts).
  vr?: { mode: boolean; supported: Promise<boolean>; pick: () => void };
  // Told each time View changes, so a street view can start loading what it needs.
  onView?: (view: StartView) => void;
  // The graphics setting (graphics.ts), the same as in the settings, and who to tell when
  // it changes (at once: the game applies it while it loads).
  graphics?: { choice: Choice; pick: (choice: Choice) => void };
}

export function startScreen(root: HTMLElement, opts: StartOptions) {
  const panel = el('div', 'ls-start', root);
  // Clear unless the URL asked for another: the real weather is offered beside it, and the
  // game's own weather changes by itself only once the game is under way.
  let time: string = 'now', weather: Kind = opts.weatherFixed ? opts.weather : 'clear', sound = opts.sound;
  let usingLive = false;
  const sources: StartSources = {
    weatherSource: opts.weatherFixed ? 'link' : 'default',
    monthSource: opts.dateLinked ? 'link' : 'default',
    hourSource: opts.timeLinked ? 'link' : 'default',
  };
  let day = opts.season, liveButton: HTMLButtonElement | null = null;
  let useToday = !opts.dateLinked;
  let liveDay: number | null = null;
  const liveAvailable = () => { const today = pragueToday(); return day === today && liveDay === today; };
  let resuming = !!opts.saved;
  let spot: StartSpot | null = null;
  let view: StartView = opts.view === 'first' || opts.view === 'third' ? opts.view : 'overhead';

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
  function row<T extends string>(label: string, items: { id: T; label: () => string }[], picked: T, pick: (id: T) => void | false) {
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
        if (pick(it.id) !== false) for (const o of buttons) o.setAttribute('aria-pressed', String(o === b));
        show();
      });
      return b;
    });
    return { chips, buttons, pick, row: r };
  }

  type PlaceChoice = 'link' | 'random' | 'map';
  let place: PlaceChoice = opts.linkedStart ? 'link' : 'random';
  const places: { id: PlaceChoice; label: () => string }[] = [
    { id: 'random', label: () => t('Random street') },
    { id: 'map', label: () => spot ? spot.name : t('Pick on the map') },
  ];
  if (opts.linkedStart) places.unshift({ id: 'link', label: () => t('Location from link') });
  const placeRow = row('Place', places, place, (id) => {
    if (id === 'map') {
      void pickStart(root, spot).then((s) => {
        if (s) { spot = s; place = 'map'; }
        showPlace();
        placeRow.buttons[places.findIndex((p) => p.id === place)].focus();
      });
    } else {
      place = id;
      spot = null;
      showPlace();
    }
    return false;
  });
  // Where the camera is: above the city, or down in the street. On a page opened for VR the
  // headset is the view, and Play without VR starts from above, as it always has.
  const viewRow = row<StartView>('View', VIEWS.map((v) => ({ id: v.id, label: () => t(v.label) })), view, (id) => { view = id; opts.onView?.(id); });
  viewRow.row.hidden = !!opts.vr?.mode;
  // How detailed the city looks. Auto adjusts to keep the game smooth, and says which level
  // it's on once the game knows the graphics chip (autoTier).
  let autoNow: Tier | null = null;
  const tierName = (tier: string) => t(tier[0].toUpperCase() + tier.slice(1));
  const graphicsRow = opts.graphics ? row<Choice>('Graphics', CHOICES.map((id) => ({
    id, label: () => id === 'auto' ? (autoNow ? t('Auto ({tier})', { tier: tierName(autoNow).toLowerCase() }) : t('Auto')) : tierName(id),
  })), opts.graphics.choice, (id) => { opts.graphics!.pick(id); }) : null;
  const showPlace = () => {
    placeRow.buttons.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(places[i].id === place));
      b.textContent = places[i].label();
    });
  };
  const seasonRow = row('Season', SEASONS.map(id => ({ id, label: () => t(SEASON_NAMES[id]) })), seasonOfDay(day), (id) => {
    const today = pragueToday();
    sources.monthSource = 'player';
    day = seasonStartDay(id, today);
    useToday = id === seasonOfDay(today);
    // The real weather is today's only: another season goes back to Clear.
    if (usingLive && !liveAvailable()) {
      usingLive = false;
      sources.weatherSource = 'default';
      weather = 'clear';
      syncWeather();
    }
  });
  const timeRow = row('Time', [{ id: 'now', label: () => t('Now {time}', { time: opts.now }) }, ...TIMES.map((x) => ({ id: x.id, label: () => t(x.label) }))], 'now', (id) => {
    time = id;
    sources.hourSource = id === 'now' && opts.timeLinked ? 'link' : 'player';
  });
  const weatherRow = row('Weather', KINDS.map((k) => ({ id: k, label: () => k === 'mist' ? `${t(WEATHER[k])} (beta)` : t(WEATHER[k]) })), weather, (id) => {
    weather = id;
    sources.weatherSource = 'player';
    usingLive = false;
  });
  const syncWeather = () => {
    weatherRow.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(!usingLive && KINDS[i] === weather)));
    liveButton?.setAttribute('aria-pressed', String(usingLive));
  };

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
  // Play in VR, where the phone can show it; on a page opened for VR, Play without VR.
  const vrMode = !!opts.vr?.mode;
  const vrButton = el('button', 'ls-new', actions) as HTMLButtonElement;
  vrButton.type = 'button';
  vrButton.hidden = true;
  if (opts.vr) void opts.vr.supported.then((ok) => { vrButton.hidden = !ok && !vrMode; });
  if (!vrMode) vrButton.addEventListener('click', () => opts.vr?.pick());
  // While the map loads, the button fills up and says how far along it is, with the time
  // left on a line under the buttons.
  const eta = el('div', 'ls-eta', panel);
  panel.insertBefore(eta, actions.nextSibling);
  let ready = false, loaded: number | null = null, left: number | null = null;
  const sync = () => {
    panel.classList.toggle('resume', resuming);
    found.hidden = fresh.hidden = !resuming;
    for (const r of [placeRow.row, seasonRow.row, timeRow.row, weatherRow.row]) r.hidden = resuming;
    const loading = loaded !== null && loaded < 1;
    go.style.setProperty('--p', String(loading ? loaded : 0));
    go.toggleAttribute('data-loading', loading);
    eta.textContent = loading ? leftLabel(left) : '';
    eta.hidden = !loading;
    go.textContent = loading ? t('Loading {n} %', { n: Math.floor(loaded! * 100) }) : !ready ? t('Loading…') : vrMode ? (resuming ? t('Continue in VR') : t('Start in VR')) : resuming ? t('Continue') : opts.saved ? t('Start new game') : t('Start game');
    fresh.textContent = t('New game');
    vrButton.textContent = vrMode ? t('Play without VR') : t('Play in VR');
    if (vrMode) vrButton.disabled = !ready;
  };
  relabel.push(sync);
  go.type = fresh.type = 'button';
  fresh.addEventListener('click', () => { resuming = false; sync(); show(); go.focus(); });
  go.disabled = true;
  // Sound and language as quiet toggles, then news by email and the code on GitHub, all on
  // one line, so the menu stays short enough to clear a phone browser's bottom bar.
  const links = el('div', 'ls-links', panel);
  const soundButton = el('button', 'ls-news ls-toggle', links) as HTMLButtonElement;
  soundButton.type = 'button';
  const soundIcon = (on: boolean) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 5.5h2.6L8.5 2v12L4.6 10.5H2z"/>${on
    ? '<path d="M10.6 5.4a3.6 3.6 0 0 1 0 5.2M12.4 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    : '<path d="M10.5 6l4 4m0-4l-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'}</svg>`;
  const showSound = () => {
    soundButton.innerHTML = soundIcon(sound);
    soundButton.append(t(sound ? 'Sound on' : 'Sound off'));
    soundButton.setAttribute('aria-pressed', String(sound));
  };
  soundButton.addEventListener('click', () => { sound = !sound; showSound(); });
  relabel.push(showSound);
  // The other language, in its own words, as sites usually offer it.
  const langButton = el('button', 'ls-news ls-toggle', links) as HTMLButtonElement;
  langButton.type = 'button';
  const otherLang = () => LANGS.find((l) => l.id !== getLang()) ?? LANGS[0];
  relabel.push(() => {
    const other = otherLang();
    langButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M1.7 8h12.6M8 1.7c-3.4 3.6-3.4 9 0 12.6M8 1.7c3.4 3.6 3.4 9 0 12.6"/></g></svg>';
    langButton.append(other.label);
    langButton.lang = other.id;
    langButton.title = t('Language');
  });
  langButton.addEventListener('click', () => { setLang(otherLang().id); langButton.focus(); });
  newsletterLink(links, 'ls-news', { thanks: true });
  const code = el('a', 'ls-news ls-code', links) as HTMLAnchorElement;
  code.href = 'https://github.com/jonasjancarik/streets-of-prague';
  code.target = '_blank';
  code.rel = 'noopener';
  code.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub';
  relabel.push(() => { code.title = t('The game on GitHub'); });
  updateNotice(panel, 'ls-update');
  testVersionNotice(panel);
  graphicsWarning(panel, 'ls-warn');
  for (const f of relabel) f();
  show();

  // Enables the button; resolves with the choice when it's pressed.
  return {
    // The view picked so far.
    view: () => view,
    // The level Auto starts at, for its button.
    autoTier(tier: Tier) {
      autoNow = tier;
      if (graphicsRow) graphicsRow.buttons[CHOICES.indexOf('auto')].textContent = t('Auto ({tier})', { tier: tierName(tier).toLowerCase() });
    },
    // How far loading has got (loadProgress.ts); 1 when done.
    progress(share: number, secondsLeft: number | null) {
      loaded = share;
      left = secondsLeft;
      sync();
    },
    // The weather in Prague now has come in: a button for it, after Clear.
    live(kind: Kind) {
      if (liveButton) return;
      kind = automaticWeather(kind);
      liveDay = pragueToday();
      const b = liveButton = el('button', 'ls-chip', weatherRow.chips) as HTMLButtonElement;
      weatherRow.chips.insertBefore(b, weatherRow.buttons[1]);
      relabel.push(() => { b.textContent = t('Live: {weather}', { weather: t(WEATHER[kind]) }); });
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      weatherRow.buttons.push(b);
      b.addEventListener('click', () => {
        if (!liveAvailable()) { show(); return; }
        sources.weatherSource = 'player';
        weather = kind;
        usingLive = true;
        syncWeather();
        show();
      });
      relabel[relabel.length - 1]();
      show();
    },
    // `noteAgain` shows the beta note even if it has been seen (?menu).
    ready(noteAgain = false): Promise<StartChoice> {
      go.disabled = false;
      ready = true;
      sync();
      go.focus();
      // The first time, the beta note comes between the button and the game.
      return new Promise((resolve) => {
        let begun = false;
        const begin = (inVR: boolean) => {
          if (begun) return;
          begun = true;
          go.disabled = true;
          if (vrMode) vrButton.disabled = true;
          const t = TIMES.find((x) => x.id === time);
          void betaNote(noteAgain).then(() => {
            const startDay = resuming ? opts.savedLook?.season ?? day : useToday ? pragueToday() : day;
            // A page or beta note kept open across midnight still starts in today's Prague.
            const liveExpired = !resuming && startDay !== day && usingLive;
            const startWeather = liveExpired ? 'clear' : weather;
            const startSources: StartSources = { ...sources, weatherSource: liveExpired ? 'default' : sources.weatherSource };
            const at: StartChoice['at'] = resuming ? null : place === 'link' ? opts.linkedStart : spot ? [spot.lon, spot.lat] : null;
            resolve({ time: t ? t.sec : null, weather: startWeather, sources: startSources, live: !resuming && usingLive && startWeather === weather && liveAvailable(), sound, season: startDay, resume: resuming, at, vr: inVR, view: vrMode ? 'overhead' : view });
          });
        };
        go.addEventListener('click', () => begin(vrMode));
        if (vrMode) vrButton.addEventListener('click', () => begin(false));
      });
    },
  };
}
