import { dataUrl } from './data.ts';
import proj4 from 'proj4';
import type * as Leaflet from 'leaflet';
import type { MapIndex } from './contracts.ts';
import type { Point2 } from './map/geo.ts';
import type { Graphics, Choice } from './graphics.ts';
import { MIST, MIST_DEFAULT, MOST_SHEETS, type Kind, type Mist } from './weather.ts';
import type { Testkit } from './testkit.ts';

interface DevHit { label: string; x: number; y: number }
interface StreetName { name: string; key: string; x: number; y: number }

// Developer panel (` key or ?dev): jump to a street, an address, coordinates or a
// Google Maps / Mapy.cz link, or pick a spot on a map; see where you are on those maps;
// set the time of day, the weather and the graphics; and the testing tools (pause, slow
// motion, money, stars, scenarios). Street names come from the area's own index
// (offline); addresses are looked up on OpenStreetMap's Nominatim only when you ask.

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Latitude and longitude from what you paste: "50.0873, 14.4206" (either way round:
// in Prague the latitude is the bigger number), or a Google Maps or Mapy.cz link.
export function parseSpot(q: string): Point2 | null {
  const at = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(q);
  if (at) return [+at[1], +at[2]];
  if (/^https?:/.test(q)) {
    try {
      const u = new URL(q), x = u.searchParams.get('x'), y = u.searchParams.get('y');
      if (x && y && Number.isFinite(+x) && Number.isFinite(+y)) return [+y, +x];
      q = u.searchParams.get('query') ?? u.searchParams.get('q') ?? u.searchParams.get('viewpoint') ?? '';
    } catch { return null; }
  }
  const m = /^\s*(-?\d{1,3}\.\d{3,})°?\s*[NS]?\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})°?\s*[EW]?\s*$/i.exec(q);
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return a >= b ? [a, b] : [b, a];
}

const fixed = (lat: number, lon: number) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
export const googleMaps = (lat: number, lon: number) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
export const streetView = (lat: number, lon: number, heading: number) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lon.toFixed(6)}&heading=${Math.round(heading)}`;
export const mapyCz = (lat: number, lon: number) => `https://mapy.com/zakladni?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&z=19&source=coor&id=${lon.toFixed(6)}%2C${lat.toFixed(6)}`;

export function setupDev({ area, index, teleport, position, helicopter, setFire, setHurt, backOnRoad, timeOfDay, setTimeOfDay, graphics, season, weather }: {
  area: string; index: MapIndex; teleport: (x: number, y: number) => Promise<void>;
  position: () => Point2; helicopter: () => boolean; setFire: () => boolean; setHurt: () => boolean; backOnRoad: () => void;
  // Seconds since midnight on the game's clock.
  timeOfDay: () => number; setTimeOfDay: (sec: number) => void;
  graphics: Graphics;
  // The game's date, as a day of the year (season.ts).
  season: { day: () => number; set: (day: number) => void; label: () => string };
  // The weather picked, or 'auto' while it changes by itself.
  weather: { kinds: string[]; get: () => string; set: (kind: Kind | 'auto') => void; label: () => string };
}) {
  const [w, s, e, n] = index.bbox_wgs84;
  const local = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const toLocal = (lon: number, lat: number): Point2 => proj4('EPSG:4326', local, [lon, lat]) as Point2;
  const toLonLat = (x: number, y: number): Point2 => proj4(local, 'EPSG:4326', [x, y]) as Point2;
  let names: StreetName[] | null = null;
  let bench: ReturnType<typeof setupBench> | null = null;
  // Where the free camera looks while it's on; otherwise where you are.
  const here = (): Point2 => bench?.spot() ?? position();
  const loadNames = async () => {
    if (!names) {
      const r = await fetch(dataUrl(area, 'names.json'));
      const obj: unknown = r.ok ? await r.json() : {};
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('Invalid street names');
      names = Object.entries(obj).filter((entry): entry is [string, Point2] =>
        Array.isArray(entry[1]) && entry[1].length === 2 && entry[1].every((n) => typeof n === 'number'))
        .map(([name, [x, y]]) => ({ name, key: fold(name), x, y }));
    }
    return names;
  };

  const panel = document.createElement('div');
  panel.id = 'dev';
  panel.className = 'panel';
  panel.innerHTML = `
    <div class="dev-title">Developer tools <kbd>\`</kbd></div>
    <input id="dev-q" type="search" placeholder="Street, address, coordinates or a map link" autocomplete="off" />
    <div id="dev-results"></div>
    <div class="dev-row">
      <button id="dev-map">Pick a spot on the map</button>
      <button id="dev-link" title="Copies a link that starts the game here">Copy link to this spot</button>
    </div>
    <div class="dev-row dev-here">
      <span id="dev-pos"></span>
      <button id="dev-copy" title="Copies your latitude and longitude, e.g. to paste into a conversation">Copy coordinates</button>
    </div>
    <div class="dev-row">
      <a id="dev-google" target="_blank" rel="noopener">Google Maps</a>
      <a id="dev-street" target="_blank" rel="noopener" title="Google Street View here, looking the way you face">Street View</a>
      <a id="dev-mapy" target="_blank" rel="noopener">Mapy.cz</a>
    </div>
    <div class="dev-row">
      <button id="dev-heli" title="Walk up to it and press E to fly it">Helicopter next to me</button>
      <button id="dev-road" title="Puts the car you are driving back on the nearest road">Back on the road</button>
      <button id="dev-fire" title="The fire brigade comes from out of view">Set the nearest car on fire</button>
      <button id="dev-hurt" title="An ambulance comes from out of view">Leave the nearest person hurt</button>
    </div>
    <label class="dev-time">Time of day <span id="dev-time-label"></span>
      <input id="dev-time" type="range" min="0" max="1439" step="5" title="The trams follow the timetable for the new time" />
    </label>
    <label class="dev-time">Date <span id="dev-date-label"></span>
      <input id="dev-date" type="range" min="1" max="365" step="1" title="The trees, the sun and the weather follow the date" />
    </label>
    <label class="dev-time">Graphics <span id="dev-graphics-label"></span>
      <select id="dev-graphics">
        <option value="auto">Auto</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="lowest">Lowest</option>
      </select>
    </label>
    <label class="dev-time">Weather <span id="dev-weather-label"></span>
      <select id="dev-weather">
        <option value="auto">Changing by itself</option>${weather.kinds.map((k) => `<option value="${k}">${k[0].toUpperCase()}${k.slice(1)}</option>`).join('')}
      </select>
    </label>
    <details id="dev-mist">
      <summary>Mist</summary>
      <div id="dev-mist-rows"></div>
      <div class="dev-row">
        <button id="dev-mist-copy" title="Copies the values, to paste into a conversation or into src/weather.ts">Copy values</button>
        <button id="dev-mist-reset" title="Back to the values the game ships with">Reset</button>
      </div>
      <div class="dev-note">Your changes stay in this browser until you press Reset.</div>
    </details>
    <div id="dev-bench"></div>`;
  panel.style.maxHeight = 'calc(100vh - 32px)';
  panel.style.overflowY = 'auto';
  const style = document.createElement('style');
  style.textContent = `
    #dev a { color: var(--ink); opacity: 0.85; font-size: 13px; }
    #dev .dev-here { align-items: center; }
    #dev .dev-here span { flex: 1; font-variant-numeric: tabular-nums; }
    #dev .dev-sub { font-weight: 600; margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.15); }
    #dev input[type=number] { width: 90px; padding: 4px 6px; }
    #dev .dev-check { display: flex; gap: 6px; align-items: center; }
    #dev .dev-check input { margin: 0; }
    #dev-mist summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
    #dev-mist .dev-time span { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.8; }
    #dev .dev-pass { color: #8fd18f; } #dev .dev-fail { color: #ff8f7a; }
    #dev-out { font-size: 12px; white-space: pre-wrap; max-height: 220px; overflow: auto; }`;
  document.head.appendChild(style);
  panel.hidden = true;
  document.body.appendChild(panel);
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing developer control: ${id}`);
    return el;
  };
  const results = $('dev-results');
  const query = $('dev-q');
  if (!(query instanceof HTMLInputElement)) throw new Error('Developer search field is missing');

  const flash = (el: HTMLElement, now: string, then: string) => {
    el.textContent = now;
    setTimeout(() => { el.textContent = then; }, 1500);
  };
  const go = async (x: number, y: number, label: string) => {
    results.innerHTML = `<div class="dev-note">Going to ${label}…</div>`;
    if (bench?.free()) { const [lon, lat] = toLonLat(x, y); await bench.look(lat, lon); } else await teleport(x, y);
    results.innerHTML = '';
  };
  const show = (items: DevHit[], note = '') => {
    results.innerHTML = note ? `<div class="dev-note">${note}</div>` : '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'dev-hit';
      b.textContent = it.label;
      b.onclick = () => go(it.x, it.y, it.label);
      results.appendChild(b);
    }
  };

  // Streets as you type; the whole address on Enter.
  query.addEventListener('input', async () => {
    const spot = parseSpot(query.value.trim());
    if (spot) { show([{ label: `Go to ${fixed(...spot)}`, x: toLocal(spot[1], spot[0])[0], y: toLocal(spot[1], spot[0])[1] }]); return; }
    const q = fold(query.value.trim());
    if (q.length < 2) { results.innerHTML = ''; return; }
    const list = await loadNames();
    const hits = list.filter((s) => s.key.includes(q)).sort((a, b) => (a.key.startsWith(q) ? 0 : 1) - (b.key.startsWith(q) ? 0 : 1) || a.name.length - b.name.length).slice(0, 8);
    show(hits.map((h) => ({ label: h.name, x: h.x, y: h.y })), hits.length ? '' : 'No street by that name here. Press Enter to look the address up online.');
  });
  query.addEventListener('keydown', async (ev) => {
    ev.stopPropagation(); // typing mustn't drive the car
    if (ev.code === 'Backquote') { ev.preventDefault(); toggle(false); return; }
    if (ev.key !== 'Enter') return;
    const q = query.value.trim();
    if (!q) return;
    const spot = parseSpot(q);
    if (spot) { void go(...toLocal(spot[1], spot[0]), fixed(...spot)); return; }
    results.innerHTML = '<div class="dev-note">Looking the address up on OpenStreetMap…</div>';
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(q)}`;
      const found: unknown = await (await fetch(url, { headers: { 'Accept-Language': 'cs' } })).json();
      if (!Array.isArray(found)) throw new Error('Invalid address results');
      const items: DevHit[] = found.filter((f): f is { lon: string; lat: string; display_name: string } =>
        typeof f === 'object' && f !== null && typeof f.lon === 'string' && typeof f.lat === 'string' && typeof f.display_name === 'string')
        .map((f) => {
        const [x, y] = toLocal(+f.lon, +f.lat);
        return { label: f.display_name.split(',').slice(0, 3).join(','), x, y };
      });
      show(items, items.length ? 'Addresses from OpenStreetMap:' : 'Nothing found in this part of Prague.');
    } catch {
      show([], 'The address search isn’t reachable right now; street names still work.');
    }
  });
  query.addEventListener('keyup', (ev) => ev.stopPropagation());

  $('dev-link').onclick = async () => {
    const [x, y] = position();
    const [lon, lat] = toLonLat(x, y);
    const u = new URL(location.href);
    u.searchParams.set('start', `${lon.toFixed(5)},${lat.toFixed(5)}`);
    await navigator.clipboard?.writeText(u.toString()).catch(() => {});
    flash($('dev-link'), 'Link copied', 'Copy link to this spot');
  };

  const pick = $('dev-graphics') as HTMLSelectElement;
  pick.value = graphics.choice;
  pick.onchange = () => graphics.set(pick.value as Choice);
  pick.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  const sky = $('dev-weather') as HTMLSelectElement;
  sky.value = weather.get();
  sky.onchange = () => weather.set(sky.value as Kind | 'auto');
  sky.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  setupMist($, weather, flash);
  const time = $('dev-time') as HTMLInputElement;
  let dragging = false;
  time.oninput = () => { dragging = true; setTimeOfDay(+time.value * 60); };
  time.onchange = () => { dragging = false; };
  // Arrow keys move the slider, not the player.
  time.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  time.addEventListener('keyup', (ev) => ev.stopPropagation());
  const date = $('dev-date') as HTMLInputElement;
  date.oninput = () => season.set(+date.value);
  date.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  date.addEventListener('keyup', (ev) => ev.stopPropagation());
  $('dev-copy').onclick = async () => {
    const [lon, lat] = toLonLat(...here());
    await navigator.clipboard?.writeText(fixed(lat, lon)).catch(() => {});
    flash($('dev-copy'), 'Copied', 'Copy coordinates');
  };
  $('dev-fire').onclick = () => {
    const ok = setFire();
    $('dev-fire').textContent = ok ? 'On fire, engine called' : 'No car nearby';
    setTimeout(() => { $('dev-fire').textContent = 'Set the nearest car on fire'; }, 1800);
  };
  $('dev-hurt').onclick = () => {
    const ok = setHurt();
    $('dev-hurt').textContent = ok ? 'Hurt, ambulance called' : 'Nobody nearby';
    setTimeout(() => { $('dev-hurt').textContent = 'Leave the nearest person hurt'; }, 1800);
  };
  $('dev-road').onclick = backOnRoad;
  $('dev-heli').onclick = () => {
    const ok = helicopter();
    $('dev-heli').textContent = ok ? 'Helicopter parked nearby' : 'No open space for it here';
    setTimeout(() => { $('dev-heli').textContent = 'Helicopter next to me'; }, 1800);
  };

  // The map: OpenStreetMap tiles, your position, click anywhere to go there.
  let map: Leaflet.Map | null = null, marker: Leaflet.CircleMarker | null = null;
  const overlay = document.createElement('div');
  overlay.id = 'dev-mapbox';
  overlay.hidden = true;
  overlay.innerHTML = '<div id="dev-leaflet"></div><div class="dev-maphint">Click where you want to be · right-click copies the coordinates · <kbd>Esc</kbd> closes the map</div>';
  document.body.appendChild(overlay);
  $('dev-map').onclick = async () => {
    overlay.hidden = false;
    const L = (await import('leaflet')).default;
    await import('leaflet/dist/leaflet.css');
    const [lon, lat] = toLonLat(...position());
    if (!map) {
      map = L.map('dev-leaflet', { maxBounds: [[s - 0.02, w - 0.02], [n + 0.02, e + 0.02]] }).setView([lat, lon], 16);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      L.rectangle([[s, w], [n, e]], { color: '#ffd23f', weight: 2, fill: false }).addTo(map);
      marker = L.circleMarker([lat, lon], { radius: 7, color: '#d9612c', fillOpacity: 0.9 }).addTo(map);
      map.on('contextmenu', (ev) => {
        const text = fixed(ev.latlng.lat, ev.latlng.lng);
        void navigator.clipboard?.writeText(text).catch(() => {});
        L.popup().setLatLng(ev.latlng).setContent(`Copied ${text}`).openOn(map!);
      });
      map.on('click', (ev) => {
        overlay.hidden = true;
        const [x, y] = toLocal(ev.latlng.lng, ev.latlng.lat);
        go(x, y, 'the spot you picked');
      });
    } else {
      map.setView([lat, lon], map.getZoom());
      marker?.setLatLng([lat, lon]);
    }
    setTimeout(() => map?.invalidateSize(), 0);
  };

  const toggle = (on = panel.hidden) => {
    panel.hidden = !on;
    if (on) query.focus();
    else overlay.hidden = true;
  };
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Backquote') { toggle(); ev.preventDefault(); }
    if (ev.code === 'Escape' && !overlay.hidden) overlay.hidden = true;
  });
  if (new URLSearchParams(location.search).has('dev')) toggle(true);

  return {
    update() {
      if (panel.hidden) return;
      const [x, y] = here();
      const [lon, lat] = toLonLat(x, y);
      const text = fixed(lat, lon);
      if ($('dev-pos').textContent !== text) {
        $('dev-pos').textContent = text;
        ($('dev-google') as HTMLAnchorElement).href = googleMaps(lat, lon);
        ($('dev-mapy') as HTMLAnchorElement).href = mapyCz(lat, lon);
      }
      ($('dev-street') as HTMLAnchorElement).href = streetView(lat, lon, bench?.heading() ?? 0);
      bench?.update();
      $('dev-graphics-label').textContent = graphics.choice === 'auto' ? `(${graphics.tier} now)` : '';
      if (document.activeElement !== pick) pick.value = graphics.choice;
      if (document.activeElement !== sky) sky.value = weather.get();
      if (document.activeElement !== date) date.value = String(season.day());
      $('dev-date-label').textContent = season.label();
      $('dev-weather-label').textContent = weather.get() === 'auto' ? `(${weather.label().toLowerCase()} now)` : '';
      const min = Math.floor(timeOfDay() / 60);
      if (!dragging) time.value = String(min);
      $('dev-time-label').textContent = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    },
    toLocal, toLonLat,
    attach(kit: Testkit) { bench = setupBench(kit, $); },
  };
}

// The testing tools, under the others.
// Sliders for the mist (MIST in weather.ts), which the game reads every frame.
const MIST_SLIDERS: { key: keyof Mist; label: string; min: number; max: number; step: number; unit?: string; title: string }[] = [
  { key: 'most', label: 'Thickness', min: 0, max: 0.6, step: 0.01, title: 'How much each sheet hides where the mist is thickest' },
  { key: 'from', label: 'Clear air between banks', min: 0.2, max: 1, step: 0.01, title: 'Lower: more of the city lies in mist' },
  { key: 'soft', label: 'Soft edges', min: 0.01, max: 0.6, step: 0.01, title: 'How gradually a bank thickens from its edge' },
  { key: 'haze', label: 'Haze everywhere', min: 0, max: 0.6, step: 0.01, title: 'The thin fog over the whole view, between the banks too' },
  { key: 'bankSize', label: 'Bank size', min: 40, max: 800, step: 10, unit: ' m', title: 'How far across a bank of mist is' },
  { key: 'wispSize', label: 'Wisp size', min: 8, max: 150, step: 1, unit: ' m', title: 'The size of the wisps inside a bank' },
  { key: 'fineSize', label: 'Fine detail size', min: 3, max: 50, step: 1, unit: ' m', title: 'The size of the ragged detail at the edges' },
  { key: 'bankShare', label: 'Banks stand out', min: 0, max: 1.2, step: 0.01, title: 'Higher: large separate banks; lower: mist spread evenly' },
  { key: 'wispShare', label: 'Wisps stand out', min: 0, max: 1.2, step: 0.01, title: 'Higher: ragged, wispy mist; lower: smooth banks' },
  { key: 'low', label: 'Lowest sheet', min: 0, max: 5, step: 0.1, unit: ' m', title: 'Height of the lowest sheet above the ground' },
  { key: 'high', label: 'Top of the mist', min: 2, max: 40, step: 0.5, unit: ' m', title: 'Height of the highest sheet above the ground' },
  { key: 'thin', label: 'Thinner towards the top', min: 0, max: 0.8, step: 0.01, title: 'Higher: banks shaped like low mounds; 0: the same all the way up' },
  { key: 'sheets', label: 'Sheets', min: 2, max: MOST_SHEETS, step: 1, title: 'More sheets look deeper and cost more to draw' },
  { key: 'speed', label: 'Drift speed', min: 0, max: 8, step: 0.1, unit: '×', title: 'How fast the mist drifts and changes' },
];
const MIST_KEY = 'dev-mist';

function setupMist($: (id: string) => HTMLElement, weather: { get: () => string; set: (kind: Kind | 'auto') => void }, flash: (el: HTMLElement, now: string, then: string) => void) {
  try {
    const saved = JSON.parse(localStorage.getItem(MIST_KEY) ?? 'null') as Partial<Mist> | null;
    if (saved) for (const s of MIST_SLIDERS) if (typeof saved[s.key] === 'number') MIST[s.key] = saved[s.key]!;
  } catch { /* nothing saved, or storage is off */ }
  const rows = $('dev-mist-rows');
  const inputs = new Map<keyof Mist, { input: HTMLInputElement; value: HTMLElement }>();
  const text = (s: (typeof MIST_SLIDERS)[number]) => `${+MIST[s.key].toFixed(2)}${s.unit ?? ''}`;
  const save = () => { try { localStorage.setItem(MIST_KEY, JSON.stringify(MIST)); } catch { /* storage is off */ } };
  for (const s of MIST_SLIDERS) {
    const label = document.createElement('label');
    label.className = 'dev-time';
    label.title = s.title;
    label.append(s.label);
    const value = document.createElement('span');
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step) });
    input.value = String(MIST[s.key]);
    value.textContent = text(s);
    input.oninput = () => { MIST[s.key] = Number(input.value); value.textContent = text(s); save(); };
    input.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
    label.append(value, input);
    rows.appendChild(label);
    inputs.set(s.key, { input, value });
  }
  // Opening the section shows the mist, whatever the weather was.
  ($('dev-mist') as HTMLDetailsElement).addEventListener('toggle', (ev) => {
    if ((ev.target as HTMLDetailsElement).open && weather.get() !== 'mist') weather.set('mist');
  });
  $('dev-mist-copy').onclick = async () => {
    const body = MIST_SLIDERS.map((s) => `${s.key}: ${+MIST[s.key].toFixed(3)}`).join(', ');
    await navigator.clipboard.writeText(`MIST = { ${body} }`);
    flash($('dev-mist-copy'), 'Copied', 'Copy values');
  };
  $('dev-mist-reset').onclick = () => {
    Object.assign(MIST, MIST_DEFAULT);
    try { localStorage.removeItem(MIST_KEY); } catch { /* storage is off */ }
    for (const s of MIST_SLIDERS) { const r = inputs.get(s.key)!; r.input.value = String(MIST[s.key]); r.value.textContent = text(s); }
  };
}

function setupBench(kit: Testkit, $: (id: string) => HTMLElement) {
  const box = $('dev-bench');
  box.innerHTML = `
    <div class="dev-sub">Camera</div>
    <label class="dev-check" title="The camera stops following you. Searching or picking a spot on the map now moves the camera, not you."><input id="dev-free" type="checkbox" /> Free camera</label>
    <div class="dev-note" id="dev-free-hint" hidden>Drag to move it · wheel to zoom · right-drag or Shift-drag to turn and tilt</div>
    <div class="dev-row" id="dev-free-row" hidden>
      <button id="dev-top" title="Looking straight down, north up">Straight down</button>
      <button id="dev-back" title="The camera follows you again">Back to me</button>
    </div>
    <div class="dev-sub">Testing</div>
    <div class="dev-row">
      <button id="dev-pause">Pause</button>
      <button id="dev-step" title="Moves the world on by one frame">One frame</button>
      <select id="dev-speed" title="How fast the world runs"><option value="0.1">0.1×</option><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>Normal speed</option><option value="2">2×</option><option value="4">4×</option></select>
    </div>
    <div class="dev-row dev-here">
      <label class="dev-check">Money <input id="dev-money" type="number" min="0" step="100" /></label>
      <label class="dev-check">Wanted <select id="dev-stars">${[0, 1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n ? '★'.repeat(n) : 'no stars'}</option>`).join('')}</select></label>
    </div>
    <div class="dev-row dev-here">
      <button id="dev-heal">Full health</button>
      <label class="dev-check" title="Crashes, shots and explosions don't hurt you"><input id="dev-unhurt" type="checkbox" /> Nothing hurts</label>
    </div>
    <div class="dev-row">
      <button id="dev-car" title="A car on clear ground ahead of you, with you in it">Into a new car</button>
      <select id="dev-car-kind">${['hatch', 'sedan', 'suv', 'van', 'taxi', 'police', 'pickup', 'truck', 'bus', 'minibus', 'moto', 'bike'].map((k) => `<option>${k}</option>`).join('')}</select>
    </div>
    <label class="dev-time">Test places
      <select id="dev-place"><option value="">Go to…</option>${Object.entries(kit.PLACES).map(([k, p]) => `<option value="${k}">${p.note}</option>`).join('')}</select>
    </label>
    <label class="dev-time">Scenarios
      <select id="dev-scenario">${kit.scenarios.map((n) => `<option>${n}</option>`).join('')}</select>
    </label>
    <div class="dev-row">
      <button id="dev-run">Run and watch</button>
      <button id="dev-all" title="Runs every scenario as fast as it can and lists which pass">Run all</button>
    </div>
    <div class="dev-row">
      <button id="dev-snap" title="Copies where you are, the time, the weather, your money, stars and car as the start of a scenario, to paste into a conversation">Copy this situation</button>
    </div>
    <div id="dev-out"></div>`;
  const free = $('dev-free') as HTMLInputElement;
  free.onchange = () => { void kit.camera(free.checked ? {} : null); };
  $('dev-top').onclick = () => { void kit.camera({ tilt: 0, heading: 0 }); };
  $('dev-back').onclick = () => { void kit.camera(null); };
  const keep = (el: HTMLElement) => el.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  const out = $('dev-out');
  const pause = $('dev-pause');
  pause.onclick = () => { kit.paused = !kit.paused; };
  $('dev-step').onclick = () => { kit.paused = true; kit.step(); };
  const speed = $('dev-speed') as HTMLSelectElement;
  speed.onchange = () => { kit.speed = +speed.value; };
  const money = $('dev-money') as HTMLInputElement;
  keep(money);
  money.onchange = () => kit.set({ money: +money.value });
  const stars = $('dev-stars') as HTMLSelectElement;
  stars.onchange = () => kit.set({ stars: +stars.value });
  $('dev-heal').onclick = () => kit.set({ health: 100 });
  const unhurt = $('dev-unhurt') as HTMLInputElement;
  unhurt.onchange = () => { kit.unhurt = unhurt.checked; };
  const kind = $('dev-car-kind') as HTMLSelectElement;
  $('dev-car').onclick = async () => {
    try { await kit.drive(kind.value); } catch (e) { out.textContent = e instanceof Error ? e.message : String(e); }
  };
  const place = $('dev-place') as HTMLSelectElement;
  place.onchange = async () => {
    if (!place.value) return;
    await kit.go(place.value);
    place.value = '';
  };
  for (const el of [speed, stars, kind, place, $('dev-scenario')]) keep(el);
  const line = (r: Awaited<ReturnType<Testkit['run']>>) =>
    `<div class="${r.pass ? 'dev-pass' : 'dev-fail'}">${r.pass ? '✓' : '✗'} ${r.title}</div>` +
    r.checks.map((c) => `<div class="${c.pass ? 'dev-pass' : 'dev-fail'}">  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` <span class="dev-note">${c.detail}</span>` : ''}</div>`).join('') +
    (r.error ? `<div class="dev-fail">  ${r.error}</div>` : '');
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const run = async (names: string[], watch: boolean) => {
    out.innerHTML = '<div class="dev-note">Running…</div>';
    kit.watch = watch;
    let html = '';
    try {
      for (const n of names) { html += line(await kit.run(n)); out.innerHTML = html; }
    } catch (e) {
      out.innerHTML = html + `<div class="dev-fail">${esc(e instanceof Error ? e.message : String(e))}</div>`;
    } finally {
      kit.watch = false;
    }
  };
  $('dev-run').onclick = () => run([($('dev-scenario') as HTMLSelectElement).value], true);
  $('dev-all').onclick = () => run(kit.scenarios, false);
  $('dev-snap').onclick = async () => {
    const text = kit.snapshot();
    await navigator.clipboard?.writeText(text).catch(() => {});
    out.textContent = text;
    $('dev-snap').textContent = 'Copied';
    setTimeout(() => { $('dev-snap').textContent = 'Copy this situation'; }, 1500);
  };
  return {
    heading: () => kit.cam ? kit.cam.heading : kit.where().heading,
    spot: (): Point2 | null => (kit.cam ? [kit.cam.x, kit.cam.y] : null),
    free: () => !!kit.cam,
    look: (lat: number, lon: number) => kit.camera({ at: [lat, lon] }),
    update() {
      free.checked = !!kit.cam;
      $('dev-free-hint').hidden = $('dev-free-row').hidden = !kit.cam;
      pause.textContent = kit.paused ? 'Carry on' : 'Pause';
      const p = kit.probe();
      if (document.activeElement !== money) money.value = String(p.money);
      if (document.activeElement !== stars) stars.value = String(p.stars);
    },
  };
}
