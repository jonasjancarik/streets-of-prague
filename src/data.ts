// The map lives beside the app locally and on mbxp. Cloudflare builds use the R2 origin.
const base = import.meta.env.VITE_DATA_URL ?? 'data/';
export const dataUrl = (area: string, path: string) => `${base}${area}_now/${path}`;
