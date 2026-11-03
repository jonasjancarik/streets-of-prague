import type { Map as MapLibreMap, Marker, MapMouseEvent } from 'maplibre-gl';
import { t } from './i18n.ts';
import { INK, RED, foldCredits, grow, loadMapLibre, posterStyle } from './postermap.ts';
import prague from './prague.json';

// Where a new game begins, picked on a map from the start screen (startscreen.ts), and
// in the game where to drive to (satnav.ts, `pickSpot`). Only inside Prague's city limits (src/prague.json, pipeline/build_prague_outline.py): the
// countryside past them is a trial, so everything outside is greyed out and a tap there
// only says so. The map is drawn in the poster's colours (postermap.ts). The name shown
// for a spot is the street nearest to it on the map, and the part of town around it.

export interface StartSpot { lon: number; lat: number; name: string }

const RINGS: number[][] = prague.rings;

// Inside an odd number of the rings is inside the city.
export function inPrague(lon: number, lat: number) {
  let odd = false;
  for (const r of RINGS) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > lat) !== (yj > lat) && lon < r[j] + ((lat - yj) / (yi - yj)) * (r[i] - r[j])) odd = !odd;
    }
  }
  return odd;
}

const ring = (r: number[]) => { const out: [number, number][] = []; for (let i = 0; i < r.length; i += 2) out.push([r[i], r[i + 1]]); out.push(out[0]); return out; };
const [W, S, E, N] = RINGS[0].reduce((b, v, i) => i % 2 ? [b[0], Math.min(b[1], v), b[2], Math.max(b[3], v)] : [Math.min(b[0], v), b[1], Math.max(b[2], v), b[3]], [180, 90, -180, -90]);

// The poster map with everything past the city limits greyed out, names too, under a
// red line along them; and the streets' names as hit areas for naming a picked spot.
const style = () => posterStyle({
  outside: {
    type: 'geojson',
    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...RINGS.map(ring)] } },
  },
  city: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: RINGS.map(ring) } } },
}, [
  { id: 'street-hits', type: 'line', source: 'osm', 'source-layer': 'transportation_name', paint: { 'line-opacity': 0, 'line-width': 24 } },
  { id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': INK, 'fill-opacity': 0.7 } },
  { id: 'limits', type: 'line', source: 'city', layout: { 'line-join': 'round' }, paint: { 'line-color': RED, 'line-width': grow(9, 2, 16, 5) } },
]);

let map: MapLibreMap | null = null, marker: Marker | null = null, you: Marker | null = null, box: HTMLElement | null = null;

export interface PickOptions {
  title: string;
  // The button that takes the spot, and what to say until one is picked.
  go: string;
  hint: string;
  current: StartSpot | null;
  // Where you are (lon, lat): a dot on the map, which opens round it.
  here?: [number, number] | null;
  // A second button, resolving with 'stop' (stop navigating), while there's something to stop.
  stop?: string | null;
}

// The map is up.
export const mapOpen = () => !!box && !box.hidden;

// Opens the map over the start screen; resolves with the spot picked, or null if it
// was closed without one (Esc, or the cross).
export async function pickStart(root: HTMLElement, current: StartSpot | null): Promise<StartSpot | null> {
  const spot = await pickSpot(root, { title: t('Where do you want to start?'), go: t('Start here'), hint: t('Tap a street anywhere in Prague.'), current });
  return spot === 'stop' ? null : spot;
}

export async function pickSpot(root: HTMLElement, o: PickOptions): Promise<StartSpot | 'stop' | null> {
  if (!box) {
    box = document.createElement('div');
    box.className = 'sm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<div class="sm-map"></div>
      <div class="sm-top"><span class="sm-title"></span><button type="button" class="sm-close"></button></div>
      <div class="sm-bar"><div class="sm-text"><span class="sm-place"></span><span class="sm-note"></span></div><button type="button" class="sm-stop" hidden></button><button type="button" class="sm-go"></button></div>`;
  }
  if (box.parentElement !== root) root.appendChild(box);
  const el = box, part = (cls: string) => el.querySelector(`.${cls}`) as HTMLElement;
  const place = part('sm-place'), note = part('sm-note'), go = part('sm-go') as HTMLButtonElement, close = part('sm-close'), stop = part('sm-stop') as HTMLButtonElement;
  part('sm-title').textContent = o.title;
  close.textContent = '×';
  close.setAttribute('aria-label', t('Close the map'));
  el.setAttribute('aria-label', o.title);
  go.textContent = o.go;
  stop.textContent = o.stop ?? '';
  stop.hidden = !o.stop;
  let picked = o.current;
  const describe = () => {
    place.textContent = picked ? picked.name : '';
    note.textContent = picked ? '' : o.hint;
    go.disabled = !picked;
  };
  describe();
  el.hidden = false;

  if (!map) {
    note.textContent = t('Loading the map…');
    const lib = await loadMapLibre();
    map = new lib.Map({
      container: part('sm-map'), style: style(), bounds: [W, S, E, N], fitBoundsOptions: { padding: 24 },
      maxBounds: [W - 0.25, S - 0.15, E + 0.25, N + 0.15], minZoom: 9, maxZoom: 18.5,
      dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
    });
    foldCredits(map);
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    const pin = document.createElement('div');
    pin.className = 'sm-pin';
    pin.appendChild(document.createElement('span'));
    marker = new lib.Marker({ element: pin, anchor: 'bottom' });
    const dot = document.createElement('div');
    dot.className = 'sm-you';
    you = new lib.Marker({ element: dot });
    describe();
  }
  const m = map;
  m.resize();
  if (o.here) you!.setLngLat(o.here).addTo(m); else you!.remove();
  if (picked) marker!.setLngLat([picked.lon, picked.lat]).addTo(m);
  else marker!.remove();
  const centre = o.here ?? (picked ? [picked.lon, picked.lat] as [number, number] : null);
  if (centre) m.jumpTo({ center: centre, zoom: Math.max(m.getZoom(), 15) });

  return new Promise((resolve) => {
    // The street under the tap (the nearest name within a few metres), and the part of
    // town whose name is nearest on screen.
    const nameAt = (e: MapMouseEvent) => {
      const { x, y } = e.point, near = (f: { geometry: GeoJSON.Geometry }) => {
        const pts = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates.flat() : f.geometry.type === 'Point' ? [f.geometry.coordinates] : [];
        return Math.min(...pts.map((c) => { const p = m.project(c as [number, number]); return Math.hypot(p.x - x, p.y - y); }));
      };
      const named = <F extends { geometry: GeoJSON.Geometry; properties: Record<string, unknown> }>(fs: F[]) => fs
        .map((f) => ({ name: String(f.properties['name:cs'] ?? f.properties.name ?? ''), d: near(f) }))
        .filter((f) => f.name).sort((a, b) => a.d - b.d)[0]?.name ?? '';
      const street = named(m.queryRenderedFeatures([[x - 24, y - 24], [x + 24, y + 24]], { layers: ['street-hits'] }));
      const area = named(m.queryRenderedFeatures({ layers: ['place-name'] }).filter((f) => f.geometry.type === 'Point' && inPrague(f.geometry.coordinates[0], f.geometry.coordinates[1])));
      return [street, area].filter(Boolean).join(' · ') || t('A spot in Prague');
    };
    const onClick = (e: MapMouseEvent) => {
      const { lng, lat } = e.lngLat;
      if (!inPrague(lng, lat)) {
        note.textContent = t('The game is set in Prague. Pick a spot inside the red line.');
        return;
      }
      picked = { lon: lng, lat, name: nameAt(e) };
      marker!.setLngLat([lng, lat]).addTo(m);
      describe();
      go.focus();
    };
    const finish = (spot: StartSpot | 'stop' | null) => {
      m.off('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      go.onclick = close.onclick = stop.onclick = null;
      el.hidden = true;
      resolve(spot);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      finish(null);
    };
    m.on('click', onClick);
    document.addEventListener('keydown', onKey, true);
    go.onclick = () => finish(picked);
    stop.onclick = () => finish('stop');
    close.onclick = () => finish(null);
  });
}
