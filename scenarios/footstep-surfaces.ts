import type { Sound } from '../src/audio.ts';
import type { Footing } from '../src/map/footing.ts';
import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'First-person footsteps follow paving, grass, gravel and snow through Újezd',
  async run(t) {
    const { sound } = window.__drive as { sound: Sound };
    const original = sound.footfall, wasOn = sound.on, saved = t.eyes;
    let contacts: Footing[] = [];
    try {
      sound.on = true;
      sound.footfall = function (kind, strength, ground = 'hard') {
        if (kind === 'step') contacts.push(ground);
        original.call(this, kind, strength, ground);
      };
      t.eyes = { yaw: 0, pitch: 0 };
      for (
        const [at, heading, season, expected] of [
          [[50.080641, 14.405157], 90, 'clear', 'hard'],
          [[50.080882, 14.404360], 358, 'clear', 'grass'],
          [[50.079688, 14.403500], 358, 'clear', 'gravel'],
          [[50.080882, 14.404360], 358, 'snow', 'snow'],
        ] as const
      ) {
        await t.go([at[0], at[1]], { heading });
        t.weather(season);
        contacts = [];
        await t.wait(1.8, { move: 1 });
        t.check('walking on ' + expected, contacts.length >= 2 && contacts.every((c) => c === expected), contacts);
      }
      await t.go([50.08084206, 14.42449525], { heading: 127 });
      t.weather('snow');
      await t.wait(3.6, { move: 1 });
      contacts = [];
      await t.wait(1.5, { move: 1 });
      t.check(
        'the arcade floor stays dry while it snows outside',
        contacts.length >= 2 && contacts.every((c) => c === 'hard'),
        contacts,
      );
    } finally {
      sound.footfall = original;
      sound.on = wasOn;
      t.eyes = saved;
    }
  },
} satisfies Scenario;
