import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';
import type { Car } from '../src/car.ts';

// From three stars the police set up roadblocks ahead of you (src/roadblock.ts): cars
// parked nose to nose across the street on the way you're driving, out of your sight,
// officers behind them, a gap between the noses you can just get through; ramming them
// costs you; they go once you're past or the chase is over.
export default {
  title: 'Roadblock: set up ahead on your way, across the street with a gap, officers behind; through the gap, or rammed at a cost; cleared once past',
  async run(t) {
    const g = window.__drive as { police: Police; car: Car | null; loose: Car[]; simulate: (dt: number, ctl?: object) => void };
    const P = g.police;
    const kit = t as unknown as { unhurt: boolean };
    const spawn = P.spawn;
    // A long straight: Štěpánská, northwards from Ječná.
    const from: [number, number] = [50.07590, 14.42420], to: [number, number] = [50.07972, 14.42592];
    const ahead = (c: { x: number; y: number }, b: { x: number; y: number; ang: number }) => (c.x - b.x) * Math.cos(b.ang) + (c.y - b.y) * Math.sin(b.ang);
    const across = (c: { x: number; y: number }, b: { x: number; y: number; ang: number }) => -(c.x - b.x) * Math.sin(b.ang) + (c.y - b.y) * Math.cos(b.ang);
    let prev: Car | null = null;
    const set = async () => {
      // (Not the car you crashed last time, left standing in the street.)
      if (prev && g.loose.includes(prev)) g.loose.splice(g.loose.indexOf(prev), 1);
      await t.go(from, { heading: 15 });
      t.time('14:00');
      t.weather('clear');
      t.empty();
      await t.drive('sedan');
      const c = prev = g.car!, [ex, ey] = t.toLocal(to);
      c.h = Math.atan2(ey - c.y, ex - c.x);
      t.push(50);
      // (No chase cars: only the block.)
      P.spawn = () => false;
      t.set({ stars: 3 });
      P.reset();
      return c;
    };
    const me = (c: Car) => ({ x: c.x, y: c.y, z: 0, level: 0, vx: c.vx, vy: c.vy, speed: Math.hypot(c.vx, c.vy), car: c, air: false, riding: false });
    kit.unhurt = true;
    try {
      let c = await set();
      const ok = P.roadblock(me(c));
      const b = P.block;
      if (!t.check('a roadblock is set up', ok && !!b)) return;
      const along = ahead(b!, { x: c.x, y: c.y, ang: c.h }), off = Math.abs(across(b!, { x: c.x, y: c.y, ang: c.h }));
      t.check('ahead on your way, out of sight', along > 100 && along < 340 && off < 8, { along: Math.round(along), off: +off.toFixed(1) });
      t.check('two cars or more, across the street', b!.cars.length >= 2 && b!.cars.every((q) => Math.abs(ahead(q, b!)) < 4),
        b!.cars.map((q) => `${across(q, b!).toFixed(1)} m across, turned ${Math.round(((q.h - b!.ang) * 180 / Math.PI + 540) % 360 - 180)}°`).join('; '));
      const officers = P.officers.filter((o) => o.block === b);
      t.check('an officer behind each car', officers.length === b!.cars.length && officers.every((o) => ahead(o, b!) > 0.5),
        officers.map((o) => ahead(o, b!).toFixed(1)).join(', '));
      // (The world stands still while we look: you'd otherwise drive into it meanwhile.)
      t.paused = true;
      P.blockT = 999;
      const ll = (x: number, y: number): [number, number] => { const [lon, lat] = (window.__drive as { dev: { toLonLat: (x: number, y: number) => [number, number] } }).dev.toLonLat(x, y); return [lat, lon]; };
      t.view(4);
      await t.camera({ at: ll(b!.x, b!.y), height: 30, tilt: 0 });
      await t.shot('roadblock-above');
      t.view(1);
      await t.camera({ at: ll(b!.x, b!.y), height: 2.5, tilt: 72, heading: 90 - (b!.ang * 180) / Math.PI, level: true });
      await t.shot('roadblock-street');
      await t.camera(null);

      // Through the gap at 30 km/h: between the two middle cars.
      const mid = (across(b!.cars[0], b!) + across(b!.cars[1], b!)) / 2;
      c.x = b!.x - Math.cos(b!.ang) * 25 - Math.sin(b!.ang) * mid;
      c.y = b!.y - Math.sin(b!.ang) * 25 + Math.cos(b!.ang) * mid;
      c.h = b!.ang;
      t.push(30);
      const before = c.damage, hb = b!.ang;
      const aim = { h: hb, mag: 1 };
      // (The officers shoot at you as you go by: those hits aren't from the cars.)
      const shoot = P.shoot;
      let shotAt = 0;
      P.shoot = (...a) => { const d0 = c.damage; shoot.apply(P, a); shotAt += c.damage - d0; };
      for (let i = 0; i < 4 * 60; i++) {
        const v = Math.hypot(c.vx, c.vy);
        g.simulate(1 / 60, { move: v < 30 / 3.6 ? 1 : 0, aim });
      }
      P.shoot = shoot;
      t.paused = false;
      const v = Math.hypot(c.vx, c.vy) * 3.6;
      t.check('a careful driver gets through the gap', ahead(c, b!) > 5 && v > 20 && c.damage - before - shotAt < 2, { past: Math.round(ahead(c, b!)), kmh: Math.round(v), scraped: +(c.damage - before - shotAt).toFixed(1), shot: shotAt });
      await t.wait(4, { move: 1, aim });
      // (Its cars may well come after you now, as any patrol nearby would.)
      const left = P.officers.filter((o) => o.block === b).length, standing = P.cars.filter((p) => p.block === b).length;
      t.check('cleared once you are past', b!.done && P.block !== b && !left && !standing,
        { done: b!.done, block: P.block === b, left, standing, chasing: P.chasing.filter((p) => b!.cars.includes(p.car)).length, posted: P.officers.filter((o) => o.post).length, past: Math.round(ahead(c, b!)), off: +across(c, b!).toFixed(1) });

      // Rammed: at 50 km/h into one of the cars.
      c = await set();
      // (Give the camera a moment to come back from up the street: they set up only out of sight.)
      for (let i = 0; i < 20 && !P.block; i++) {
        await t.wait(0.1);
        P.roadblock(me(c));
      }
      const r = P.block;
      if (!t.check('another roadblock', !!r, { street: !!P.nearestStreet(c.x, c.y, 12), seen: P.offscreen(c.x + Math.cos(c.h) * 120, c.y + Math.sin(c.h) * 120) ? 'no' : 'yes', kmh: Math.round(Math.hypot(c.vx, c.vy) * 3.6) })) return;
      const target = r!.cars[0];
      c.x = target.x - Math.cos(r!.ang) * 20;
      c.y = target.y - Math.sin(r!.ang) * 20;
      c.h = r!.ang;
      t.push(50);
      const dmg = c.damage;
      t.paused = true;
      let slowest = Infinity;
      for (let i = 0; i < 2.5 * 60; i++) {
        g.simulate(1 / 60, { move: 1, aim: { h: r!.ang, mag: 1 } });
        if (ahead(c, r!) > -2 && ahead(c, r!) < 6) slowest = Math.min(slowest, Math.hypot(c.vx, c.vy) * 3.6);
      }
      t.paused = false;
      t.check('ramming it costs you speed and damage', slowest < 30 && c.damage > dmg, { slowest: Math.round(slowest), damage: Math.round(c.damage - dmg) });

      // The chase over: the block goes.
      P.forgive();
      await t.wait(0.5);
      t.check('cleared when the chase ends', !P.block && P.officers.every((o) => !o.post), { block: !!P.block });
    } finally {
      P.spawn = spawn;
      t.paused = false;
      kit.unhurt = false;
      t.set({ stars: 0 });
      t.empty(false);
    }
  },
} satisfies Scenario;
