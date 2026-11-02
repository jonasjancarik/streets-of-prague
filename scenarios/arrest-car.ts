import type { Scenario } from '../src/testkit.ts';

// A player wrote that getting into a car while being arrested had them come out of the
// cell sitting in it (1 Nov, at Bartolomějská): E wasn't held back during the arrest, and
// the move to the station took the car along.
export default {
  title: 'Busted on foot beside a car: E does nothing, and you come back on foot at the station',
  async run(t) {
    const station = [50.08256, 14.41636] as [number, number];
    const off = (car: { x: number; y: number }, [lat, lon]: [number, number]) => {
      const [x, y] = t.toLocal([lat, lon]);
      return Math.round(Math.hypot(car.x - x, car.y - y));
    };
    const free = async () => {
      for (let i = 0; i < 40 && t.arrested(); i++) await t.wait(1);
      await t.settled();
      await t.wait(0.5);
    };

    // E at the door while the hands go up.
    await t.go([50.08311, 14.41774], { heading: 15 });
    t.time('14:13');
    t.weather('cloudy');
    t.season('11-01');
    const car = t.car('hatch', { ahead: 4 });
    t.toDoor(car, 1);
    t.bust();
    if (!t.check('the arrest begins', !!t.arrested(), `${t.arrested()}`)) return;
    await t.wait(0.2);
    t.press();
    await t.wait(2);
    t.check('E does nothing while you are being arrested', t.where().mode === 'foot' && !!t.arrested(), `${t.where().mode}, ${t.arrested()}`);
    await free();
    let w = t.where();
    t.check('on foot after the bust', w.mode === 'foot', w.mode);
    t.check('at the station', off(t.where(), station) < 40, `${off(t.where(), station)} m from it`);

    // In a car by some other way during the arrest: still out of it at the station.
    await t.go([50.08311, 14.41774], { heading: 15 });
    const fire = t.car('fire', { ahead: 5 });
    t.bust();
    await t.wait(0.3);
    await t.enter(fire);
    await free();
    w = t.where();
    t.check('on foot after the bust, even having got in', w.mode === 'foot', w.mode);
    t.check('the fire engine stays where it was', off(fire, station) > 60, `${off(fire, station)} m from the station`);
  },
} satisfies Scenario;
