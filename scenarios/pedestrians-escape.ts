import type { Scenario } from '../src/testkit.ts';

// A pedestrian stood in the road, `ahead` m in front of a car doing 50 km/h on a clear run.
async function crossing(t: Parameters<Scenario['run']>[0], mode: 'hit' | 'safe', ahead: number) {
  await t.go('vodickova', { heading: 315 });
  t.time('14:00');
  t.weather('clear');
  t.walkers(mode);
  await t.drive('hatch');
  if (!t.check('a clear run of road', !!t.post(80, 18, 14))) return null;
  const p = t.pedestrianAhead(ahead);
  if (!t.check('a pedestrian to stand in the way', !!p)) return null;
  t.push(50);
  let down = 0, jumped = false;
  for (let i = 0; i < 30; i++) {
    await t.wait(0.1);
    down = Math.max(down, t.downNear(p!.x, p!.y, 15));
    jumped ||= p!.state === 'flee';
  }
  return { down, jumped, speed: t.probe().speed };
}

export default {
  title: 'With "Always get away" on, nobody is knocked over by a car at 50 km/h; with it off, they can be',
  async run(t) {
    t.unhurt = true;
    const hit = await crossing(t, 'hit', 3);
    t.check('control: the pedestrian is knocked over when pedestrians can be hit', !!hit && hit.down > 0, JSON.stringify(hit));
    const safe = await crossing(t, 'safe', 3);
    t.check('nobody is knocked over', !!safe && safe.down === 0, JSON.stringify(safe));
    t.check('the pedestrian got away', !!safe && safe.jumped);
    t.check('the car kept going', !!safe && safe.speed > 10, `${safe?.speed} km/h`);
    t.walkers('hit');
    t.unhurt = false;
  },
} satisfies Scenario;
