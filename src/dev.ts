import { dataUrl } from './data.ts';
import proj4 from 'proj4';
import type { GeoJSONSource, LngLatBoundsLike, Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { LayerSpecification, SourceSpecification } from '@maplibre/maplibre-gl-style-spec';
import { RED, foldCredits, loadMapLibre, posterStyle } from './postermap.ts';
import type { MapIndex } from './contracts.ts';
import type { Bounds, Point2 } from './map/geo.ts';
import { CHOICES, type Graphics, type Choice } from './graphics.ts';
import { MIST, MIST_DEFAULT, MOST_SHEETS, type Kind, type Mist } from './weather.ts';
import { LOCAL_MIST, LOCAL_MIST_DEFAULT, MIST_MODE, supportsLocalMist, type MistMode, type LocalMistSettings } from './localmist.ts';
import type { Testkit } from './testkit.ts';
import { gunOn, setGun } from './pistol.ts';
import { did } from './telemetry.ts';

// far: a place out of the game's reach, [lat, lon]; going there reloads the game.
interface DevHit { label: string; x: number; y: number; far?: [number, number] }
// The middle of Prague's map, and how far from it the countryside reaches (a little
// under countrysideTiles.ts's LIMIT, so the place isn't at the very edge).
const PRAGUE: Point2 = [14.4656, 50.05965], REACH = 140000;
interface StreetName { name: string; key: string; x: number; y: number }

// Developer panel (` key or ?dev): jump to a street, an address, coordinates or a
// Google Maps / Mapy.cz link, or pick a spot on a map; see where you are on those maps;
// set the time of day, the weather and the graphics; and the testing tools (pause, slow
// motion, money, stars, scenarios). Street names come from the area's own index
// (offline); addresses are looked up on OpenStreetMap's Nominatim only when you ask.

// The panel's sections fold away when you click their heading; this browser remembers
// which ones you folded.
const FOLDED_KEY = 'dev-folded';
const folded = (): Set<string> => {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
    return new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []);
  } catch { return new Set(); }
};
const section = (id: string, title: string, body: string) =>
  `<details class="dev-sec" data-sec="${id}"${folded().has(id) ? '' : ' open'}><summary class="dev-sub">${title}</summary><div class="dev-body">${body}</div></details>`;
// ('toggle' doesn't bubble, so it's caught on the way down.)
const rememberFolds = (root: HTMLElement) => root.addEventListener('toggle', (ev) => {
  const d = ev.target;
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.sec) return;
  const set = folded();
  if (d.open) set.delete(d.dataset.sec); else set.add(d.dataset.sec);
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...set])); } catch { /* storage is off */ }
}, true);

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

export function setupDev({ area, index, teleport, position, helicopter, setFire, setHurt, backOnRoad, timeOfDay, setTimeOfDay, graphics, season, weather, reach }: {
  area: string; index: MapIndex; teleport: (x: number, y: number) => Promise<void>;
  position: () => Point2; helicopter: () => boolean; setFire: () => boolean; setHurt: () => boolean; backOnRoad: () => void;
  // Seconds since midnight on the game's clock.
  timeOfDay: () => number; setTimeOfDay: (sec: number) => void;
  graphics: Graphics;
  // The game's date, as a day of the year (season.ts).
  season: { day: () => number; set: (day: number) => void; label: () => string };
  // The weather picked, or 'auto' while it changes by itself.
  weather: { kinds: string[]; get: () => string; set: (kind: Kind | 'auto') => void; label: () => string };
  // How far you can go, in the game's metres, when the countryside reaches past the
  // built map (?countryside); null while it doesn't.
  reach?: () => Bounds | null;
}) {
  const [w, s, e, n] = index.bbox_wgs84;
  const local = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const toLocal = (lon: number, lat: number): Point2 => proj4('EPSG:4326', local, [lon, lat]) as Point2;
  const toLonLat = (x: number, y: number): Point2 => proj4(local, 'EPSG:4326', [x, y]) as Point2;
  // Where the search and the map may take you, as [west, south, east, north]: the
  // built map, or the countryside around it.
  // Past that, on the dev server, the game is opened again with the countryside read
  // live: around Prague's map if the place is within reach of it, else centred there
  // (?at=, countrysideTiles.ts).
  const anywhere = import.meta.env.DEV;
  const within = (lon: number, lat: number) => { const [ew, es, ee, en] = extent(); return lon > ew && lon < ee && lat > es && lat < en; };
  const reopen = (lat: number, lon: number) => {
    const u = new URL(location.href);
    for (const k of ['at', 'start', 'place']) u.searchParams.delete(k);
    u.searchParams.set('countryside', 'live');
    const fromPrague = Math.hypot((lon - PRAGUE[0]) * Math.cos((lat * Math.PI) / 180), lat - PRAGUE[1]) * 111320;
    if (fromPrague < REACH) u.searchParams.set('start', `${lon.toFixed(5)},${lat.toFixed(5)}`);
    else u.searchParams.set('at', `${lat.toFixed(5)},${lon.toFixed(5)}`);
    location.href = u.toString();
  };
  const extent = (): Bounds => {
    const box = reach?.();
    if (!box) return [w, s, e, n];
    const corners = [toLonLat(box[0], box[1]), toLonLat(box[2], box[1]), toLonLat(box[0], box[3]), toLonLat(box[2], box[3])];
    return [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])), Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
  };
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
    ${section('where', 'Where you are', `
      <div class="dev-row">
        <span id="dev-pos"></span>
        <button id="dev-copy" title="Copies your latitude and longitude, e.g. to paste into a conversation">Copy coordinates</button>
      </div>
      <div class="dev-row dev-links">
        <a id="dev-google" target="_blank" rel="noopener">Google Maps</a>
        <a id="dev-street" target="_blank" rel="noopener" title="Google Street View here, looking the way you face">Street View</a>
        <a id="dev-mapy" target="_blank" rel="noopener">Mapy.cz</a>
      </div>`)}
    ${section('happen', 'Make something happen', `
      <div class="dev-row dev-grid">
        <button id="dev-heli" title="Walk up to it and press E to fly it">Helicopter next to me</button>
        <button id="dev-road" title="Puts the car you are driving back on the nearest road">Back on the road</button>
        <button id="dev-fire" title="The fire brigade comes from out of view">Set the nearest car on fire</button>
        <button id="dev-hurt" title="An ambulance comes from out of view">Leave the nearest person hurt</button>
      </div>`)}
    ${section('world', 'World', `
      <label class="dev-slide" title="The trams follow the timetable for the new time">Time
        <input id="dev-time" type="range" min="0" max="1439" step="5" /><span id="dev-time-label"></span>
      </label>
      <label class="dev-slide" title="The trees, the sun and the weather follow the date">Date
        <input id="dev-date" type="range" min="1" max="365" step="1" /><span id="dev-date-label"></span>
      </label>
      <label class="dev-pick"><span>Graphics <em id="dev-graphics-label"></em></span>
        <select id="dev-graphics">${CHOICES.map((c) => `<option value="${c}">${c[0].toUpperCase()}${c.slice(1)}</option>`).join('')}</select>
      </label>
      <label class="dev-pick"><span>Weather <em id="dev-weather-label"></em></span>
        <select id="dev-weather">
          <option value="auto">Changing by itself</option>${weather.kinds.map((k) => `<option value="${k}">${k[0].toUpperCase()}${k.slice(1)}</option>`).join('')}
        </select>
      </label>
      <label class="dev-pick" title="What lies past the edge of the built map. Changing it reloads the game"><span>Past the map's edge</span>
        <select id="dev-country">
          <option value="">Nothing</option><option value="file">Countryside from the file</option><option value="live">Live countryside, anywhere</option>
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
      </details>`)}
    <div id="dev-bench"></div>`;
  panel.style.maxHeight = 'calc(100vh - 32px)';
  panel.style.overflowY = 'auto';
  const style = document.createElement('style');
  style.textContent = `
    #dev .dev-here { align-items: center; }
    #dev .dev-here span { flex: 1; font-variant-numeric: tabular-nums; }
    #dev .dev-sub { margin-top: 6px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.12); font: 11px/1 'IBM Plex Mono', monospace; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); }
    #dev .dev-sec > summary { display: flex; justify-content: space-between; list-style: none; cursor: pointer; user-select: none; }
    #dev .dev-sec > summary::-webkit-details-marker { display: none; }
    #dev .dev-sec > summary::after { content: '−'; opacity: 0.7; }
    #dev .dev-sec:not([open]) > summary::after { content: '+'; }
    #dev .dev-sec > summary:hover { color: var(--ink); }
    #dev .dev-body { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
    #dev .dev-pick { display: grid; grid-template-columns: 128px 1fr; gap: 8px; align-items: center; }
    #dev .dev-pick em { font-style: normal; opacity: 0.6; font-size: 12px; }
    #dev .dev-pick select { min-width: 0; }
    #dev .dev-body[hidden], #dev-out:empty { display: none; }
    #dev input[type=number] { width: 90px; padding: 4px 6px; }
    #dev .dev-check { display: flex; gap: 6px; align-items: center; }
    #dev .dev-check input { margin: 0; }
    #dev .dev-inline { padding: 1px 6px; font-size: 11px; }
    #dev-mist summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
    #dev-mist .dev-time span { margin-left: auto; font-variant-numeric: tabular-nums; opacity: 0.8; }
    #dev-mist [hidden] { display: none; }
    #dev .dev-pass { color: #8fd18f; } #dev .dev-fail { color: #ff8f7a; }
    #dev-out { font-size: 12px; white-space: pre-wrap; max-height: 220px; overflow: auto; }`;
  document.head.appendChild(style);
  panel.hidden = true;
  rememberFolds(panel);
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
  const showNote = (text: string) => {
    results.replaceChildren();
    if (text) results.appendChild(Object.assign(document.createElement('div'), { className: 'dev-note', textContent: text }));
  };
  const go = async (x: number, y: number, label: string) => {
    did('dev: jumped to a place');
    showNote(`Going to ${label}…`);
    if (bench?.free()) { const [lon, lat] = toLonLat(x, y); await bench.look(lat, lon); } else await teleport(x, y);
    results.replaceChildren();
  };
  // A place found by its latitude and longitude: here, or (far away) the game reopened there.
  const hit = (lon: number, lat: number, label: string): DevHit => {
    const [x, y] = toLocal(lon, lat);
    return within(lon, lat) || !anywhere ? { label, x, y } : { label: `${label} (the game reloads there)`, x, y, far: [lat, lon] };
  };
  const show = (items: DevHit[], note = '') => {
    showNote(note);
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'dev-hit';
      b.textContent = it.label;
      b.onclick = () => (it.far ? reopen(...it.far) : go(it.x, it.y, it.label));
      results.appendChild(b);
    }
  };

  // Streets as you type; the whole address on Enter.
  query.addEventListener('input', async () => {
    const spot = parseSpot(query.value.trim());
    if (spot) { show([hit(spot[1], spot[0], `Go to ${fixed(...spot)}`)]); return; }
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
    if (spot) {
      const h = hit(spot[1], spot[0], fixed(...spot));
      if (h.far) reopen(...h.far); else void go(h.x, h.y, h.label);
      return;
    }
    results.innerHTML = '<div class="dev-note">Looking the address up on OpenStreetMap…</div>';
    try {
      const [ew, es, ee, en] = extent();
      // (On the dev server anywhere in the world, nearby places first.)
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&bounded=${anywhere ? 0 : 1}&viewbox=${ew},${en},${ee},${es}&q=${encodeURIComponent(q)}`;
      const found: unknown = await (await fetch(url, { headers: { 'Accept-Language': 'cs' } })).json();
      if (!Array.isArray(found)) throw new Error('Invalid address results');
      const items: DevHit[] = found.filter((f): f is { lon: string; lat: string; display_name: string } =>
        typeof f === 'object' && f !== null && typeof f.lon === 'string' && typeof f.lat === 'string' && typeof f.display_name === 'string')
        .map((f) => hit(+f.lon, +f.lat, f.display_name.split(',').slice(0, 3).join(',')));
      show(items, items.length ? 'Addresses from OpenStreetMap:' : reach?.() ? 'Nothing found within reach of the map.' : 'Nothing found in this part of Prague.');
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
  pick.onchange = () => { did('dev: changed graphics'); graphics.set(pick.value as Choice); };
  pick.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  const sky = $('dev-weather') as HTMLSelectElement;
  sky.value = weather.get();
  sky.onchange = () => { did('dev: changed weather'); weather.set(sky.value as Kind | 'auto'); };
  sky.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  // Past the map's edge: the game is opened again with or without ?countryside.
  const country = $('dev-country') as HTMLSelectElement;
  const opened = new URLSearchParams(location.search);
  country.value = opened.has('at') || opened.get('countryside') === 'live' ? 'live' : opened.has('countryside') ? 'file' : '';
  country.onchange = () => {
    did('dev: changed countryside');
    const u = new URL(location.href);
    if (country.value === 'live') u.searchParams.set('countryside', 'live');
    else if (country.value === 'file') u.searchParams.set('countryside', '');
    else u.searchParams.delete('countryside');
    // Here again; or, away from Prague (?at=), back to Prague's map.
    if (opened.has('at')) { u.searchParams.delete('at'); u.searchParams.delete('start'); }
    else { const [lon, lat] = toLonLat(...position()); u.searchParams.set('start', `${lon.toFixed(5)},${lat.toFixed(5)}`); }
    location.href = u.toString();
  };
  country.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  setupMist($, weather, flash);
  const time = $('dev-time') as HTMLInputElement;
  let dragging = false;
  time.oninput = () => { dragging = true; setTimeOfDay(+time.value * 60); };
  time.onchange = () => { dragging = false; did('dev: changed time of day'); };
  // Arrow keys move the slider, not the player.
  time.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  time.addEventListener('keyup', (ev) => ev.stopPropagation());
  const date = $('dev-date') as HTMLInputElement;
  date.oninput = () => season.set(+date.value);
  date.onchange = () => did('dev: changed date');
  date.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  date.addEventListener('keyup', (ev) => ev.stopPropagation());
  $('dev-copy').onclick = async () => {
    const [lon, lat] = toLonLat(...here());
    await navigator.clipboard?.writeText(fixed(lat, lon)).catch(() => {});
    flash($('dev-copy'), 'Copied', 'Copy coordinates');
  };
  $('dev-fire').onclick = () => {
    did('dev: set a car on fire');
    const ok = setFire();
    $('dev-fire').textContent = ok ? 'On fire, engine called' : 'No car nearby';
    setTimeout(() => { $('dev-fire').textContent = 'Set the nearest car on fire'; }, 1800);
  };
  $('dev-hurt').onclick = () => {
    did('dev: left someone hurt');
    const ok = setHurt();
    $('dev-hurt').textContent = ok ? 'Hurt, ambulance called' : 'Nobody nearby';
    setTimeout(() => { $('dev-hurt').textContent = 'Leave the nearest person hurt'; }, 1800);
  };
  $('dev-road').onclick = () => { did('dev: back on the road'); backOnRoad(); };
  $('dev-heli').onclick = () => {
    did('dev: parked a helicopter');
    const ok = helicopter();
    $('dev-heli').textContent = ok ? 'Helicopter parked nearby' : 'No open space for it here';
    setTimeout(() => { $('dev-heli').textContent = 'Helicopter next to me'; }, 1800);
  };

  // The map, in the poster's colours (postermap.ts): your position, the built map's edge
  // and (dashed, on the dev server) how far you can go before the game reloads; click
  // anywhere to go there.
  let map: MapLibreMap | null = null, marker: Marker | null = null;
  const outline = (b: Bounds): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]] } });
  const overlay = document.createElement('div');
  overlay.id = 'dev-mapbox';
  overlay.hidden = true;
  overlay.innerHTML = `<div id="dev-mapview"></div><div class="dev-maphint">Click where you want to be${import.meta.env.DEV ? ' (past the dashed line, the game reloads there)' : ''} · right-click copies the coordinates · <kbd>Esc</kbd> closes the map</div>`;
  document.body.appendChild(overlay);
  $('dev-map').onclick = async () => {
    did('dev: opened the map');
    overlay.hidden = false;
    const lib = await loadMapLibre();
    const [lon, lat] = toLonLat(...position());
    // The countryside's file may open after the map was first shown.
    const [ew, es, ee, en] = extent();
    const bounds: LngLatBoundsLike | null = anywhere ? null : [ew - 0.02, es - 0.02, ee + 0.02, en + 0.02];
    if (!map) {
      const sources: Record<string, SourceSpecification> = { built: { type: 'geojson', data: outline([w, s, e, n]) } };
      const layers: LayerSpecification[] = [{ id: 'built', type: 'line', source: 'built', paint: { 'line-color': RED, 'line-width': 2.5 } }];
      if (anywhere) {
        sources.reach = { type: 'geojson', data: outline([ew, es, ee, en]) };
        layers.push({ id: 'reach', type: 'line', source: 'reach', paint: { 'line-color': RED, 'line-width': 1.5, 'line-dasharray': [4, 3] } });
      }
      const m = map = new lib.Map({
        container: 'dev-mapview', center: [lon, lat], zoom: 16, maxZoom: 19, maxBounds: bounds ?? undefined,
        dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
        style: posterStyle(sources, layers),
      });
      foldCredits(m);
      m.touchZoomRotate.disableRotation();
      m.keyboard.disableRotation();
      const you = document.createElement('div');
      you.className = 'dev-you';
      marker = new lib.Marker({ element: you }).setLngLat([lon, lat]).addTo(m);
      m.on('contextmenu', (ev) => {
        const text = fixed(ev.lngLat.lat, ev.lngLat.lng);
        void navigator.clipboard?.writeText(text).catch(() => {});
        new lib.Popup().setLngLat(ev.lngLat).setText(`Copied ${text}`).addTo(m);
      });
      m.on('click', (ev) => {
        overlay.hidden = true;
        const h = hit(ev.lngLat.wrap().lng, ev.lngLat.lat, 'the spot you picked');
        if (h.far) reopen(...h.far); else void go(h.x, h.y, h.label);
      });
    } else {
      (map.getSource('reach') as GeoJSONSource | undefined)?.setData(outline([ew, es, ee, en]));
      map.setMaxBounds(bounds);
      map.jumpTo({ center: [lon, lat] });
      marker?.setLngLat([lon, lat]);
    }
    map.resize();
  };

  const toggle = (on = panel.hidden) => {
    panel.hidden = !on;
    if (on) { did('dev: opened the panel'); query.focus(); }
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
const VOLUME_SLIDERS: { key: keyof LocalMistSettings; label: string; min: number; max: number; step: number; unit?: string; title: string }[] = [
  { key: 'density', label: 'Thickness', min: 0, max: 1.5, step: 0.01, title: 'How strongly the mist hides objects inside a bank' },
  { key: 'river', label: 'More mist over water', min: 0, max: 1, step: 0.05, title: 'How strongly mist gathers above the river and along its banks' },
  { key: 'width', label: 'Bank width', min: 8, max: 100, step: 1, unit: ' m', title: 'Width of each separate bank, with clear air between banks' },
  { key: 'length', label: 'Bank length', min: 8, max: 100, step: 1, unit: ' m', title: 'Length of each separate bank' },
  { key: 'spacing', label: 'Distance between banks', min: 24, max: 160, step: 1, unit: ' m', title: 'Distance between the centres of neighbouring banks' },
  { key: 'low', label: 'Bottom above ground', min: 0, max: 3, step: 0.05, unit: ' m', title: 'Height where mist begins above the local terrain' },
  { key: 'high', label: 'Top above ground', min: 0.5, max: 8, step: 0.1, unit: ' m', title: 'Height where a bank fades into clear air' },
  { key: 'edge', label: 'Soft edges', min: 0.05, max: 0.8, step: 0.01, title: 'How much of the bank fades gently towards its edges' },
  { key: 'noiseSize', label: 'Wisp size', min: 2, max: 30, step: 0.5, unit: ' m', title: 'Size of the wisps inside a bank' },
  { key: 'speed', label: 'Drift speed', min: 0, max: 3, step: 0.05, unit: ' m/s', title: 'How fast the wisps move through the bank' },
  { key: 'steps', label: 'Detail along the view', min: 8, max: 16, step: 1, title: 'More samples give finer mist and take more time to draw' },
];

function setupMist($: (id: string) => HTMLElement, weather: { get: () => string; set: (kind: Kind | 'auto') => void }, flash: (el: HTMLElement, now: string, then: string) => void) {
  const requested = new URLSearchParams(location.search).get('mist');
  try {
    const saved = JSON.parse(localStorage.getItem(MIST_KEY) ?? 'null') as (Partial<Mist> & { mode?: MistMode; volume?: Partial<LocalMistSettings> }) | null;
    for (const s of MIST_SLIDERS) {
      const value = saved?.[s.key];
      if (typeof value === 'number' && Number.isFinite(value)) MIST[s.key] = Math.max(s.min, Math.min(s.max, value));
    }
    if (!requested && (saved?.mode === 'sheets' || saved?.mode === 'volume')) MIST_MODE.value = saved.mode;
    for (const s of VOLUME_SLIDERS) {
      const value = saved?.volume?.[s.key];
      if (typeof value === 'number' && Number.isFinite(value)) LOCAL_MIST[s.key] = Math.max(s.min, Math.min(s.max, value));
    }
  } catch { /* nothing saved, or storage is off */ }
  if (requested === 'sheets' || requested === 'volume') MIST_MODE.value = requested;
  if (!supportsLocalMist()) MIST_MODE.value = 'sheets';
  const rows = $('dev-mist-rows');
  const save = () => { try { localStorage.setItem(MIST_KEY, JSON.stringify({ ...MIST, mode: MIST_MODE.value, volume: LOCAL_MIST })); } catch { /* storage is off */ } };
  const modeLabel = document.createElement('label');
  modeLabel.className = 'dev-pick';
  modeLabel.append(Object.assign(document.createElement('span'), { textContent: 'Mist shape' }));
  const mode = document.createElement('select');
  mode.id = 'dev-mist-mode';
  mode.innerHTML = '<option value="sheets">Layered banks</option><option value="volume">Local volumes</option>';
  mode.options[1].disabled = !supportsLocalMist();
  if (!supportsLocalMist()) modeLabel.title = 'Local volumes need WebGPU. This browser is using the simpler graphics renderer.';
  modeLabel.append(mode);
  rows.append(modeLabel);
  const controls: { label: HTMLElement; mode: MistMode | 'both'; refresh: () => void }[] = [];
  const addRows = (settings: Record<string, number>, sliders: readonly (typeof MIST_SLIDERS)[number][] | readonly (typeof VOLUME_SLIDERS)[number][], which: MistMode) => {
    for (const s of sliders) {
      const label = document.createElement('label');
      label.className = 'dev-time';
      label.title = s.title;
      label.append(s.label);
      const value = document.createElement('span');
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: String(s.min), max: String(s.max), step: String(s.step) });
      const refresh = () => { input.value = String(settings[s.key]); value.textContent = `${+settings[s.key].toFixed(2)}${s.unit ?? ''}`; };
      input.oninput = () => { settings[s.key] = Number(input.value); refresh(); save(); };
      input.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
      label.append(value, input);
      rows.appendChild(label);
      controls.push({ label, mode: s.key === 'haze' ? 'both' : which, refresh });
    }
  };
  addRows(MIST, MIST_SLIDERS, 'sheets');
  addRows(LOCAL_MIST, VOLUME_SLIDERS, 'volume');
  const refresh = () => {
    mode.value = MIST_MODE.value;
    for (const c of controls) { c.label.hidden = c.mode !== 'both' && c.mode !== MIST_MODE.value; c.refresh(); }
  };
  mode.onchange = () => { MIST_MODE.value = mode.value as MistMode; refresh(); save(); };
  mode.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  refresh();
  // Preview mist at the opening click. A queued `toggle` could otherwise replace
  // weather selected immediately afterwards.
  const mistSection = $('dev-mist') as HTMLDetailsElement;
  mistSection.querySelector('summary')!.addEventListener('click', () => {
    if (!mistSection.open && weather.get() !== 'mist') weather.set('mist');
  });
  $('dev-mist-copy').onclick = async () => {
    await navigator.clipboard.writeText(`MIST_MODE.value = '${MIST_MODE.value}';\nMIST = ${JSON.stringify(MIST, null, 2)};\nLOCAL_MIST = ${JSON.stringify(LOCAL_MIST, null, 2)};`);
    flash($('dev-mist-copy'), 'Copied', 'Copy values');
  };
  $('dev-mist-reset').onclick = () => {
    Object.assign(MIST, MIST_DEFAULT);
    Object.assign(LOCAL_MIST, LOCAL_MIST_DEFAULT);
    MIST_MODE.value = 'sheets';
    try { localStorage.removeItem(MIST_KEY); } catch { /* storage is off */ }
    refresh();
  };
}

function setupBench(kit: Testkit, $: (id: string) => HTMLElement) {
  const box = $('dev-bench');
  box.innerHTML = `
    ${section('camera', 'Camera', `
      <div class="dev-row dev-here">
        <label class="dev-check" title="The camera stops following you. Searching or picking a spot on the map now moves the camera, not you."><input id="dev-free" type="checkbox" /> Free camera</label>
        <label class="dev-check" title="See the street the way you'd see it standing in it; driving, from just behind your car"><input id="dev-eyes" type="checkbox" /> First person</label>
      </div>
      <div class="dev-note" id="dev-free-hint" hidden>Drag to pan · scroll to zoom · right-drag or Shift-drag to orbit</div>
      <div class="dev-note" id="dev-eyes-hint" hidden>Click to look round with the mouse (Esc to let go), or right-drag · <button id="dev-ahead" class="dev-inline">Look ahead again</button></div>
      <div id="dev-free-row" class="dev-body" hidden>
        <label class="dev-slide">Rotation <input id="dev-heading" type="range" min="0" max="359" step="1" /><span id="dev-heading-value" aria-hidden="true"></span></label>
        <label class="dev-slide">Tilt <input id="dev-tilt" type="range" min="0" max="75" step="1" /><span id="dev-tilt-value" aria-hidden="true"></span></label>
        <div class="dev-row">
          <button id="dev-top" title="Looking straight down, north up">Straight down</button>
          <button id="dev-back" title="The camera follows you again">Back to me</button>
        </div>
      </div>`)}
    ${section('testing', 'Testing', `
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
        <label class="dev-check" title="Players have no gun. This hands you the pistol (click, F on foot, RB, the Shoot button), and this browser keeps it"><input id="dev-gun" type="checkbox" /> Pistol</label>
      </div>
      <div class="dev-row">
        <button id="dev-car" title="A car on clear ground ahead of you, with you in it">Into a new car</button>
        <select id="dev-car-kind">${['hatch', 'sedan', 'suv', 'van', 'taxi', 'police', 'pickup', 'truck', 'bus', 'minibus', 'moto', 'bike'].map((k) => `<option>${k}</option>`).join('')}</select>
      </div>
      <label class="dev-pick"><span>Test places</span>
        <select id="dev-place"><option value="">Go to…</option>${Object.entries(kit.PLACES).map(([k, p]) => `<option value="${k}">${p.note}</option>`).join('')}</select>
      </label>
      <label class="dev-pick"><span>Scenario</span>
        <select id="dev-scenario">${kit.scenarios.map((n) => `<option>${n}</option>`).join('')}</select>
      </label>
      <div class="dev-row">
        <button id="dev-run">Run and watch</button>
        <button id="dev-all" title="Runs every scenario as fast as it can and lists which pass">Run all</button>
      </div>
      <div class="dev-row">
        <button id="dev-snap" title="Copies where you are, the time, the weather, your money, stars and car as the start of a scenario, to paste into a conversation">Copy this situation</button>
      </div>
      <div id="dev-out"></div>`)}`;
  const free = $('dev-free') as HTMLInputElement;
  free.onchange = () => { if (free.checked) kit.eyes = null; void kit.camera(free.checked ? { level: true } : null); };
  const eyes = $('dev-eyes') as HTMLInputElement;
  eyes.onchange = () => { kit.eyes = eyes.checked ? { yaw: 0, pitch: 0 } : null; if (eyes.checked) void kit.camera(null); };
  $('dev-ahead').onclick = () => { if (kit.eyes) kit.eyes.yaw = kit.eyes.pitch = 0; };
  $('dev-top').onclick = () => kit.orbit(0, 0);
  $('dev-back').onclick = () => { void kit.camera(null); };
  const keep = (el: HTMLElement) => el.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  const heading = $('dev-heading') as HTMLInputElement, tilt = $('dev-tilt') as HTMLInputElement;
  const headingValue = $('dev-heading-value'), tiltValue = $('dev-tilt-value');
  keep(heading);
  keep(tilt);
  heading.oninput = () => { if (kit.cam) kit.orbit(heading.valueAsNumber, kit.cam.tilt); };
  tilt.oninput = () => { if (kit.cam) kit.orbit(kit.cam.heading, tilt.valueAsNumber); };
  const out = $('dev-out');
  const pause = $('dev-pause');
  pause.onclick = () => { did('dev: paused'); kit.paused = !kit.paused; };
  $('dev-step').onclick = () => { did('dev: stepped a frame'); kit.paused = true; kit.step(); };
  const speed = $('dev-speed') as HTMLSelectElement;
  speed.onchange = () => { did('dev: changed speed'); kit.speed = +speed.value; };
  const money = $('dev-money') as HTMLInputElement;
  keep(money);
  money.onchange = () => { did('dev: set money'); kit.set({ money: +money.value }); };
  const stars = $('dev-stars') as HTMLSelectElement;
  stars.onchange = () => { did('dev: set stars'); kit.set({ stars: +stars.value }); };
  $('dev-heal').onclick = () => { did('dev: healed'); kit.set({ health: 100 }); };
  const unhurt = $('dev-unhurt') as HTMLInputElement;
  unhurt.onchange = () => { did('dev: toggled invincibility'); kit.unhurt = unhurt.checked; };
  const gun = $('dev-gun') as HTMLInputElement;
  gun.checked = gunOn();
  gun.onchange = () => { did('dev: toggled the pistol'); setGun(gun.checked); };
  const kind = $('dev-car-kind') as HTMLSelectElement;
  $('dev-car').onclick = async () => {
    did('dev: spawned a vehicle');
    try { await kit.drive(kind.value); } catch (e) { out.textContent = e instanceof Error ? e.message : String(e); }
  };
  const place = $('dev-place') as HTMLSelectElement;
  place.onchange = async () => {
    if (!place.value) return;
    did('dev: jumped to a place');
    await kit.go(place.value);
    place.value = '';
  };
  for (const el of [speed, stars, kind, place, $('dev-scenario')]) keep(el);
  const line = (r: Awaited<ReturnType<Testkit['run']>>) =>
    `<div class="${r.pass ? 'dev-pass' : 'dev-fail'}">${r.pass ? '✓' : '✗'} ${esc(r.title)}</div>` +
    r.checks.map((c) => `<div class="${c.pass ? 'dev-pass' : 'dev-fail'}">  ${c.pass ? '✓' : '✗'} ${esc(c.name)}${c.detail ? ` <span class="dev-note">${esc(c.detail)}</span>` : ''}</div>`).join('') +
    (r.error ? `<div class="dev-fail">  ${esc(r.error)}</div>` : '');
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const run = async (names: string[], watch: boolean) => {
    did('dev: ran scenarios');
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
      if (kit.cam) {
        heading.value = String(((Math.round(kit.cam.heading) % 360) + 360) % 360);
        tilt.value = String(Math.round(kit.cam.tilt));
        headingValue.textContent = heading.value + '°';
        tiltValue.textContent = tilt.value + '°';
      }
      eyes.checked = !!kit.eyes && !kit.cam;
      $('dev-eyes-hint').hidden = !eyes.checked;
      pause.textContent = kit.paused ? 'Carry on' : 'Pause';
      const p = kit.probe();
      if (document.activeElement !== money) money.value = String(p.money);
      if (document.activeElement !== stars) stars.value = String(p.stars);
    },
  };
}
