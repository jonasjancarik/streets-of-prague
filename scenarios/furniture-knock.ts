import type { Scenario } from '../src/testkit.ts';
import { KIND } from '../src/map/furniture.ts';
import { onCrash } from '../src/impacts.ts';

// Plan 040: a car knocks street furniture loose. Each comes loose, is thrown on ahead of
// the car and comes to rest on the ground, and the car keeps going, slowed more by what's
// heavy or bolted down (a bench, a parking machine) than by a bin. A bin hit hard spills
// its rubbish and a glass bell its broken bottles. `far`: how far it should go (m).
const CASES = [
  { name: 'bin', kinds: [KIND.bin], kmh: 50, keep: 0.85, far: [3, 30], spills: true },
  { name: 'bench', kinds: [KIND.bench], kmh: 50, keep: 0.6, far: [3, 30] },
  { name: 'container', kinds: [KIND.plastic, KIND.paper, KIND.cartons, KIND.metal], kmh: 40, keep: 0.7, far: [3, 45] },
  { name: 'poster case', kinds: [KIND.posterCase], kmh: 50, keep: 0.7, far: [3, 30] },
  { name: 'glass bell', kinds: [KIND.glass, KIND.clearGlass], kmh: 40, keep: 0.45, far: [1.5, 25], spills: true },
  { name: 'bike stand', kinds: [KIND.bikeStand], kmh: 50, keep: 0.5, far: [2, 30] }, // (in a row: two or three go)
  { name: 'parking machine', kinds: [KIND.parkingMachine], kmh: 50, keep: 0.45, far: [1.5, 25] },
  { name: 'cabinet', kinds: [KIND.cabinet], kmh: 60, keep: 0.35, far: [1.5, 25] }, // (often two, one behind the other)
  { name: 'bollard', kinds: [KIND.bollard], kmh: 50, keep: 0.45, far: [1.5, 30] }, // (often in a row)
  { name: 'post box', kinds: [KIND.postBox], kmh: 50, keep: 0.4, far: [1.5, 25] },
  { name: 'planter', kinds: [KIND.planter], kmh: 50, keep: 0.15, far: [1, 20] }, // (700 kg of concrete and earth: the car keeps 12–15 km/h)
];
// Where to look for each, in turn.
const PLACES = ['vodickova', 'karlak', 'mustek', 'staromak', 'ujezd', 'malostranske'];

export default {
  title: 'A car at 40–50 km/h knocks street furniture loose, and bins and glass bells spill',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    const world = (window.__drive as { world: { surfaceAt(x: number, y: number, l: number): number } }).world;
    for (const c of CASES) {
      let piece = null, car = null;
      for (const place of PLACES) {
        await t.go(place, { heading: 315 });
        car = await t.drive('hatch');
        // (Where there's none on its own, one in a row or a group, through its neighbours.)
        for (const through of [false, true]) {
          for (const kind of c.kinds) if ((piece = t.piece(kind, 400, 16, through ? 3 : 10, through))) break;
          if (piece) break;
        }
        if (piece) break;
      }
      if (!piece || !car) { t.check(`a ${c.name} with a clear run up to it`, true, 'none found: skipped'); continue; }
      await t.wait(0.3, { brake: true }); // the place round it loaded
      const chips = (window.__drive as { fires: { debris: { chips: { list: unknown[] } } } }).fires.debris.chips;
      const hits: string[] = [], chipsBefore = chips.list.length;
      // (What the car ran into on the way, for when it never gets there.)
      const stop = onCrash((e) => { if (e.a === car && hits.length < 6) hits.push(`${e.kind} ${e.speed.toFixed(1)} m/s ${Math.hypot(e.x - piece!.x, e.y - piece!.y).toFixed(1)} m off`); });
      t.push(c.kmh);
      // On at that speed until it's hit (a 16 m run up), a moment more, then off the gas
      // and on the brakes so the car doesn't push it along.
      // (By where it stood: pieces from tiles that have gone are dropped from the list.)
      const it = () => t.pieces().find((b) => Math.hypot(b.from[0] - piece!.x, b.from[1] - piece!.y) < 0.01);
      for (let i = 0; i < 40 && !it(); i++) await t.wait(0.05, { move: 0.4 });
      await t.wait(0.1, { move: 0.4 });
      const speed = Math.hypot(car.vx, car.vy) * 3.6;
      await t.wait(4, { brake: true });
      stop();
      const p = it();
      if (!p) {
        // What stood in the way: the cells along the run as the car meets them (# solid,
        // o the piece, c the car), the run left to right.
        const w = window.__drive as { world: { cellAt(x: number, y: number, l: number, z: number): number } };
        const h = Math.atan2(piece.y - car.y, piece.x - car.x), cs = Math.cos(h), sn = Math.sin(h), rows: string[] = [];
        for (let o = 2; o >= -2; o -= 0.5) {
          let row = '';
          for (let d = -6; d <= 2; d += 0.25) {
            const x = piece.x + cs * d - sn * o, y = piece.y + sn * d + cs * o;
            row += Math.hypot(x - piece.x, y - piece.y) < 0.3 ? 'o' : Math.hypot(x - car.x, y - car.y) < 0.3 ? 'c' : w.world.cellAt(x, y, 0, piece.z) === 255 ? '#' : '.';
          }
          rows.push(row);
        }
        hits.push(...rows, `standing there: ${t.standingNear(piece.x, piece.y, 3).length}, loose near: ${t.pieces().filter((b) => Math.hypot(b.from[0] - piece.x, b.from[1] - piece.y) < 3).length}`);
      }
      t.check(`the ${c.name} came loose`, !!p, hits.join(' | '));
      if (!p) continue;
      const moved = Math.hypot(p.x - piece.x, p.y - piece.y), up = p.z - world.surfaceAt(p.x, p.y, 0);
      t.check(`the car kept going (${c.name})`, speed > c.kmh * c.keep, `${Math.round(speed)} km/h`);
      t.check(`the ${c.name} was thrown on`, moved > c.far[0] && moved < c.far[1], `${moved.toFixed(1)} m`);
      if (c.spills) t.check(`the ${c.name} spilled`, chips.list.length - chipsBefore > 15, `${chips.list.length - chipsBefore} bits`);
      t.check(`the ${c.name} lies on the ground`, up > 0 && up < 1.3, `middle ${up.toFixed(2)} m up, its top ${p.up.toFixed(2)}`);
      t.check(`the ${c.name} came to rest`, !p.awake || Math.hypot(p.vx, p.vy) < 0.3);
      await t.look({ x: p.x, y: p.y, h: Math.atan2(p.y - car.y, p.x - car.x) }, { name: `furniture-knock-${c.name.replaceAll(' ', '-')}`, views: ['top', 'third', 'front-left', 'front-right'] });
      // And from above at about the height you drive with, where it lies and where it stood.
      const [lon, lat] = (window.__drive as { dev: { toLonLat(x: number, y: number): [number, number] } }).dev.toLonLat((p.x + piece.x) / 2, (p.y + piece.y) / 2);
      await t.camera({ at: [lat, lon], height: 45, tilt: 0, heading: 0 });
      await t.frames(5);
      await t.shot(`furniture-knock-${c.name.replaceAll(' ', '-')}-above`);
      await t.camera(null);
    }
  },
} satisfies Scenario;
