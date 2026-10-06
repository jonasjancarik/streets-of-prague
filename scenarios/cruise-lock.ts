import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A cruise boat passes a weir through the lock beside it',
  async run(t) {
    t.exit();
    t.time('14:00');
    t.weather('clear');
    await t.go([50.0790, 14.4076]); // Janáčkovo nábřeží, by the Smíchov lock
    await t.wait(2);
    if (!t.check('a cruise boat is put on the fairway above the lock', t.cruiseAt([50.0772, 14.4089]))) return;
    const start = t.cruise()!;
    let narrowest = Infinity, wet = true, turned = false, jump = 0, z: number | null = null, shot = false, alive = true;
    for (let k = 0; k < 150 && t.cruise()!.along - start.along < 420; k++) {
      await t.wait(3);
      const b = t.cruise();
      if (!b || !b.live) { alive = false; break; }
      narrowest = Math.min(narrowest, b.toBank);
      wet &&= b.onWater;
      turned ||= b.turning || b.dir !== start.dir;
      if (z !== null && b.height !== null) jump = Math.max(jump, Math.abs(b.height - z));
      z = b.height;
      if (!shot && b.toBank < 6.5) {
        shot = true;
        t.camera({ at: b.at, height: 40, tilt: 55, heading: 20 });
        await t.wait(0.2);
        await t.shot('cruise-lock');
        t.camera(null);
      }
    }
    const end = t.cruise();
    t.check('it stays afloat', alive && !!end?.live);
    t.check('it sails on past the weir', !!end && end.along - start.along >= 420 && !turned, `${end ? (end.along - start.along).toFixed(0) : 0} m on, ${turned ? 'turned' : 'never turned'}`);
    t.check('through the lock', narrowest < 6.5, `${narrowest.toFixed(1)} m to the wall at the narrowest`);
    t.check('on water all the way', wet);
    t.check('rising or sinking no faster than a lock does', jump <= 0.95, `${jump.toFixed(2)} m in 3 s, from ${start.height?.toFixed(2)} to ${end?.height?.toFixed(2)} m`);
  },
} satisfies Scenario;
