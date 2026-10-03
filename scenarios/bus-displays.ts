import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'Buses keep their loaded PID line when taken and entered again',
  async run(t) {
    await t.go('staromak', { heading: 90 });
    t.time('14:00');
    t.weather('clear');
    const lines = t.busLines();
    if (!t.check('PID bus lines loaded', lines.length > 0)) return;
    for (const type of ['bus', 'minibus']) {
      const line = lines.find((l) => l.ref === (type === 'bus' ? '148' : '194')) ?? lines[0];
      const c = await t.drive(type);
      t.busLine(c, line.ref);
      t.check(`${type}: actual number and destination`, c.line?.ref === line.ref && c.line.to === line.to);
      const { lat, lon } = t.where();
      await t.camera({ at: [lat, lon], height: 22, tilt: 40, heading: 270 });
      await t.shot(`${type}-route-overhead`);
      await t.camera({ at: [lat, lon], height: 7, tilt: 60, heading: 270 });
      await t.shot(`${type}-route-front`);
      t.exit();
      await t.enter(c);
      t.check(`${type}: number survives re-entry`, c.line?.ref === line.ref && c.line.to === line.to);
      t.exit();
    }
    await t.camera(null);
  },
} satisfies Scenario;
