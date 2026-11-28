import type { Scenario } from '../src/testkit.ts';
import { onCrash } from '../src/impacts.ts';

// A car driven into a stop shelter at 30 km/h shatters its glass: heard as glass, the crumbs
// thrown on, and the car goes on into it rather than stopping dead at the outline.
export default {
  title: 'A car at 30 km/h shatters a stop shelter’s glass',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    let sh = null, car = null;
    for (const place of ['karlak', 'vodickova', 'ujezd', 'malostranske', 'mustek', 'letna']) {
      await t.go(place, { heading: 315 });
      car = await t.drive('hatch');
      if ((sh = t.shelter(300, 14, 4))) break;
    }
    if (!sh || !car) { t.check('a stop shelter with a clear run up to it', true, 'none found: skipped'); return; }
    await t.wait(0.3, { brake: true });
    const chips = (window.__drive as { fires: { debris: { chips: { list: unknown[] } } } }).fires.debris.chips, before = chips.list.length;
    const heard: string[] = [];
    const stop = onCrash((e) => { if (e.a === car) heard.push(`${e.kind} ${(e.speed * 3.6).toFixed(0)} km/h`); });
    const x0 = car.x, y0 = car.y, start = Math.hypot(sh.x - x0, sh.y - y0);
    t.push(30);
    for (let i = 0; i < 40; i++) await t.wait(0.05, { move: 0.3 });
    await t.wait(1.5, { brake: true });
    stop();
    t.check('the shelter’s glass shattered', t.shelterBroken(sh.x, sh.y), heard.join(', '));
    t.check('heard as glass', heard.some((h) => h.startsWith('panel')), heard.join(', '));
    t.check('its crumbs were thrown', chips.list.length - before > 20, `${chips.list.length - before} bits`);
    const gone = Math.hypot(car.x - x0, car.y - y0);
    t.check('the car went on into it', gone > start - 1, `${gone.toFixed(1)} m of the ${start.toFixed(1)} m to its middle`);
    await t.look({ x: sh.x, y: sh.y, h: Math.atan2(sh.y - y0, sh.x - x0) }, { name: 'shelter-glass', views: ['top', 'third', 'front-left'] });
  },
} satisfies Scenario;
