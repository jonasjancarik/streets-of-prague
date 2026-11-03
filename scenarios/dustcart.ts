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
    for (let i = 0; i < 120 && g.refuse.rounds[0] && g.refuse.rounds[0].phase !== 'work'; i++) { await t.wait(0.5); follow(round().car); }
    const cartNow = g.refuse.rounds[0]?.car;
    if (!t.check('it stops at another house', !!cartNow)) return;
    await (t as unknown as { enter: (c: unknown) => Promise<unknown> }).enter(cartNow);
    await t.wait(1);
    const crew = g.refuse.crew.map((m) => m.job);
    t.check('taken, the crew get down and walk off', t.where().mode !== 'foot' && crew.length > 0 && crew.every((j) => j === 'leave'), { crew, mode: t.where().mode });
    t.exit();
    t.empty(false);
  },
} satisfies Scenario;
