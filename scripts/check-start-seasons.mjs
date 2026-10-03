#!/usr/bin/env node
// CPU state, date-link and bilingual start-screen regressions. No map or browser.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const NativeDate = Date;
let instant = NativeDate.parse('2026-10-02T22:30:00Z');
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [instant])); }
  static now() { return instant; }
};
const storage = new Map([['lang', 'en'], ['beta-note', 'seen']]);
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) } });
globalThis.location = { search: '?go&lang=en' };
class Element {
  children = []; dataset = {}; hidden = false; attributes = new Map(); listeners = new Map(); className = ''; textContent = '';
  classList = { toggle: () => {}, add: () => {} };
  appendChild(e) { this.children.push(e); return e; }
  get firstChild() { return this.children[0]; }
  insertBefore(e, before) { this.children.splice(this.children.indexOf(before), 0, e); }
  prepend(e) { this.children.unshift(e); }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  addEventListener(k, f) { const listeners = this.listeners.get(k) ?? []; listeners.push(f); this.listeners.set(k, listeners); }
  click() { for (const f of this.listeners.get('click') ?? []) f(); }
  focus() {}
}
globalThis.document = { createElement: () => new Element(), getElementById: () => null, documentElement: {}, querySelectorAll: () => [], addEventListener() {} };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('', { status: 404 });
const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { Season, parseDay, pragueToday, seasonOfDay, seasonStartDay } = await server.ssrLoadModule('/src/season.ts');
  const { startScreen } = await server.ssrLoadModule('/src/startscreen.ts');
  const { setLang } = await server.ssrLoadModule('/src/i18n.ts');
  const { Weather, KINDS, automaticWeather } = await server.ssrLoadModule('/src/weather.ts');
  const { BARE, SEASON } = await server.ssrLoadModule('/src/shading.ts');
  assert.equal(pragueToday(), 276, 'Prague has reached 3 October while UTC is still 2 October');
  assert.equal(seasonStartDay('autumn'), 276);
  for (const [name, date] of [['spring', '04-20'], ['summer', '07-15'], ['winter', '01-15']]) assert.equal(seasonStartDay(name), parseDay(date));
  assert.equal(seasonStartDay('autumn', 15), parseDay('10-20'));
  assert.equal(seasonStartDay('winter', 15), 15);
  assert.equal(new Season(new URLSearchParams('date=04-05&season=summer')).day, parseDay('04-05'));
  assert.equal(new Season(new URLSearchParams('season=autumn')).day, parseDay('10-20'), 'date links retain existing representative-date semantics');
  const fields = w => [w.kind, w.fixed, { ...w.now }, BARE.value, SEASON.value.toArray()];
  const weather = new Weather(new URLSearchParams('weather=rain'), 13 * 3600, new Season(new URLSearchParams()));
  const before = fields(weather), winter = new Season(new URLSearchParams('season=winter'));
  assert.ok(KINDS.includes(weather.preview(13 * 3600, winter)));
  assert.deepEqual(fields(weather), before, 'weather preview does not change current conditions or shader values');
  assert.equal(automaticWeather('mist'), 'cloudy');
  for (const name of ['spring', 'summer', 'autumn', 'winter']) {
    const season = new Season(new URLSearchParams('season=' + name));
    for (const hour of [8, 13]) for (let roll = 0; roll < 100; roll++) {
      weather.rng = () => (roll + 0.5) / 100;
      assert.notEqual(weather.preview(hour * 3600, season), 'mist', 'automatic seasonal roll selected beta mist');
    }
  }
  weather.set('mist', true);
  assert.equal(weather.kind, 'mist', 'manual mist remains available');
  weather.fixed = false;
  weather.update(0, 13 * 3600, 0);
  assert.equal(weather.kind, 'cloudy', 'returning to automatic weather replaces mist');

  const make = (extra = {}) => {
    const root = new Element();
    const screen = startScreen(root, { now: '00:30', season: pragueToday(), dateLinked: false, weather: 'cloudy', weatherFixed: false,
      weatherForSeason: day => seasonOfDay(day) === 'summer' ? 'clear' : 'cloudy', sound: true, saved: null, lost: false, ...extra });
    const panel = root.children[0];
    const row = label => panel.children.find(r => r.children[0]?.textContent === label);
    const button = (label, text) => row(label).children[1].children.find(b => b.textContent === text);
    const go = panel.children.find(r => r.className === 'ls-actions').children[0];
    return { root, screen, panel, row, button, go };
  };
  const current = make(); current.screen.live('rain');
  const beta = make({ weather: 'mist' });
  assert.equal(beta.root.dataset.weather, 'cloudy', 'automatic initial mist becomes cloudy');
  assert.equal(beta.button('Weather', 'Mist (beta)').getAttribute('aria-pressed'), 'false');
  beta.screen.live('mist');
  assert.equal(beta.root.dataset.weather, 'cloudy', 'live fog becomes cloudy');
  assert.equal(beta.button('Weather', 'Now: Cloudy').getAttribute('aria-pressed'), 'true');
  beta.button('Weather', 'Mist (beta)').click();
  assert.equal(beta.root.dataset.weather, 'mist', 'manual beta mist can be selected');
  beta.button('Season', 'Summer').click();
  assert.equal(beta.root.dataset.weather, 'mist', 'manual mist survives a season choice');
  const betaChoice = beta.screen.ready(); beta.go.click();
  assert.equal((await betaChoice).weather, 'mist', 'manual beta mist reaches game launch');
  const previewMist = make({ weatherForSeason: () => 'mist' });
  previewMist.button('Season', 'Summer').click();
  assert.equal(previewMist.root.dataset.weather, 'cloudy', 'automatic season preview replaces mist');
  assert.equal(current.root.dataset.season, 'autumn');
  const live = current.button('Weather', 'Now: Rain');
  assert.equal(live.hidden, false); assert.equal(live.getAttribute('aria-pressed'), 'true');
  current.button('Season', 'Summer').click();
  assert.equal(live.hidden, true); assert.equal(live.getAttribute('aria-pressed'), 'false');
  assert.equal(current.root.dataset.weather, 'clear', 'summer does not inherit automatically selected real weather');
  const chosen = current.screen.ready(); current.go.click();
  assert.equal((await chosen).season, parseDay('07-15'));

  const manual = make({ weatherFixed: true, weather: 'snow' }); manual.screen.live('rain'); manual.button('Season', 'Summer').click();
  assert.equal(manual.root.dataset.weather, 'snow', 'explicit weather survives a season choice');
  const linked = make({ season: parseDay('10-20'), dateLinked: true }); linked.screen.live('rain');
  assert.equal(linked.button('Weather', 'Now: Rain').hidden, true, 'another date in the current season is not today');
  linked.button('Season', 'Autumn').click();
  assert.equal(linked.button('Weather', 'Now: Rain').hidden, false); assert.equal(linked.root.dataset.weather, 'rain');
  const late = make(); late.button('Season', 'Summer').click(); late.screen.live('snow');
  assert.equal(late.root.dataset.weather, 'clear', 'late live-weather response cannot replace another season');
  assert.equal(late.button('Weather', 'Now: Snow').hidden, true);

  const saved = make({ saved: () => 'Karlova · on foot', savedLook: { clock: 19 * 3600, weather: 'snow', season: 15 } });
  assert.equal(saved.root.dataset.season, 'winter'); assert.equal(saved.root.dataset.weather, 'snow'); assert.equal(saved.row('Season').hidden, true);
  const resumed = saved.screen.ready(); saved.go.click();
  assert.deepEqual([(await resumed).resume, (await resumed).season], [true, 15]);
  const fresh = make({ saved: () => 'Karlova · on foot', savedLook: { clock: 19 * 3600, weather: 'snow', season: 15 } });
  fresh.panel.children.find(r => r.className === 'ls-actions').children[1].click();
  assert.equal(fresh.row('Season').hidden, false); assert.equal(fresh.root.dataset.season, 'autumn');
  setLang('cs');
  assert.ok(fresh.button('Počasí', 'Mlha (beta)'));
  assert.deepEqual(fresh.row('Roční období').children[1].children.map(b => b.textContent), ['Jaro', 'Léto', 'Podzim', 'Zima']);
  assert.equal(fresh.row('Roční období').children[1].getAttribute('aria-label'), 'Roční období');
  fresh.button('Roční období', 'Jaro').click(); assert.equal(fresh.root.dataset.season, 'spring');
  setLang('en'); assert.equal(fresh.button('Season', 'Spring').getAttribute('aria-pressed'), 'true');
  const overnight = make(); overnight.screen.live('snow');
  const unchangedLink = make({ season: 276, dateLinked: true });
  const defaultToday = make();
  instant += 86400 * 1000;
  const actualStart = defaultToday.screen.ready(); defaultToday.go.click();
  assert.equal((await actualStart).season, 277, 'default date is today at game start, not page opening');
  const exactLink = unchangedLink.screen.ready(); unchangedLink.go.click();
  assert.equal((await exactLink).season, 276, 'explicit date link stays fixed across midnight');
  overnight.button('Season', 'Autumn').click();
  const nextDay = overnight.screen.ready(); overnight.go.click();
  assert.equal((await nextDay).season, 277, 'current-season click uses today even after the page crossed midnight');
  assert.equal(overnight.button('Weather', 'Now: Snow').hidden, true, 'yesterday\'s live forecast is no longer offered');
  assert.equal(overnight.root.dataset.weather, 'cloudy');
  const acrossNote = make();
  const afterNote = acrossNote.screen.ready(); acrossNote.go.click();
  instant += 86400 * 1000;
  assert.equal((await afterNote).season, 278, 'today is read after the asynchronous beta note completes');
  console.log('Start seasons: Prague date, four choices, URL priority, live-weather eligibility/race, explicit weather, save/new game, English/Czech and unchanged weather-preview state passed.');
} finally {
  globalThis.Date = NativeDate;
  globalThis.fetch = originalFetch;
  await server.close();
}
