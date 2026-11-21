import type { PerspectiveCamera } from 'three';
import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import { t as translate } from '../src/i18n.ts';

export default {
  title: 'Follow walking directions from Vodičkova and switch between walking and driving',
  async run(t) {
    const { walker, camera } = window.__drive as { walker: Walker; camera: PerspectiveCamera };
    const saved = t.eyes;
    const card = document.getElementById('nav')!;
    try {
      await t.go([50.08084206, 14.42449525], { heading: 127 });
      t.eyes = { yaw: 0, pitch: 0 };
      await t.frames(3);
      t.navTo(50.08016, 14.42549);
      for (let i = 0; i < 35 && !t.nav().reached; i++) await t.frames(2);
      const first = t.nav(), map = t.navLine();
      t.check(
        'the walking route reaches the picked spot',
        first.walking && first.reached && first.length > 80 && first.turns.length > 0,
        first,
      );
      t.check(
        'the minimap and directions show the path',
        !!map && map.pts.length > 3 && !card.hidden && card.innerText.length > 0,
        card.innerText,
      );
      if (!map) return;
      const x = walker.x, y = walker.y;
      // Follow the first part on foot using the ordinary movement. The target
      // and direction display must move with the walker.
      for (let i = 0; i < 25; i++) {
        const r = t.navLine();
        if (!r) break;
        let k = 1;
        while (k < r.cum.length - 1 && r.cum[k] < r.from + 2) k++;
        const q = r.pts[k];
        walker.h = Math.atan2(q[1] - walker.y, q[0] - walker.x);
        await t.wait(.15, { move: 1 });
      }
      t.check('progress follows the walk', Math.hypot(walker.x - x, walker.y - y) > 5 && t.nav().along > 4, t.nav().along);
      await t.shot('first-person-walking-directions');
      const c = t.car('hatch', { ahead: 3 });
      await t.enter(c);
      await t.frames(4);
      t.check('getting into the car changes to driving directions for the same pin', !t.nav().walking && !!t.nav().to);
      const behind = -(camera.position.x - c.x) * Math.cos(c.h) + (camera.position.z + c.y) * Math.sin(c.h);
      t.check(
        'FPS driving follows behind and above the car',
        behind > c.spec.L / 2 + 3 &&
          camera.position.y > (c.gz ?? 0) + c.spec.H && camera.fov === 55,
        { behind, fov: camera.fov },
      );
      t.exit();
      await t.frames(4);
      t.check('getting out restores walking directions', t.nav().walking && !!t.nav().to);
      t.navTo();
      await t.frames(3);
      t.check('clearing the pin clears the card and minimap route', card.hidden && !t.navLine());
      // The public map button opens the map for the current form of travel.
      const button = [...document.querySelectorAll<HTMLButtonElement>('.corner-btn')]
        .find((b) => b.ariaLabel === translate('Map and directions (N)'));
      button?.click();
      const picker = document.querySelector<HTMLElement>('.sm:not([hidden])');
      t.check(
        'the map offers a walking destination',
        picker?.querySelector('.sm-go')?.textContent === translate('Walk here'),
      );
      const close = picker?.querySelector<HTMLButtonElement>('.sm-close');
      const deadline = performance.now() + 5000;
      while (close && !close.onclick && performance.now() < deadline) await t.frames(1);
      close?.click();
    } finally {
      t.navTo();
      t.eyes = saved;
    }
  },
} satisfies Scenario;
