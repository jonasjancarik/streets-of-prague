import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'E takes you into a car through its door and out again, and hauls a driver out',
  async run(t) {
    await t.go('staromak', { heading: 270 });
    t.time('14:00');
    t.weather('clear');
    t.set({ stars: 0 });
    const c = t.car('hatch', { ahead: 9 });
    t.toDoor(c, 1, 2);
    t.press();
    await t.wait(0.3);
    t.check('not in the seat at once', t.where().mode === 'foot', t.where().mode);
    await t.wait(1.7);
    t.check('in the car after going to its door', t.probe().car?.type === 'hatch', t.where().mode);
    t.press();
    await t.wait(0.1);
    t.check('still in the car while the door opens', t.where().mode === 'car', t.where().mode);
    await t.wait(1);
    t.check('out on foot', t.where().mode === 'foot', t.where().mode);
    t.check('standing beside the driver\'s door', t.fromDoor(c, 1) < 0.3, `${t.fromDoor(c, 1)} m from it`);
    t.check('the car is left standing', t.standing(c));
    // From the other side: in through the passenger's door.
    t.toDoor(c, 2, 1.5);
    t.press();
    await t.wait(1.5);
    t.check('in again from the other side', t.probe().car?.type === 'hatch', t.where().mode);
    t.exit();

    // A car with someone at the wheel: they end up on the ground beside it.
    await t.go('vodickova', { heading: 0 });
    await t.wait(2);
    const v = t.trafficCar();
    if (!t.check('a car in traffic nearby', !!v)) return;
    t.toDoor(v!, 1, 1);
    t.press();
    await t.wait(0.4);
    t.check('its driver is still at the wheel as you reach the door', t.where().mode === 'foot' && t.peopleNear(v!.x, v!.y, 4).every((p) => p.state !== 'down'));
    await t.wait(2.6);
    t.check('the car is yours', t.probe().car?.type === v!.type, t.where().mode);
    t.check('nobody is driving it for you', !t.driven(v!));
    const down = t.peopleNear(v!.x, v!.y, 6).filter((p) => p.state === 'down');
    t.check('the driver is on the ground beside it', down.length > 0, `${down.length} down`);
    t.exit();
  },
} satisfies Scenario;
