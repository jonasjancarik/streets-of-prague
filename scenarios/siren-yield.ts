import type { Scenario } from '../src/testkit.ts';
import type { Traffic, TrafficAgent } from '../src/traffic.ts';
import type { Car } from '../src/car.ts';

// With your siren on, the car in front moves over and stops by the side for you; with the
// siren off it keeps to its lane.
export default {
  title: 'Siren on: the car ahead pulls over and stops; siren off: it keeps to its lane',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    const g = window.__drive as { traffic: Traffic; car: Car | null };
    const unhurt = t.unhurt;
    t.unhurt = true;
    try {
      for (const siren of [true, false]) {
        await t.go('karlak', { heading: 90 });
        await t.drive('ambulance');
        const me = g.car!;
        // X: lights, then lights and siren, then off.
        let b = t.beacon();
        while (b !== (siren ? 'siren' : 'off')) b = t.beacon();
        // A car moving along a two-way street with 60 m of it ahead.
        let pick: TrafficAgent | undefined;
        for (let tries = 0; tries < 40 && !pick; tries++) {
          pick = g.traffic.agents.find((a) => a.speed > 4 && a.route.leg.edge && !a.route.leg.edge.oneway && !a.bus
            && a.route.leg.s1 - a.route.s > 60 && a.route.s - a.route.leg.s0 > 18);
          if (!pick) await t.wait(0.5);
        }
        if (!t.check(`siren ${siren}: a car to follow`, !!pick)) continue;
        const a = pick!, c = a.car;
        // You keep 16 m behind it in its lane, as if following it.
        const s0 = a.route.s;
        let minSpeed = Infinity, maxOff = 0;
        for (let i = 0; i < 14; i++) {
          const p = a.route.leg.path.at(Math.max(s0 - 16, a.route.s - 16));
          me.x = p.x; me.y = p.y; me.h = p.ang;
          t.push(25);
          await t.wait(0.5);
          if (i >= 6) minSpeed = Math.min(minSpeed, a.speed);
          maxOff = Math.max(maxOff, a.off);
        }
        const gone = Math.hypot(c.x - me.x, c.y - me.y);
        const e = a.route.leg.edge;
        const ahead = Math.min(...g.traffic.agents.filter((o) => o !== a).map((o) => {
          const dx = o.car.x - c.x, dy = o.car.y - c.y, f = dx * Math.cos(c.h) + dy * Math.sin(c.h);
          return f > 0 && Math.abs(dx * Math.sin(c.h) - dy * Math.cos(c.h)) < 2 ? f : Infinity;
        }));
        const where = `street ${e?.width} m wide, lane ${e?.laneOffset} m right of its middle, next car ahead ${ahead.toFixed(0)} m`;
        if (siren) {
          // (As far as the parked cars beside it let it; on a narrow street there's no
          // room, and it stops where it is, with room for you on its left.)
          const room = e ? e.width / 2 - e.laneOffset - c.spec.W / 2 : 1;
          t.check('siren on: it moves over to the right where there is room', room < 0.3 || maxOff > 0.15, `off ${maxOff.toFixed(2)} m; ${where}`);
          t.check('siren on: it stops for you', minSpeed < 0.3, `${(minSpeed * 3.6).toFixed(1)} km/h, ${gone.toFixed(0)} m away`);
          await t.shot('siren-yield');
        } else {
          t.check('siren off: it keeps to its lane', maxOff < 0.3, `${(minSpeed * 3.6).toFixed(1)} km/h, off ${maxOff.toFixed(2)} m, ${gone.toFixed(0)} m away`);
        }
      }
    } finally {
      t.unhurt = unhurt;
    }
  },
} satisfies Scenario;
