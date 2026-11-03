import type { Scenario } from '../src/testkit.ts';

// The player's pistol: bullets go into cars (damage, smashed lamps, in the end a fire),
// stop at walls, and never hit anyone, however many people stand in the way. Players
// have no pistol: it's handed out here as the developer panel does.
export default {
  title: 'The pistol: cars take the bullets, walls stop them, people are never hit and run',
  async run(t) {
    await t.go('karlak', { heading: 324 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    t.gun(false);
    t.check('players have no gun', t.shoot(0) === null);
    t.gun(true);
    // A car parked a little way off, and people put right in the line of fire.
    const car = t.car('sedan', { ahead: 14 });
    if (!t.check('a car to shoot at', !!car)) return;
    const g = window.__drive as {
      crowd: { people: { state: string; x: number; y: number }[] }; police: { heat: number; reports: unknown[] }; fires: { onFire: (c: unknown) => boolean };
      walker: { x: number; y: number }; grid: { at: (x: number, y: number) => number }; loose: { x: number; y: number }[];
    };
    // Stand where nothing but open ground is between you and the car, 12 m off.
    const clear = (x: number, y: number) => {
      if (g.loose.some((c) => c !== car && Math.hypot(c.x - x, c.y - y) < 4)) return false;
      for (let s = 0; s <= 1; s += 0.05) if (g.grid.at(x + (car!.x - x) * s, y + (car!.y - y) * s) !== 0 && s < 0.85) return false;
      return true;
    };
    const stand = Array.from({ length: 16 }, (_, i) => [car!.x + Math.cos(i * Math.PI / 8) * 12, car!.y + Math.sin(i * Math.PI / 8) * 12]).find(([x, y]) => clear(x, y));
    if (!t.check('somewhere with a clear shot at it', !!stand)) return;
    g.walker.x = stand![0]; g.walker.y = stand![1];
    const from = g.walker;
    const people = g.crowd.people.filter((p) => p.state !== 'down').slice(0, 6);
    const dx = car!.x - from.x, dy = car!.y - from.y;
    people.forEach((p, i) => { p.x = from.x + dx * (0.2 + 0.1 * i); p.y = from.y + dy * (0.2 + 0.1 * i); });
    const before = car!.damage;
    const hit = t.shoot({ x: car!.x, y: car!.y });
    t.check('the bullet goes into the car', hit?.car === car, JSON.stringify({ d: hit?.d, tram: hit?.tram, other: hit?.car && { type: hit.car.type, mode: hit.car.mode, x: hit.car.x - g.walker.x, y: hit.car.y - g.walker.y }, target: { x: car!.x - g.walker.x, y: car!.y - g.walker.y } }));
    t.check('and damages it', car!.damage > before, `${before} -> ${car!.damage}`);
    t.check('nobody in the way is hit', people.every((p) => p.state !== 'down'), people.map((p) => p.state).join(','));
    await t.wait(0.3);
    t.check('the people near it run', people.some((p) => p.state === 'flee'), people.map((p) => p.state).join(','));
    t.check('shooting is a crime', t.probe().stars > 0 || g.police.heat > 0 || g.police.reports.length > 0, `heat ${g.police.heat}`);
    // Into the lamps: the headlamps go first from the front.
    for (let i = 0; i < 14 && !car!.burnt && car!.damage < 95; i++) { t.shoot({ x: car!.x, y: car!.y }); await t.wait(0.3); }
    t.check('enough bullets set it burning', g.fires.onFire(car!) || !!car!.burnt, `damage ${Math.round(car!.damage)}`);
    await t.shot('pistol-car');

    // At a wall: the bullet stops at it.
    await t.go('karlova', { heading: 90 });
    const wallAt = t.runway(0);
    const north = t.shoot(0);
    t.check('a wall stops the bullet', !!north && (wallAt < 0 || north.d <= wallAt + 1), `wall ${wallAt}, bullet ${north?.d}`);
    t.gun(false);
  },
} satisfies Scenario;
