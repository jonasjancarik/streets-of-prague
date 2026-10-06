import type { Scenario } from '../src/testkit.ts';

// Bits of a car's `broken`: 1 and 2 the headlamps, 4 and 8 the tail lamps (LAMP in src/car.ts).
const HEADS = 3;

export default {
  title: 'A crash smashes the headlamps, but not behind a police ram; braking lights the tail lamps',
  async run(t) {
    await t.go('karlak', { heading: 324 });
    t.time('21:30');
    t.weather('clear');
    const wall = () => t.wallAhead();
    await t.drive('sedan');
    let heading = wall();
    if (!t.check('a wall within reach', heading >= 0)) return;
    // (Paused, or the live loop lets go of the pedal before the check.)
    t.paused = true;
    t.push(50, heading);
    await t.wait(0.3, { move: -1 });
    t.check('the brake lights are on while braking', t.probe().car?.braking === true);
    await t.shot('lamp-brake');
    t.paused = false;
    t.push(60, heading);
    await t.wait(3, { move: 1 });
    let car = t.probe().car;
    t.check('both headlamps are smashed', ((car?.broken ?? 0) & HEADS) === HEADS, `broken ${car?.broken}`);
    t.check('the brake lights are off again', car?.braking === false);
    await t.shot('lamp-break');

    await t.go('karlak', { heading: 324 });
    const police = t.car('police');
    police.armour();
    await t.enter(police);
    heading = wall();
    if (!t.check('a wall within reach of the police car', heading >= 0)) return;
    t.push(60, heading);
    await t.wait(3, { move: 1 });
    car = t.probe().car;
    t.check('the police car hit the wall', (car?.damage ?? 0) > 0, `damage ${car?.damage}`);
    t.check('the ram kept its headlamps whole', ((car?.broken ?? 0) & HEADS) === 0, `broken ${car?.broken}`);
    await t.shot('lamp-ram');
  },
} satisfies Scenario;
