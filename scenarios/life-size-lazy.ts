import type { Scenario } from '../src/testkit.ts';

interface Shell { enabled: boolean; freeAfter: number; loaded: boolean }
const shell = () => (window.__drive as { lifeSize: Shell }).lifeSize;
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
  title: 'Life-size people appear as their models arrive, then unload outside street view',
  async run(t) {
    await t.go('staromak');
    t.time('14:00');
    t.weather('clear');
    const s = shell();
    if (!t.check('life-size people are on', s.enabled)) return;
    const saved = t.eyes, freeAfter = s.freeAfter, fetch = window.fetch;
    let release!: () => void, delayed = false, requests = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      t.eyes = null;
      s.freeAfter = .25;
      if (!await until(t, () => !s.loaded)) throw new Error('The earlier street view is still loaded');
      window.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('rocketbox/')) requests++;
        if (url.endsWith('/rocketbox/business-male-03.glb')) { delayed = true; await gate; }
        return fetch.call(window, input, init);
      };
      await t.frames(5);
      t.check('from above, no avatars are fetched', requests === 0 && !s.loaded);
      t.eyes = { yaw: 0, pitch: 0 };
      if (!t.check('one character model is still downloading', await until(t, () => delayed))) return;
      t.check('other people appear while that download waits', await until(t, () => shown() > 0), shown());
      release();
      await t.shot('life-size-lazy');
      t.eyes = null;
      t.check('back above, the avatars and their scene objects are released', await until(t, () => !s.loaded) && shown() === 0);
      t.eyes = { yaw: 0, pitch: 0 };
      t.check('the people return on the next visit', await until(t, () => shown() > 0), shown());
    } finally {
      release();
      window.fetch = fetch;
      s.freeAfter = freeAfter;
      t.eyes = saved;
    }
  },
} satisfies Scenario;
