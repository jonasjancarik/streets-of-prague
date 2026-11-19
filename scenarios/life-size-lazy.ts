import type { Scenario } from '../src/testkit.ts';

// First person's life-size people (src/lifesize.ts): their code and avatars load only once
// you look from the street, and a while back in the view from above they're let go again.
interface Shell { enabled: boolean; freeAfter: number; loaded: boolean }
const shell = () => (window.__drive as { lifeSize: Shell }).lifeSize;
const requested = (part: string) => performance.getEntriesByType('resource').some((r) => r.name.includes(part));
// Avatars posed in the scene (the group's first child is the umbrellas).
const shown = () => {
  const g = (window.__drive as { scene: { getObjectByName(n: string): { children: { visible: boolean }[] } | undefined } }).scene.getObjectByName('rocketbox');
  return g ? g.children.slice(1).filter((c) => c.visible).length : 0;
};
const until = async (t: Parameters<Scenario['run']>[0], ok: () => boolean, seconds = 30) => {
  const end = performance.now() + seconds * 1000;
  while (!ok() && performance.now() < end) await t.frames(10);
  return ok();
};

export default {
  title: 'Life-size people load in first person and are let go after it',
  async run(t) {
    await t.go('staromak');
    t.time('14:00');
    t.weather('clear');
    const s = shell();
    if (!t.check('life-size people are on', s.enabled)) return;
    t.eyes = null;
    await t.frames(5);
    t.check('from above, no avatars are fetched', !requested('rocketbox/') && !s.loaded);
    t.eyes = { yaw: 0, pitch: 0 };
    t.check('the avatars load in first person', await until(t, () => s.loaded && requested('.glb')));
    t.check('and people near you are drawn life size', await until(t, () => shown() > 0), `${shown()} shown`);
    await t.shot('life-size-lazy');
    s.freeAfter = 1;
    t.eyes = null;
    t.check('back above, they are let go', await until(t, () => !s.loaded, 10));
    t.check('nobody is left in the scene', shown() === 0);
    t.eyes = { yaw: 0, pitch: 0 };
    t.check('and come back in first person', await until(t, () => s.loaded && shown() > 0), `${shown()} shown`);
    s.freeAfter = 120;
    t.eyes = null;
  },
} satisfies Scenario;
