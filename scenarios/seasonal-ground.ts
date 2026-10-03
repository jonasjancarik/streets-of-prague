import type { Scenario } from '../src/testkit.ts';
import { GROUND_SEASON, WOOD_SEASON, FIELD_SEASON, HEDGE_SEASON } from '../src/groundSeason.ts';

// Run once per renderer with scripts/scene.mjs. Exact cameras and dates are kept
// here so the eight-date sheets remain comparable without reloading the game.
const dates = ['01-15', '03-15', '04-20', '05-20', '07-15', '08-20', '10-20', '11-15'];
const places = [
  { name: 'park', at: [50.083, 14.4073] as [number, number], height: 70, tilt: 30, heading: 90 },
  { name: 'woods', at: [50.08456415, 14.39211258] as [number, number], height: 55, tilt: 35, heading: 90 },
  { name: 'street', at: [50.076, 14.4185] as [number, number], height: 65, tilt: 30, heading: 0 },
];

export default {
  title: 'Ground and evergreen hedges follow the game date without replacing surfaces',
  async run(t) {
    const paused = t.paused;
    const panel = document.getElementById('dev'), panelDisplay = panel?.style.display;
    if (panel) panel.style.display = 'none';
    t.paused = true;
    try {
      for (const place of places) {
        await t.go(place.at);
        await t.camera(place);
        for (const date of dates) {
          t.season(date);
          t.time('14:00');
          t.weather('clear');
          await t.wait(1 / 60); // publish the date through the real weather update
          t.check(`${place.name} ${date}: game date`, t.probe().date === date);
          await t.shot(`season-${place.name}-${date}`);
          if (date === '07-15') t.check(`${place.name}: original summer palette`,
            [...GROUND_SEASON.value.toArray(), ...WOOD_SEASON.value.toArray(), ...FIELD_SEASON.value.toArray(), ...HEDGE_SEASON.value.toArray()].every((v) => v === 1));
          if (date === '10-20') t.check(`${place.name}: evergreen hedge stays green`, HEDGE_SEASON.value.toArray().every((v) => v === 1));
        }
      }
    } finally {
      t.paused = paused;
      if (panel) panel.style.display = panelDisplay ?? '';
      await t.camera(null);
    }
  },
} satisfies Scenario;
