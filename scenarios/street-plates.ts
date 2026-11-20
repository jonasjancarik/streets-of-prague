import type { Scene, Mesh } from 'three';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Read the enamel plate at the Husova junction',
  async run(t) {
    await t.go([50.086768, 14.417380], { heading: 180 });
    t.eyes = { yaw: 0, pitch: 0 };
    const { scene } = window.__drive as { scene: Scene };
    const signs = () => {
      const found: Mesh[] = [];
      scene.traverse(o => { if (o.name === 'Street name plate') found.push(o as Mesh); });
      return found;
    };
    try {
      const deadline = performance.now() + 30000;
      while (!signs().some(p => p.userData.street === 'Husova') && performance.now() < deadline) await t.frames(3);
      const sign = signs().find(p => p.userData.street === 'Husova');
      if (!t.check('a street-facing wall carries Husova', !!sign) || !sign) return;
      t.check('the caption identifies the cadastral area and borough', sign.userData.caption === 'Staré Město – Praha 1', sign.userData.caption);
      t.check('the plate belongs to the detailed façade', !!sign.parent?.userData.streetFacade);
      t.eyes = null;
      await t.frames(3);
      t.check('returning overhead releases the nearby plates', !signs().length && !sign.parent);
    } finally { t.eyes = null; }
  },
} satisfies Scenario;
