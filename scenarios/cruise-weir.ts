import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A cruise boat on the fairway stops short of a weir without a lock and turns round',
  async run(t) {
    t.exit();
    t.time('14:00');
    t.weather('clear');
    await t.go([50.0085, 14.4008]); // Modřany, by the weir: the map has no lock a boat fits through there
    await t.wait(2);
    if (!t.check('a cruise boat is put on the fairway before the weir', t.cruiseToEnd(200))) return;
    const start = t.cruise()!;
    let turned = false, wet = true, nearest = Infinity, jump = 0, z = start.height;
    for (let k = 0; k < 120 && !(turned && !t.cruise()!.turning && t.cruise()!.speed > 1); k++) {
      await t.wait(3);
      const b = t.cruise();
      if (!b || !b.live) break;
      if (b.dir !== start.dir) turned = true; else nearest = Math.min(nearest, b.toEnd);
      wet &&= b.onWater;
      if (z !== null && b.height !== null) jump = Math.max(jump, Math.abs(b.height - z));
      z = b.height;
      if (b.turning && !turned) await t.shot('cruise-weir');
    }
    const end = t.cruise();
    t.check('it is still afloat', !!end?.live);
    t.check('it turned round', turned, `nearest ${nearest.toFixed(0)} m from the end of the stretch`);
    t.check('and sails back the other way', !!end && end.dir !== start.dir && end.speed > 1, `speed ${end?.speed.toFixed(1)}`);
    t.check('on open water all the way', wet);
    t.check('without jumping in height', jump <= 1, `${jump.toFixed(2)} m in 3 s`);
    await t.shot('cruise-weir-after');
  },
} satisfies Scenario;
