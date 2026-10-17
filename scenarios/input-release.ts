import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Releasing a key in a developer field or leaving the window stops walking',
  async run(t) {
    await t.go('karlak', { heading: 324 });
    t.set({ stars: 0, health: 100 });
    const wasPaused = t.paused;
    t.paused = false;
    const key = (type: string, target: EventTarget = window) => target.dispatchEvent(new KeyboardEvent(type, { code: 'KeyW', bubbles: true }));
    try {
      const field = document.getElementById('dev-q');
      if (!t.check('developer search field is available', !!field)) return;
      key('keydown');
      await t.frames(50);
      t.check('holding W starts walking', t.probe().speed > 1, `${t.probe().speed} km/h`);
      // Developer inputs stop bubbling key events so typing cannot drive the game.
      key('keyup', field!);
      await t.frames(50);
      t.check('release in a field stops walking', t.probe().speed < 0.5, `${t.probe().speed} km/h`);
      key('keydown');
      await t.frames(30);
      t.check('a fresh press starts walking again', t.probe().speed > 1, `${t.probe().speed} km/h`);
      window.dispatchEvent(new Event('blur'));
      await t.frames(50);
      t.check('leaving the window releases held movement', t.probe().speed < 0.5, `${t.probe().speed} km/h`);
    } finally {
      key('keyup');
      window.dispatchEvent(new Event('focus'));
      t.paused = wasPaused;
    }
  },
} satisfies Scenario;
