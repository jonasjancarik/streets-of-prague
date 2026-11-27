// The furniture OpenStreetMap has along the streets (pipeline/build_street_furniture.py:
// data/<area>_now/street-furniture.json): bins, bike stands, parking machines, bollards,
// post boxes and recycling containers. The land tile worker stands each one where the map
// has it (map/furniture.ts). Optional: without the file, or past the deadline, a tile has
// only the inferred furniture.
import { MAPPED } from './map/furniture.ts';

// [kind, x, y, angle (radians)] per item, in the game's kinds (FurnitureKind).
export async function mappedFurniture(url: string, timeout = 3000, fetcher: typeof fetch = fetch): Promise<Float32Array | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const res = await fetcher(url, { signal: controller.signal });
      if (!res.ok) return null;
      const { kinds, points } = await res.json() as { kinds?: unknown; points?: unknown };
      if (!Array.isArray(kinds) || !Array.isArray(points)) return null;
      const game = kinds.map(name => MAPPED[String(name)] ?? -1);
      const out: number[] = [];
      for (const row of points) {
        if (!Array.isArray(row)) continue;
        const [x, y, kind, degrees] = row as number[];
        if (game[kind] >= 0 && Number.isFinite(x) && Number.isFinite(y)) out.push(game[kind], x, y, (degrees || 0) * Math.PI / 180);
      }
      return new Float32Array(out);
    } catch { return null; }
  };
  try {
    return await Promise.race([read(), new Promise<null>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
