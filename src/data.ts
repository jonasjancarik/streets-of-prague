// The map lives beside the app locally and on mbxp. Cloudflare builds use the R2 origin.
const base = import.meta.env.VITE_DATA_URL ?? 'data/';
// The format of the map files this code reads: FORMAT in pipeline/layers.py, which
// writes it into index.json. Raise both together whenever older code couldn't read the
// new files. A map without the number was built before it existed, and counts as 1.
export const DATA_FORMAT = 2;
// When the loaded map was built (index.json's "built"), for the settings panel.
export const mapData = { built: '' };
export const dataUrl = (area: string, path: string) => `${base}${area}_now/${path}`;
// OpenStreetMap vector tiles (Protomaps' basemap) for the countryside past the built
// map, read by range requests (countryside.ts): one file beside the map, or on R2.
// Ground heights for that countryside: Mapzen's terrain tiles in the Terrarium layout,
// kept as open data at AWS ({z}/{x}/{y}.png is added). Empty: the countryside stays flat.
export const elevationUrl: string = import.meta.env.VITE_ELEVATION_URL ?? 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
export const countrysideUrl: string = import.meta.env.VITE_COUNTRYSIDE_URL ?? `${base}countryside/central-bohemia.pmtiles`;
