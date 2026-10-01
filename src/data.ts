// The map lives beside the app locally and on mbxp. Cloudflare builds use the R2 origin.
const base = import.meta.env.VITE_DATA_URL ?? 'data/';
// The format of the map files this code reads: FORMAT in pipeline/layers.py, which
// writes it into index.json. Raise both together whenever older code couldn't read the
// new files. A map without the number was built before it existed, and counts as 1.
export const DATA_FORMAT = 1;
// When the loaded map was built (index.json's "built"), for the settings panel.
export const mapData = { built: '' };
export const dataUrl = (area: string, path: string) => `${base}${area}_now/${path}`;
