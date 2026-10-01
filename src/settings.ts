import { LANGS, getLang, onLang, setLang, t } from './i18n.ts';
import type { Lang } from './i18n.ts';
import type { Graphics, Choice } from './graphics.ts';
import type { Bus } from './audio.ts';
import { BUSES } from './audio.ts';
import type { Kind } from './weather.ts';
import { describe } from './save.ts';
import type { Slot, SaveData } from './save.ts';
import * as telemetry from './telemetry.ts';

declare const __APP_VERSION__: string; // set by vite.config.js
declare const __APP_BUILT__: string;

// Two buttons in the top right corner: sound on or off, always in view, and the
// settings (language, sound, graphics, weather) in a panel like the start screen's.
// The panel is a modal dialog, so keys don't reach the game while it's open; Escape,
// the cross or a click beside it closes it. M, G and P still work, and the buttons
// follow them. On a phone the credits move in here from that corner.

const GRAPHICS: { id: Choice; label: string }[] = [
  { id: 'auto', label: 'Auto' }, { id: 'ultra', label: 'Ultra' }, { id: 'high', label: 'High' }, { id: 'medium', label: 'Medium' }, { id: 'low', label: 'Low' }, { id: 'lowest', label: 'Lowest' },
];
const WEATHER: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };

const MIX: Record<Bus, string> = { engine: 'Engine', tyres: 'Tyres', horns: 'Horns and sirens', trams: 'Trams', city: 'City and birds', weather: 'Rain and wind', radio: 'Car radio', bangs: 'Bangs' };

const STATISTICS = 'Anonymous statistics';

const SPEAKER = '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>';
const WAVES = '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>';
const CROSS = '<path d="M16 9l6 6M22 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/>';
const SLIDERS = '<path d="M3 7h10M19 7h2M3 17h4M13 17h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/><path d="M16 4.5v5M10 14.5v5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/>';
const icon = (paths: string) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">${paths}</svg>`;

const el = (tag: string, cls: string, parent: HTMLElement, text = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
};

export function setupSettings({ sound, graphics, weather, saves }: {
  sound: { on: boolean; volumes: Record<Bus, number>; setVolume: (b: Bus, v: number) => void; toggle: () => void; radioOn: boolean; setRadio: (on: boolean) => void };
  graphics: Graphics;
  weather: { kinds: Kind[]; get: () => Kind | 'auto'; set: (k: Kind | 'auto') => void };
  // Saved games: the list, saving the game as a new one, loading one (which restarts
  // the page, see main.ts), deleting one and starting again from the beginning.
  saves: { list: () => { slot: Slot; data: SaveData }[]; save: () => void; load: (slot: Slot) => void; remove: (slot: Slot) => void; newGame: () => void };
}) {
  const corner = el('div', 'corner', document.body);
  const mute = el('button', 'corner-btn', corner) as HTMLButtonElement;
  const open = el('button', 'corner-btn', corner) as HTMLButtonElement;
  mute.type = open.type = 'button';
  open.innerHTML = icon(SLIDERS);

  const box = el('dialog', 'settings', document.body) as HTMLDialogElement;
  const head = el('div', 'settings-head', box);
  const title = el('h2', '', head);
  const close = el('button', 'settings-close', head) as HTMLButtonElement;
  close.type = 'button';
  close.textContent = '×';
  const rows = el('div', 'settings-rows', box);

  // Text that follows the language, and the chips that follow the game's state.
  const relabel: (() => void)[] = [];
  const refresh: (() => void)[] = [];

  function row<T extends string>(label: string, items: { id: T; label: () => string }[], current: () => T, pick: (id: T) => void) {
    const r = el('div', 'settings-row', rows);
    const name = el('span', 'settings-label', r);
    relabel.push(() => { name.textContent = t(label); });
    const chips = el('div', 'settings-chips', r);
    const buttons = items.map((it) => {
      const b = el('button', 'settings-chip', chips) as HTMLButtonElement;
      b.type = 'button';
      relabel.push(() => { b.textContent = it.label(); });
      b.addEventListener('click', () => { pick(it.id); if (label !== STATISTICS) telemetry.setting(label, it.id); update(); });
      return { b, id: it.id };
    });
    refresh.push(() => { for (const { b, id } of buttons) b.setAttribute('aria-pressed', String(id === current())); });
    return r;
  }

  const fixed = (s: string) => () => s;
  row<Lang>('Language', LANGS.map((l) => ({ id: l.id, label: fixed(l.label) })), getLang, setLang);
  row('Sound', [{ id: 'on', label: () => t('On') }, { id: 'off', label: () => t('Off') }], () => (sound.on ? 'on' : 'off'), (id) => { if ((id === 'on') !== sound.on) sound.toggle(); });
  row('Car radio', [{ id: 'on', label: () => t('On') }, { id: 'off', label: () => t('Off') }], () => (sound.radioOn ? 'on' : 'off'), (id) => sound.setRadio(id === 'on'));
  row<Choice>('Graphics', GRAPHICS.map((g) => ({ id: g.id, label: () => t(g.label) })), () => graphics.choice, (id) => graphics.set(id));
  row<Kind | 'auto'>('Weather', [{ id: 'auto', label: () => t('Changing') }, ...weather.kinds.map((k) => ({ id: k, label: () => t(WEATHER[k]) }))], weather.get, weather.set);

  // Only where the game sends statistics at all (src/telemetry.ts).
  if (telemetry.available) {
    const r = row(STATISTICS, [{ id: 'on', label: () => t('On') }, { id: 'off', label: () => t('Off') }], () => (telemetry.enabled() ? 'on' : 'off'), (id) => telemetry.setEnabled(id === 'on'));
    const note = el('p', 'settings-note', r);
    relabel.push(() => { note.textContent = t('Tells us how well the game runs for you, which errors come up and what gets played. Nothing in it identifies you.'); });
  }

  // The mixer: one slider per group of sounds, from silent to twice as loud.
  const mixer = el('div', 'settings-row', rows);
  const mixName = el('span', 'settings-label', mixer);
  relabel.push(() => { mixName.textContent = t('Mixer'); });
  for (const b of BUSES) {
    const line = el('label', 'settings-mix', mixer);
    const name = el('span', '', line);
    const slider = el('input', '', line) as HTMLInputElement;
    const pct = el('span', 'settings-mix-pct', line);
    slider.type = 'range';
    slider.min = '0'; slider.max = '200'; slider.step = '5';
    slider.addEventListener('input', () => { sound.setVolume(b, Number(slider.value) / 100); pct.textContent = `${slider.value} %`; });
    slider.addEventListener('keydown', (e) => e.stopPropagation());
    relabel.push(() => { name.textContent = t(MIX[b]); });
    refresh.push(() => { slider.value = String(Math.round(sound.volumes[b] * 100)); pct.textContent = `${slider.value} %`; });
  }

  // The saved games: as many as you like. Loading one, deleting one and starting again
  // take a second press within 3 s, so progress isn't lost by accident.
  const savesBox = el('div', 'settings-row', rows);
  const savesName = el('span', 'settings-label', savesBox);
  relabel.push(() => { savesName.textContent = t('Saved games'); });
  const sure = (b: HTMLButtonElement, label: () => string, act: () => void) => {
    let timer = 0;
    const reset = () => { clearTimeout(timer); timer = 0; b.textContent = label(); };
    b.addEventListener('click', () => {
      if (timer) { reset(); act(); update(); return; }
      b.textContent = t('Sure?');
      timer = window.setTimeout(reset, 3000);
    });
    relabel.push(reset);
    reset();
  };
  const buttons = el('div', 'settings-chips', savesBox);
  const add = el('button', 'settings-chip', buttons) as HTMLButtonElement;
  add.type = 'button';
  relabel.push(() => { add.textContent = t('Save game'); });
  add.addEventListener('click', () => { saves.save(); update(); });
  const again = el('button', 'settings-chip', buttons) as HTMLButtonElement;
  again.type = 'button';
  sure(again, () => t('New game'), () => saves.newGame());
  const list = el('div', 'settings-saves', savesBox);
  refresh.push(() => {
    list.textContent = '';
    for (const { slot, data } of saves.list()) {
      const line = el('div', 'settings-slot', list);
      el('span', 'settings-slot-text', line, describe(data));
      const load = el('button', 'settings-chip', line) as HTMLButtonElement;
      const del = el('button', 'settings-chip', line) as HTMLButtonElement;
      load.type = del.type = 'button';
      sure(load, () => t('Load'), () => saves.load(slot));
      sure(del, () => t('Delete'), () => saves.remove(slot));
    }
  });

  // On a phone the credits live here (their corner has these buttons now).
  const credits = el('button', 'settings-credits', box) as HTMLButtonElement;
  credits.type = 'button';
  relabel.push(() => { credits.textContent = t('Credits and licences'); });
  credits.addEventListener('click', () => {
    box.close();
    document.getElementById('credits')?.click();
  });

  const version = el('p', 'settings-version', box);
  relabel.push(() => { version.textContent = `${t('Version')} ${__APP_VERSION__} · ${__APP_BUILT__}`; });

  function update() {
    mute.innerHTML = icon(SPEAKER + (sound.on ? WAVES : CROSS));
    mute.setAttribute('aria-pressed', String(!sound.on));
    mute.title = mute.ariaLabel = sound.on ? t('Sound on (M)') : t('Sound off (M)');
    open.title = open.ariaLabel = t('Settings');
    title.textContent = t('Settings');
    close.ariaLabel = t('Close');
    for (const f of refresh) f();
  }
  onLang(() => { for (const f of relabel) f(); update(); });

  mute.addEventListener('click', () => {
    mute.blur(); // or Space, the handbrake, would press it again
    sound.toggle();
    update();
  });
  open.addEventListener('click', () => {
    open.blur();
    update();
    box.showModal();
  });
  close.addEventListener('click', () => box.close());
  // While it's open, keys don't reach the game (Escape still closes it).
  box.addEventListener('keydown', (e) => e.stopPropagation());
  box.addEventListener('click', (e) => {
    const r = box.getBoundingClientRect();
    if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) box.close();
  });
  // M, G and P change these from the keyboard: look again once the game has.
  window.addEventListener('keydown', (e) => { if (['KeyM', 'KeyG', 'KeyP'].includes(e.code)) setTimeout(update); });
}
