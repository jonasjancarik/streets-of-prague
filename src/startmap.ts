import type { Map as MapLibreMap, Marker, MapMouseEvent } from 'maplibre-gl';
import type { ExpressionSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { t } from './i18n.ts';
import prague from './prague.json';

// Where a new game begins, picked on a map from the start screen (startscreen.ts). Only
// inside Prague's city limits (src/prague.json, pipeline/build_prague_outline.py): the
// countryside past them is a trial, so everything outside is greyed out and a tap there
// only says so. The map is OpenFreeMap's vector tiles of OpenStreetMap (free, no key),
// drawn in the start screen's poster colours: paper land, dark river, red main roads,
// and loaded only when the map is first opened. The name shown for a spot is the street
// nearest to it on the map, and the part of town around it.

export interface StartSpot { lon: number; lat: number; name: string }

const RINGS: number[][] = prague.rings;
const PAPER = '#ece4d6', INK = '#140d0c', RED = '#c8241d';

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

// Widths in pixels that grow with the zoom, as streets do on a printed map.
const grow = (...stops: number[]) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops] as ExpressionSpecification;
const fade = (from: number, to: number) => ['interpolate', ['linear'], ['zoom'], from, 0, to, 1] as ExpressionSpecification;
const roads = (...classes: string[]) => ['all', ['in', ['get', 'class'], ['literal', classes]], ['!=', ['get', 'brunnel'], 'tunnel']] as ExpressionSpecification;
const nameCs = ['coalesce', ['get', 'name:cs'], ['get', 'name']] as ExpressionSpecification;

const style = (): StyleSpecification => ({
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
    outside: {
      type: 'geojson',
      data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...RINGS.map(ring)] } },
    },
    city: { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: RINGS.map(ring) } } },
  },
  layers: [
    { id: 'land', type: 'background', paint: { 'background-color': PAPER } },
    { id: 'works', type: 'fill', source: 'osm', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['industrial', 'railway']]], paint: { 'fill-color': '#e0d6c4' } },
    { id: 'green', type: 'fill', source: 'osm', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'grass', 'farmland', 'wetland']]], paint: { 'fill-color': ['match', ['get', 'class'], 'wood', '#b9bd8f', 'farmland', '#e2dbbd', '#cbcd9c'] } },
    { id: 'cemetery', type: 'fill', source: 'osm', 'source-layer': 'landuse', filter: ['==', ['get', 'class'], 'cemetery'], paint: { 'fill-color': '#c3c19f' } },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#34464f' } },
    { id: 'stream', type: 'line', source: 'osm', 'source-layer': 'waterway', filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'line-color': '#34464f', 'line-width': grow(12, 0.5, 18, 4) } },
    { id: 'buildings', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 14, paint: { 'fill-color': '#d3c3a8', 'fill-outline-color': '#bba98b', 'fill-opacity': fade(14, 15) } },
    { id: 'rail', type: 'line', source: 'osm', 'source-layer': 'transportation', filter: ['all', ['==', ['get', 'class'], 'rail'], ['!=', ['get', 'brunnel'], 'tunnel']], paint: { 'line-color': '#6c5d55', 'line-width': grow(11, 0.6, 18, 2.5), 'line-dasharray': [3, 2] } },
    { id: 'minor-edge', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 12, filter: roads('minor', 'service'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#bfae92', 'line-opacity': fade(12, 13.5), 'line-width': grow(12, 1, 18, 18) } },
    { id: 'minor', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 12, filter: roads('minor', 'service'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#faf6ee', 'line-opacity': fade(12, 13.5), 'line-width': grow(12, 0.5, 18, 15) } },
    { id: 'path', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 15, filter: roads('path', 'track', 'pedestrian'), paint: { 'line-color': '#9b8a72', 'line-width': grow(15, 0.6, 18, 1.6), 'line-dasharray': [2, 1.5] } },
    { id: 'main-edge', type: 'line', source: 'osm', 'source-layer': 'transportation', filter: roads('primary', 'secondary', 'tertiary'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': INK, 'line-opacity': 0.6, 'line-width': grow(10, 2.2, 18, 27) } },
    { id: 'main', type: 'line', source: 'osm', 'source-layer': 'transportation', filter: roads('primary', 'secondary', 'tertiary'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fffaf0', 'line-width': grow(10, 1.2, 18, 23) } },
    { id: 'fast-edge', type: 'line', source: 'osm', 'source-layer': 'transportation', filter: roads('motorway', 'trunk'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': INK, 'line-width': grow(9, 1.6, 18, 30) } },
    { id: 'fast', type: 'line', source: 'osm', 'source-layer': 'transportation', filter: roads('motorway', 'trunk'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': RED, 'line-width': grow(9, 1, 18, 26) } },
    // Hit areas for naming a picked spot: the streets' names, not drawn.
    { id: 'street-hits', type: 'line', source: 'osm', 'source-layer': 'transportation_name', paint: { 'line-opacity': 0, 'line-width': 24 } },
    { id: 'river-name', type: 'symbol', source: 'osm', 'source-layer': 'water_name', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'text-field': nameCs, 'text-font': ['Noto Sans Italic'], 'text-size': grow(12, 12, 17, 18), 'text-letter-spacing': 0.3, 'symbol-placement': 'line' }, paint: { 'text-color': PAPER, 'text-opacity': 0.8 } },
    { id: 'street-name', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 14, layout: { 'text-field': nameCs, 'text-font': ['Noto Sans Regular'], 'text-size': grow(14, 10, 18, 15), 'symbol-placement': 'line', 'text-max-angle': 30 }, paint: { 'text-color': '#3e322c', 'text-halo-color': '#fffaf0', 'text-halo-width': 1.4 } },
    { id: 'place-name', type: 'symbol', source: 'osm', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet']]], layout: { 'text-field': ['upcase', nameCs], 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'suburb', 15, 'quarter', 13, 11.5] as ExpressionSpecification, 'text-letter-spacing': 0.12, 'text-max-width': 8 }, paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 2 } },
    // Past the city limits, greyed out over everything, names too.
    { id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': INK, 'fill-opacity': 0.7 } },
    { id: 'limits', type: 'line', source: 'city', layout: { 'line-join': 'round' }, paint: { 'line-color': RED, 'line-width': grow(9, 2, 16, 5) } },
  ],
});

let map: MapLibreMap | null = null, marker: Marker | null = null, box: HTMLElement | null = null;

// Opens the map over the start screen; resolves with the spot picked, or null if it
// was closed without one (Esc, or the cross).
export async function pickStart(root: HTMLElement, current: StartSpot | null): Promise<StartSpot | null> {
  if (!box) {
    box = document.createElement('div');
    box.className = 'sm';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<div class="sm-map"></div>
      <div class="sm-top"><span class="sm-title"></span><button type="button" class="sm-close"></button></div>
      <div class="sm-bar"><div class="sm-text"><span class="sm-place"></span><span class="sm-note"></span></div><button type="button" class="sm-go"></button></div>`;
    root.appendChild(box);
  }
  const el = box, part = (cls: string) => el.querySelector(`.${cls}`) as HTMLElement;
  const place = part('sm-place'), note = part('sm-note'), go = part('sm-go') as HTMLButtonElement, close = part('sm-close');
  part('sm-title').textContent = t('Where do you want to start?');
  close.textContent = '×';
  close.setAttribute('aria-label', t('Close the map'));
  el.setAttribute('aria-label', t('Where do you want to start?'));
  go.textContent = t('Start here');
  let picked = current;
  const describe = () => {
    place.textContent = picked ? picked.name : '';
    note.textContent = picked ? '' : t('Tap a street anywhere in Prague.');
    go.disabled = !picked;
  };
  describe();
  el.hidden = false;

  if (!map) {
    note.textContent = t('Loading the map…');
    const [lib, worker] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'), import('maplibre-gl/dist/maplibre-gl.css')]);
    // Bundled, MapLibre can't find its worker beside itself: it is handed the file.
    lib.setWorkerUrl(worker.default);
    map = new lib.Map({
      container: part('sm-map'), style: style(), bounds: [W, S, E, N], fitBoundsOptions: { padding: 24 },
      maxBounds: [W - 0.25, S - 0.15, E + 0.25, N + 0.15], minZoom: 9, maxZoom: 18.5,
      dragRotate: false, pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
    });
    // The credits start unfolded, over the bar on a phone: folded to their (i) once the map is in.
    map.once('idle', () => { const credits = part('sm-map').querySelector('.maplibregl-compact-show'); credits?.classList.remove('maplibregl-compact-show'); credits?.removeAttribute('open'); });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    const pin = document.createElement('div');
    pin.className = 'sm-pin';
    pin.appendChild(document.createElement('span'));
    marker = new lib.Marker({ element: pin, anchor: 'bottom' });
    describe();
  }
  const m = map;
  m.resize();
  if (picked) {
    marker!.setLngLat([picked.lon, picked.lat]).addTo(m);
    m.jumpTo({ center: [picked.lon, picked.lat], zoom: Math.max(m.getZoom(), 15) });
  } else marker!.remove();

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
    const finish = (spot: StartSpot | null) => {
      m.off('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      go.onclick = close.onclick = null;
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
    close.onclick = () => finish(null);
  });
}
