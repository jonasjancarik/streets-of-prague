import type { ExpressionSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

// The game's maps of the real city (the start screen's, startmap.ts, and the developer
// tools', dev.ts): OpenFreeMap's vector tiles of OpenStreetMap (free, no key), drawn
// with MapLibre in the start screen's poster colours: paper land, dark river, red fast
// roads, white main streets, names in Czech. MapLibre is loaded only when a map is
// first opened.

export const PAPER = '#ece4d6', INK = '#140d0c', RED = '#c8241d';

// Widths in pixels that grow with the zoom, as streets do on a printed map.
export const grow = (...stops: number[]) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops] as ExpressionSpecification;
const fade = (from: number, to: number) => ['interpolate', ['linear'], ['zoom'], from, 0, to, 1] as ExpressionSpecification;
const roads = (...classes: string[]) => ['all', ['in', ['get', 'class'], ['literal', classes]], ['!=', ['get', 'brunnel'], 'tunnel']] as ExpressionSpecification;
const nameCs = ['coalesce', ['get', 'name:cs'], ['get', 'name']] as ExpressionSpecification;

// The style, with a map's own sources and layers drawn over everything else.
export const posterStyle = (sources: Record<string, SourceSpecification> = {}, layers: LayerSpecification[] = []): StyleSpecification => ({
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    osm: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' },
    ...sources,
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
    { id: 'river-name', type: 'symbol', source: 'osm', 'source-layer': 'water_name', filter: ['==', ['geometry-type'], 'LineString'], layout: { 'text-field': nameCs, 'text-font': ['Noto Sans Italic'], 'text-size': grow(12, 12, 17, 18), 'text-letter-spacing': 0.3, 'symbol-placement': 'line' }, paint: { 'text-color': PAPER, 'text-opacity': 0.8 } },
    { id: 'street-name', type: 'symbol', source: 'osm', 'source-layer': 'transportation_name', minzoom: 14, layout: { 'text-field': nameCs, 'text-font': ['Noto Sans Regular'], 'text-size': grow(14, 10, 18, 15), 'symbol-placement': 'line', 'text-max-angle': 30 }, paint: { 'text-color': '#3e322c', 'text-halo-color': '#fffaf0', 'text-halo-width': 1.4 } },
    { id: 'place-name', type: 'symbol', source: 'osm', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['suburb', 'quarter', 'neighbourhood', 'village', 'hamlet']]], layout: { 'text-field': ['upcase', nameCs], 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'suburb', 15, 'quarter', 13, 11.5] as ExpressionSpecification, 'text-letter-spacing': 0.12, 'text-max-width': 8 }, paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 2 } },
    // Towns and cities, for a map zoomed out past one city.
    { id: 'town-name', type: 'symbol', source: 'osm', 'source-layer': 'place', maxzoom: 11, filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]], layout: { 'text-field': ['upcase', nameCs], 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 18, 14] as ExpressionSpecification, 'text-letter-spacing': 0.12 }, paint: { 'text-color': INK, 'text-halo-color': PAPER, 'text-halo-width': 2 } },
    ...layers,
  ],
});

// MapLibre, its worker and its stylesheet. Bundled, it can't find its worker beside
// itself, so it is handed the file (as a .js, which every server sends as JavaScript).
export async function loadMapLibre() {
  const [lib, worker] = await Promise.all([import('maplibre-gl'), import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'), import('maplibre-gl/dist/maplibre-gl.css')]);
  lib.setWorkerUrl(worker.default);
  return lib;
}

// Credits start unfolded, over whatever is at the bottom on a phone: folded to their (i)
// once the map is in.
export function foldCredits(map: { once(type: 'idle', f: () => void): unknown; getContainer(): HTMLElement }) {
  map.once('idle', () => {
    const credits = map.getContainer().querySelector('.maplibregl-compact-show');
    credits?.classList.remove('maplibregl-compact-show');
    credits?.removeAttribute('open');
  });
}
