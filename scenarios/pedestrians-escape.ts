import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A pedestrian standing in the road, 3 m in front of a car at 50 km/h, leaps clear and is not knocked over',
  async run(t) {
    await t.go('vodickova', { heading: 315 });
    t.time('14:00');
    t.weather('clear');
    t.unhurt = true;
    await t.drive('hatch');
    if (!t.check('a clear run of road', !!t.post(80, 18, 14))) return;
    const p = t.pedestrianAhead(3);
    if (!t.check('a pedestrian to stand in the way', !!p)) return;
    t.push(50);
    let down = 0, jumped = false;
    for (let i = 0; i < 30; i++) {
      await t.wait(0.1);
      down = Math.max(down, t.downNear(p!.x, p!.y, 15));
      jumped ||= p!.state === 'flee';
    }
    t.check('nobody is knocked over', down === 0, `${down}`);
    t.check('the pedestrian got away', jumped);
    t.check('the car kept going', t.probe().speed > 10, `${t.probe().speed} km/h`);
    t.unhurt = false;
  },
} satisfies Scenario;
