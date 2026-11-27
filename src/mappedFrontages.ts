import { SIGN_WORDS } from './facadeFinishes.ts';
import { RayGrid, type WallBox } from './rayGrid.ts';


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
// Street façades wait this long at most for the file before building without it.
const PATIENCE = 4000;

// OpenStreetMap's shops, cafés, restaurants and pubs, as rays from the street to the shop
// (data/<area>_now/shops.json, pipeline/build_shops.py). A ray avoids decorating the back
// of the building or another shop across the street. Without the file there are none.
// Memorial plaques come the same way, from street-furniture.json's "plaques"
// (pipeline/build_street_furniture.py).
export class MappedFrontages {
  private rays = new RayGrid<{ stock: number; word: number }>();
  private plaques = new RayGrid<true>(12);
  // Resolves when the file has been read, has failed, or PATIENCE has passed.
  readonly ready: Promise<void>;
  settled = false;
  // `url`: the area's shops.json (dataUrl(area, 'shops.json')); `furniture`: its
  // street-furniture.json, for the plaques.
  constructor(url?: string, furniture?: string) {
    if (!url) { this.settled = true; this.ready = Promise.resolve(); return; }
    const get = (u?: string) => u ? fetch(u).then(r => (r.ok ? r.json() as Promise<unknown> : null)).catch(() => null) : Promise.resolve(null);
    const load = Promise.all([get(url).then(d => this.read(d)), get(furniture).then(d => {
      const rows = (d as { plaques?: unknown } | null)?.plaques;
      if (Array.isArray(rows)) for (const r of rows) if (Array.isArray(r)) this.plaques.add(r[0], r[1], r[2], r[3], true);
    })]).catch(() => {});
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
      if (look) this.rays.add(sx, sy, px, py, look);
    }
  }

  // Where (x, z) on the wall is along its facade u, following the source triangle's
  // along-wall axis, including reversed bays.
  private along(x: number, z: number, pos: Float32Array, facade: Float32Array) {
    for (let i = 1; i < pos.length / 3; i++) {
      const dx = pos[i * 3] - pos[0], dz = pos[i * 3 + 2] - pos[2], d2 = dx * dx + dz * dz;
      if (d2 >= .25) return facade[0] + (facade[i * 4] - facade[0]) * ((x - pos[0]) * dx + (z - pos[2]) * dz) / d2;
    }
    return NaN;
  }
  // [along the wall's facade u, stock, word] for each mapped shop whose ray meets this wall.
  onWall(w: WallBox, pos: Float32Array, facade: Float32Array) {
    const hits: number[] = [];
    for (const { x, z, data } of this.rays.hits(w)) {
      const u = this.along(x, z, pos, facade);
      if (Number.isFinite(u)) hits.push(u, data.stock, data.word);
    }
    return new Float32Array(hits);
  }
  // Along the wall's facade u, each memorial plaque mapped on it.
  plaquesOnWall(w: WallBox, pos: Float32Array, facade: Float32Array) {
    return Float32Array.from(this.plaques.hits(w).map(({ x, z }) => this.along(x, z, pos, facade)).filter(Number.isFinite));
  }
}
