import type { Scenario } from '../src/testkit.ts';
import type { Car, CarSpec } from '../src/car.ts';
import type { TwoWheel } from '../src/twoWheel.ts';

// Riding a bike or motorbike (src/twoWheel.ts): it turns by leaning, and the lean takes a
// moment; the grip is shared between leaning and braking, so grabbing the brakes in a
// bend slides it out from under you; rain makes it lean less. The bicycle's speed comes
// from the hills, braking hard down a steep one throws you over the bars, and kerbs
// bump you head-on, throw you when hit fast, and wash the wheel out at a shallow angle.
// (The hills and kerbs are checked on made-up ground, with the model on its own.)
export default {
  title: 'Bikes and motorbikes lean into turns, slide out braking in a bend, and meet hills and kerbs as they would',
  async run(t) {
    const was = t.paused;
    try {
      // On open ground, steering hard left.
      const ride = async (type: string, weather: 'clear' | 'rain', brakeAt = Infinity, kmh = 40) => {
        t.paused = false;
        await t.go('staromak', { heading: 90 });
        t.time('14:00');
        // (At once, the road already wet through: t.weather wets it over some 40 s.)
        (window.__drive as { weather: { set(kind: string, instantly: boolean): void } }).weather.set(weather, true);
        t.empty();
        const c = await t.drive(type);
        if (!t.clearing(18, 400) && !t.clearing(12, 400)) return null;
        t.paused = true;
        t.push(kmh);
        const lean: number[] = [];
        let off = -1;
        for (let i = 0; i < 40; i++) {
          await t.wait(0.05, { move: i * 0.05 >= brakeAt ? -1 : 0.15, turn: 1 });
          lean.push(Math.abs(c.lean) * 57.3);
          if (!t.probe().car) { off = i * 0.05; break; }
        }
        return { c, lean, most: Math.max(...lean), off, radius: Math.abs(c.forwardSpeed / c.w) };
      };
      const dry = await ride('moto', 'clear');
      if (!t.check('open ground for the motorbike', !!dry)) return;
      t.check('it leans into the turn over about half a second', dry!.lean[1] < 15 && dry!.lean[19] > 30, `${Math.round(dry!.lean[1])}° after 0.1 s, ${Math.round(dry!.lean[19])}° after 1 s`);
      t.check('and stays on, leaned 35–48°, on a wide arc', dry!.off < 0 && dry!.most > 35 && dry!.most < 49 && dry!.radius > 10, `${Math.round(dry!.most)}°, ${Math.round(dry!.radius)} m round`);
      // (Slower: leaned less, it goes round wider, about 22 m at 40 km/h.)
      const wet = await ride('moto', 'rain', Infinity, 25);
      t.check('on a wet road it leans less', !!wet && wet.off < 0 && wet.most < dry!.most - 4, `${Math.round(wet?.most ?? 0)}° against ${Math.round(dry!.most)}°`);
      const grab = await ride('moto', 'clear', 1.2);
      t.check('grabbing the brakes in the lean slides it out from under you', !!grab && grab.off > 1.2 && grab.off < 1.8, `off after ${grab?.off.toFixed(2)} s`);
      t.check('and it lies on its side', !!grab?.c.tipped);
      await t.shot('bike-slide');

      // The model on made-up ground (a straight road, or a kerb along x = 0).
      t.paused = false;
      t.empty();
      const bike = await t.drive('bike');
      await t.wait(0.1);
      const Wheels = bike.wheels!.constructor as new () => TwoWheel;
      t.exit();
      const moto = await t.drive('moto');
      const spec = (type: string): CarSpec => (type === 'bike' ? bike : moto).spec;
      const sim = (type: string, o: { slope?: number; throttle?: number; kmh?: number; angle?: number; x?: number; kerb?: number; secs?: number }) => {
        const w = new Wheels(), a = (o.angle ?? 0) / 57.3, v = (o.kmh ?? 0) / 3.6, S = spec(type);
        const r = { x: o.x ?? -3, y: 0, h: a, w: 0, vx: Math.cos(a) * v, vy: Math.sin(a) * v, braking: false, skidFront: 0, skidBack: 0, lean: 0, pedaling: false } as unknown as Car;
        const k = o.kerb ?? 0, height = (x: number) => k * Math.min(1, Math.max(0, x / 0.35));
        for (let i = 0; i < (o.secs ?? 3) * 60; i++) {
          const fall = w.step(r, S, S, { throttle: o.throttle ?? 0, steer: 0, handbrake: false }, o.throttle ?? 0, 1, o.slope ?? 0, 1 / 60, k ? height : undefined);
          r.x += r.vx / 60;
          r.y += r.vy / 60;
          if (fall) return fall;
        }
        return Math.round(Math.hypot(r.vx, r.vy) * 3.6);
      };
      const level = sim('bike', { throttle: 1, secs: 60 }), up = sim('bike', { throttle: 1, slope: 0.08, secs: 60 });
      t.check('a bicycle does about 32 km/h on the level and 11 up an 8 % street', level as number > 29 && level as number < 35 && up as number > 9 && up as number < 14, `${level}, ${up} km/h`);
      t.check('braking hard down 8 % is fine', typeof sim('bike', { throttle: -1, slope: -0.08, kmh: 30 }) === 'number');
      t.check('braking hard down 18 % throws you over the bars', sim('bike', { throttle: -1, slope: -0.18, kmh: 30 }) === 'over');
      const kerbs = {
        head: sim('bike', { kerb: 0.12, kmh: 15 }), fast: sim('bike', { kerb: 0.12, kmh: 30 }), shallow: sim('bike', { kerb: 0.12, kmh: 20, angle: 75, x: -1.5 }),
        along: sim('bike', { kerb: 0.12, kmh: 20, angle: 88, x: -0.5 }), down: sim('bike', { kerb: 0.12, kmh: 20, angle: 180, x: 3 }), moto: sim('moto', { kerb: 0.12, kmh: 30 }),
      };
      t.check('a kerb ridden at head-on at 15 km/h is a bump', typeof kerbs.head === 'number' && kerbs.head < 15, JSON.stringify(kerbs));
      t.check('at 30 km/h it throws you (but not off a motorbike)', kerbs.fast === 'over' && typeof kerbs.moto === 'number');
      t.check('crossing one at 15° washes the front wheel out', kerbs.shallow === 'kerb');
      t.check('riding alongside one, or down off it, is fine', typeof kerbs.along === 'number' && typeof kerbs.down === 'number');
    } finally {
      t.paused = was;
    }
  },
} satisfies Scenario;
