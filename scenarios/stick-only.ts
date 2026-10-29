import type { Scenario } from '../src/testkit.ts';

// Stick-only driving (the one-handed touch setting). A player pointed the stick where
// they wanted to go, behind the car, and it went there tail first, stuck at the
// reverse's 39 km/h. Now the car backs round to face the stick and drives off.
export default {
  title: 'Stick only: pointing behind the car turns it round to drive off forward',
  async run(t) {
    const turned = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

    // Standing on Wilsonova facing south-west, the stick held north-east.
    await t.go([50.08064, 14.43209], { heading: 231 });
    t.time('12:57');
    t.weather('clear');
    t.empty();
    const car = await t.drive('hatch');
    await t.thumb(6, 51);
    const nose = t.where().heading, kmh = car.forwardSpeed * 3.6;
    t.check('the car turned round to face the stick', turned(nose, 51) < 25, `nose ${Math.round(nose)}°, stick 51°`);
    t.check('and drives forward past the reverse speed', kmh > 45, `${Math.round(kmh)} km/h`);

    // At 50 km/h, the stick pulled straight back brakes in a straight line first.
    await t.go([50.08064, 14.43209], { heading: 231 });
    t.empty();
    await t.drive('hatch');
    t.push(50, 231);
    await t.thumb(0.6, 51);
    const after = t.where().heading, slow = t.probe().speed;
    t.check('braking hard from speed', slow < 20, `${slow} km/h after 0.6 s`);
    t.check('without swinging round', turned(after, 231) < 10, `nose ${Math.round(after)}°`);
  },
} satisfies Scenario;
