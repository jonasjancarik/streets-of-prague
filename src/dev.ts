import proj4 from 'proj4';
import type * as Leaflet from 'leaflet';
import type { MapIndex } from './contracts.ts';
import type { Point2 } from './map/geo.ts';
import type { Graphics, Choice } from './graphics.ts';

interface DevHit { label: string; x: number; y: number }
interface StreetName { name: string; key: string; x: number; y: number }

// Developer panel (` key or ?dev): jump to a street or an address, or pick a spot on
// a map; set the time of day and the graphics. Street names come from the area's own index (offline); addresses are looked
// up on OpenStreetMap's Nominatim only when you ask for it.

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function setupDev({ area, index, teleport, position, helicopter, shiftTime, timeOfDay, setTimeOfDay, graphics }: {
  area: string; index: MapIndex; teleport: (x: number, y: number) => Promise<void>;
  position: () => Point2; helicopter: () => boolean; shiftTime: (hours: number) => void;
  // Seconds since midnight on the game's clock.
  timeOfDay: () => number; setTimeOfDay: (sec: number) => void;
  graphics: Graphics;
}) {
  const [w, s, e, n] = index.bbox_wgs84;
  const local = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
  const toLocal = (lon: number, lat: number): Point2 => proj4('EPSG:4326', local, [lon, lat]) as Point2;
  const toLonLat = (x: number, y: number): Point2 => proj4(local, 'EPSG:4326', [x, y]) as Point2;
  let names: StreetName[] | null = null;
  const loadNames = async () => {
    if (!names) {
      const r = await fetch(`data/${area}_now/names.json`);
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
    <input id="dev-q" type="search" placeholder="Street or address, e.g. Vodičkova or Karlovo náměstí 13" autocomplete="off" />
    <div id="dev-results"></div>
    <div class="dev-row">
      <button id="dev-map">Pick a spot on the map</button>
      <button id="dev-link" title="Copies a link that starts the game here">Copy link to this spot</button>
    </div>
    <div class="dev-row">
      <button id="dev-heli" title="Walk up to it and press E to fly it">Helicopter next to me</button>
    </div>
    <div class="dev-row">
      <button id="dev-earlier" title="The trams follow the timetable for the new time">An hour earlier</button>
      <button id="dev-later" title="The trams follow the timetable for the new time">An hour later</button>
    </div>
    <label class="dev-time">Time of day <span id="dev-time-label"></span>
      <input id="dev-time" type="range" min="0" max="1439" step="5" title="The trams follow the timetable for the new time" />
    </label>
    <label class="dev-time">Graphics <span id="dev-graphics-label"></span>
      <select id="dev-graphics">
        <option value="auto">Auto</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="lowest">Lowest</option>
      </select>
    </label>
    <div id="dev-pos"></div>`;
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

  const go = async (x: number, y: number, label: string) => {
    results.innerHTML = `<div class="dev-note">Going to ${label}…</div>`;
    await teleport(x, y);
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
    $('dev-link').textContent = 'Link copied';
    setTimeout(() => { $('dev-link').textContent = 'Copy link to this spot'; }, 1500);
  };

  const pick = $('dev-graphics') as HTMLSelectElement;
  pick.value = graphics.choice;
  pick.onchange = () => graphics.set(pick.value as Choice);
  pick.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  const time = $('dev-time') as HTMLInputElement;
  let dragging = false;
  time.oninput = () => { dragging = true; setTimeOfDay(+time.value * 60); };
  time.onchange = () => { dragging = false; };
  // Arrow keys move the slider, not the player.
  time.addEventListener('keydown', (ev) => { if (ev.code !== 'Backquote') ev.stopPropagation(); });
  time.addEventListener('keyup', (ev) => ev.stopPropagation());
  $('dev-earlier').onclick = () => shiftTime(-1);
  $('dev-later').onclick = () => shiftTime(1);
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
  overlay.innerHTML = '<div id="dev-leaflet"></div><div class="dev-maphint">Click where you want to be · <kbd>Esc</kbd> closes the map</div>';
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
      const [x, y] = position();
      const [lon, lat] = toLonLat(x, y);
      $('dev-pos').textContent = `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`;
      $('dev-graphics-label').textContent = graphics.choice === 'auto' ? `(${graphics.tier} now)` : '';
      if (document.activeElement !== pick) pick.value = graphics.choice;
      const min = Math.floor(timeOfDay() / 60);
      if (!dragging) time.value = String(min);
      $('dev-time-label').textContent = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    },
    toLocal,
  };
}
