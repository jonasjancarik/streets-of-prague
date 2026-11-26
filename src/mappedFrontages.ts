import { SIGN_WORDS } from './facadeFinishes.ts';

interface WallBox { x0: number; x1: number; z0: number; z1: number; nx: number; nz: number }

// What a trade from pipeline/build_shops.py looks like in its window: `stock`, the picture
// in shop-displays.webp (0 books, 1 bakery, 2 flowers, 3 ceramics; none: the shopfront's
// usual pick), and `word`, the fascia's word in SIGN_WORDS (none: a plain fascia).
// Trades not named here, "shop" among them, get both defaults.
const TRADES: Record<string, { stock?: number; word?: string }> = {
  books: { stock: 0, word: 'KNIHKUPECTVÍ' }, stationery: { stock: 0, word: 'PAPÍRNICTVÍ' },
  bakery: { stock: 1, word: 'PEKAŘSTVÍ' }, confectionery: { stock: 1, word: 'CUKRÁRNA' }, cafe: { stock: 1, word: 'KAVÁRNA' },
  florist: { stock: 2, word: 'KVĚTINY' },
  gift: { stock: 3, word: 'SUVENÝRY' }, art: { stock: 3, word: 'GALERIE' }, antiques: { stock: 3, word: 'STAROŽITNOSTI' },
  restaurant: { word: 'RESTAURACE' }, bar: { word: 'BAR' }, pub: { word: 'PIVNICE' }, fast_food: { word: 'BISTRO' },
  ice_cream: { word: 'ZMRZLINA' }, pharmacy: { word: 'LÉKÁRNA' }, chemist: { word: 'DROGERIE' }, bank: { word: 'BANKA' },
  exchange: { word: 'SMĚNÁRNA' }, clothes: { word: 'MÓDA' }, shoes: { word: 'OBUV' }, grocery: { word: 'POTRAVINY' },
  butcher: { word: 'ŘEZNICTVÍ' }, hairdresser: { word: 'KADEŘNICTVÍ' }, beauty: { word: 'KOSMETIKA' },
  jewelry: { word: 'ŠPERKY' }, wine: { word: 'VINOTÉKA' }, optician: { word: 'OPTIKA' }, tobacco: { word: 'TRAFIKA' },
  toys: { word: 'HRAČKY' }, electronics: { word: 'ELEKTRO' }, massage: { word: 'MASÁŽE' },
};
const CELL = 64;
// Street façades wait this long at most for the file before building without it.
const PATIENCE = 4000;

interface Ray { x: number; z: number; dx: number; dz: number; length: number; stock: number; word: number }

// OpenStreetMap's shops, cafés, restaurants and pubs, as rays from the street to the shop
// (data/<area>_now/shops.json, pipeline/build_shops.py). A ray avoids decorating the back
// of the building or another shop across the street. Without the file there are none.
export class MappedFrontages {
  private cells = new Map<string, Ray[]>();
  // Resolves when the file has been read, has failed, or PATIENCE has passed.
  readonly ready: Promise<void>;
  settled = false;
  // `url`: the area's shops.json (dataUrl(area, 'shops.json')).
  constructor(url?: string) {
    if (!url) { this.settled = true; this.ready = Promise.resolve(); return; }
    const load = fetch(url).then(r => (r.ok ? r.json() as Promise<unknown> : null))
      .then(d => this.read(d)).catch(() => {});
    this.ready = Promise.race([load, new Promise<void>(done => setTimeout(done, PATIENCE))]).then(() => { this.settled = true; });
  }

  private read(d: unknown) {
    const { trades, shops } = (d ?? {}) as { trades?: unknown; shops?: unknown };
    if (!Array.isArray(trades) || !Array.isArray(shops)) return;
    const looks = trades.map(name => {
      const t = TRADES[String(name)] ?? {};
      return { stock: t.stock ?? -1, word: t.word ? SIGN_WORDS.indexOf(t.word) : -1 };
    });
    for (const row of shops) {
      if (!Array.isArray(row)) continue;
      const [sx, sy, px, py, trade] = row as number[];
      const look = looks[trade];
      if (!look || ![sx, sy, px, py].every(Number.isFinite)) continue;
      // The game's z runs south.
      const dx = px - sx, dz = sy - py, length = Math.hypot(dx, dz);
      if (!(length > 0)) continue;
      const ray: Ray = { x: sx, z: -sy, dx: dx / length, dz: dz / length, length, ...look };
      const xs = [sx, px], zs = [-sy, -py];
      for (let cx = Math.floor(Math.min(...xs) / CELL); cx <= Math.floor(Math.max(...xs) / CELL); cx++)
        for (let cz = Math.floor(Math.min(...zs) / CELL); cz <= Math.floor(Math.max(...zs) / CELL); cz++) {
          const key = cx + ',' + cz, list = this.cells.get(key);
          if (list) list.push(ray); else this.cells.set(key, [ray]);
        }
    }
  }

  // [along the wall's facade u, stock, word] for each mapped shop whose ray meets this wall.
  onWall(w: WallBox, pos: Float32Array, facade: Float32Array) {
    const hits: number[] = [];
    const mx = (w.x0 + w.x1) / 2, mz = (w.z0 + w.z1) / 2;
    const seen = new Set<Ray>();
    for (let cx = Math.floor((w.x0 - 20) / CELL); cx <= Math.floor((w.x1 + 20) / CELL); cx++)
      for (let cz = Math.floor((w.z0 - 20) / CELL); cz <= Math.floor((w.z1 + 20) / CELL); cz++) {
        for (const r of this.cells.get(cx + ',' + cz) ?? []) {
          if (seen.has(r)) continue;
          seen.add(r);
          if (r.x < w.x0 - 20 || r.x > w.x1 + 20 || r.z < w.z0 - 20 || r.z > w.z1 + 20) continue;
          const facing = r.dx * w.nx + r.dz * w.nz;
          if (facing > -.65) continue;
          const reach = ((mx - r.x) * w.nx + (mz - r.z) * w.nz) / facing;
          if (reach < 2 || reach > r.length + 3 || r.length - reach > 10) continue;
          const x = r.x + r.dx * reach, z = r.z + r.dz * reach;
          if (x < w.x0 - .15 || x > w.x1 + .15 || z < w.z0 - .15 || z > w.z1 + .15) continue;
          // Follow the source triangle's along-wall axis, including reversed bays.
          for (let i = 1; i < pos.length / 3; i++) {
            const dx = pos[i * 3] - pos[0], dz = pos[i * 3 + 2] - pos[2], d2 = dx * dx + dz * dz;
            if (d2 < .25) continue;
            hits.push(facade[0] + (facade[i * 4] - facade[0]) * ((x - pos[0]) * dx + (z - pos[2]) * dz) / d2, r.stock, r.word);
            break;
          }
        }
      }
    return new Float32Array(hits);
  }
}
