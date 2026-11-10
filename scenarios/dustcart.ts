import type { Scenario } from '../src/testkit.ts';

// A dustcart on its round: it crawls along with its crew on the steps, stops by a house,
// the dustmen fetch the bins out, the lift tips them, they take them back in, climb on
// again and the cart goes on.
export default {
  title: 'Dustcart: stops by a house, the crew wheel the bins out to the lift and back, and ride on',
  async run(t) {
    await t.go('vodickova', { heading: 0 });
    t.time('09:00');
    t.weather('clear');
    t.empty();
    const kit = t as unknown as { dustcart: (r?: number) => unknown; rounds: () => { phase: string; speed: number; crew: string[]; bins: number; car: { x: number; y: number } }[] };
    let cart = null;
    for (let i = 0; i < 10 && !cart; i++) { cart = kit.dustcart(150); if (!cart) await t.wait(0.5); }
    if (!t.check('a dustcart turns up', !!cart)) return;
    const round = () => kit.rounds()[0];
    t.check('the crew ride on the back', round().crew.every((j) => j === 'ride'), round().crew);
    const seen = new Set<string>();
    let top = 0, stopped = false, shot = false;
    // (You keep near it, walking along behind: a cart left far behind you is taken off the streets.)
    const me = (window.__drive as { walker: { x: number; y: number } }).walker;
    const follow = (c: { x: number; y: number; h?: number }) => { if (Math.hypot(c.x - me.x, c.y - me.y) > 60) { me.x = c.x - Math.cos(c.h ?? 0) * 12; me.y = c.y - Math.sin(c.h ?? 0) * 12; } };
    for (let i = 0; i < 240; i++) {
      await t.wait(0.5);
      const r = round();
      if (!r) break;
      follow(r.car);
      top = Math.max(top, r.speed);
      r.crew.forEach((j) => seen.add(j));
      if (r.phase === 'work') stopped = true;
      if (!shot && r.crew.includes('tip')) {
        shot = true;
        const [lon, lat] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(r.car.x, r.car.y);
        t.camera({ at: [lat, lon], height: 28, tilt: 0 });
        await t.wait(0.2);
        await t.shot('dustcart-tip');
        t.camera(null);
      }
      if (stopped && seen.has('tip') && r.phase === 'drive' && r.speed > 1) break;
    }
    const r = round();
    t.check('it crawls along', top > 2 && top < 6.5, top);
    t.check('it stops by a house', stopped);
    t.check('the crew go in for the bins and tip them', ['fetch', 'in', 'wheel', 'tip', 'return', 'back'].every((j) => seen.has(j)), [...seen]);
    t.check('everyone back on the steps and the cart going on', !!r && r.phase === 'drive' && r.crew.every((j) => j === 'ride'), r && { phase: r.phase, crew: r.crew });
    t.check('no bin left behind', !!r && r.bins === 0, r?.bins);

    // Taken from them, while it works a house: the crew get down and walk off.
    const g = window.__drive as { refuse: { rounds: { phase: string; car: unknown }[]; crew: { job: string }[] } };
    // (Taken while they're off at the bins: anyone back on the steps by then stays there, below.)
    const atBins = () => g.refuse.rounds[0]?.phase === 'work' && round().crew.every((j) => ['fetch', 'in', 'wheel', 'tip', 'return'].includes(j));
    for (let i = 0; i < 240 && g.refuse.rounds[0] && !atBins(); i++) { await t.wait(0.25); follow(round().car); }
    const cartNow = g.refuse.rounds[0]?.car;
    if (!t.check('it stops at another house, the crew off at the bins', !!cartNow && atBins(), round()?.crew)) return;
    await (t as unknown as { enter: (c: unknown) => Promise<unknown> }).enter(cartNow);
    await t.wait(1);
    const crew = g.refuse.crew.map((m) => m.job);
    t.check('taken, the crew get down and walk off', t.where().mode !== 'foot' && crew.length > 0 && crew.every((j) => j === 'leave'), { crew, mode: t.where().mode });
    t.exit();

    // Taken on the move, with the crew on the steps: they stay on, holding tight, until you
    // go too fast; the one who falls off runs after it and climbs on again once you stop.
    let next = null;
    for (let i = 0; i < 10 && !next; i++) { next = kit.dustcart(150); if (!next) await t.wait(0.5); }
    if (!t.check('another dustcart turns up', !!next)) return;
    const mine = () => g.refuse.rounds.find((k) => k.car === next) as unknown as { phase: string; crew: { job: string; down: number; x: number; y: number }[] } | undefined;
    for (let i = 0; i < 30 && mine()?.phase !== 'drive'; i++) await t.wait(0.5);
    await t.wait(1);
    if (!t.check('on its way, the crew on the steps', !!mine()?.crew.every((m) => m.job === 'ride'), mine()?.crew.map((m) => m.job))) return;
    await (t as unknown as { enter: (c: unknown) => Promise<unknown> }).enter(next);
    await t.wait(2, { move: 0.4 });
    const car = next as { speed: number; x: number; y: number };
    t.check('taken on the move, they stay on at a crawl', t.where().mode === 'car' && mine()!.crew.every((m) => m.job === 'ride'), { crew: mine()!.crew.map((m) => m.job), kmh: Math.round(car.speed * 3.6) });
    // (Stopped, and turned to the longest clear run along the street: a crash knocks them off too.)
    for (let i = 0; i < 12 && car.speed > 0.3; i++) await t.wait(0.25, { brake: true });
    const h0 = t.where().heading, run = (h: number) => Math.min(...[-1.5, 0, 1.5].map((sd) => t.runway(h, 120, sd)));
    const best = [0, 180, -10, 10, 170, 190].map((d) => h0 + d).sort((a, b) => run(b) - run(a))[0];
    t.push(0, best);
    // (Something the run doesn't see, a parked car, can end it in a crash: that throws them off as well.)
    let fellAt = 0, peak = 0;
    for (let i = 0; i < 60 && !fellAt; i++) {
      await t.wait(0.25, { move: 1 });
      peak = Math.max(peak, car.speed * 3.6);
      if (mine()!.crew.some((m) => m.job !== 'ride')) fellAt = car.speed * 3.6;
    }
    t.check('going fast (or crashing), someone falls off', fellAt > 0, { kmh: Math.round(fellAt), peak: Math.round(peak) });
    const [lon2, lat2] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(car.x, car.y);
    t.camera({ at: [lat2, lon2], height: 40, tilt: 0 });
    await t.wait(0.3, { move: 1 });
    await t.shot('dustcart-fall');
    t.camera(null);
    for (let i = 0; i < 40 && !mine()!.crew.every((m) => m.job === 'ride'); i++) await t.wait(0.5, { brake: true });
    t.check('stopped for him, he climbs on again', mine()!.crew.every((m) => m.job === 'ride'), mine()!.crew.map((m) => m.job));
    t.exit();
    t.empty(false);
  },
} satisfies Scenario;
