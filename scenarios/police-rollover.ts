import type { Scenario } from '../src/testkit.ts';
import type { Police } from '../src/police.ts';
import type { Car } from '../src/car.ts';

// A police car that rolls over (src/rollover.ts) is out of the chase: it stops, its
// lights go out, and its crew stays belted in rather than climbing out.
export default {
  title: 'A police car rammed side-on by a bus rolls over and drops out of the chase, its crew staying inside',
  async run(t) {
    const g = window.__drive as { police: Police; car: Car | null };
    const P = g.police;
    const spawn = P.spawn;
    try {
      await t.go('staromak', { heading: 90 });
      t.time('14:00');
      t.weather('clear');
      t.empty();
      const bus = await t.drive('bus');
      if (!t.check('open ground for the bus', !!t.clearing(18, 400))) return;
      P.spawn = () => false;
      t.set({ stars: 2 });
      P.reset();
      P.cars.length = 0;
      // Across the bus's way, 9 m ahead (any further and it has pulled away before the bus gets there).
      const fx = Math.cos(bus.h), fy = Math.sin(bus.h);
      const p = P.dispatch(bus.x + fx * 9, bus.y + fy * 9, bus.h + Math.PI / 2);
      const cop = p.car;
      t.push(70);
      let rolled = false;
      for (let i = 0; i < 50; i++) { await t.wait(0.1, { move: 1 }); rolled ||= !!cop.roll; }
      if (!t.check('the bus tips it over', rolled, `bus at ${Math.round(bus.speed * 3.6)} km/h, police car damage ${Math.round(cop.damage)}`)) return;
      await t.wait(3, { brake: true });
      t.check('it ends on its side or roof', cop.overturned && !cop.roll!.moving, cop.roll!.face);
      t.check('it is out of the chase', !P.chasing.some((q) => q.car === cop));
      t.check('its crew is still in it', !!cop.crew && cop.mode === 'police', `crew ${cop.crew}, mode ${cop.mode}`);
      t.check('nobody climbs out of it', !P.officers.some((o) => o.car === cop), `${P.officers.filter((o) => o.car === cop).length} out`);
      t.exit();
      // Where the police car is, as [lat, lon] (from where you stand).
      const w = t.where(), lat = w.lat + (cop.y - w.y) / 111320, at: [number, number] = [lat, w.lon + (cop.x - w.x) / (111320 * Math.cos(lat / 57.3))];
      await t.camera({ at, height: 30, tilt: 0 });
      await t.shot('police-rollover-top');
      // From in front of it, at about eye height: through the windscreen.
      const facing = (90 - cop.h * 57.3 + 720) % 360;
      await t.camera({ at, height: 1.6, tilt: 75, heading: (facing + 180) % 360, level: true });
      await t.shot('police-rollover-front');
      await t.camera({ at, height: 1.6, tilt: 75, heading: (facing + 90) % 360, level: true });
      await t.shot('police-rollover-side');
      await t.camera(null);
    } finally {
      P.spawn = spawn;
    }
  },
} satisfies Scenario;
