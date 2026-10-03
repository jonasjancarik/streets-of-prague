import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A courier whose bike is taken leaves the bag on the ground, and you can carry it',
  async run(t) {
    await t.go('letna');
    t.clearBags();
    t.time('14:00');
    t.weather('clear');
    await t.wait(2);
    const c = t.courier();
    if (!t.check('a courier in traffic', !!c)) return;
    const colour = c!.courier!;
    await t.enter(c!);
    t.check('the bike has lost its box', !c!.courier, `box ${c!.courier}`);
    const lying = t.bags().lying;
    t.check('a bag is on the ground close to the bike', lying.length === 1 && lying[0].away < 3, JSON.stringify(lying));
    t.exit();
    await t.wait(1.5);
    const people = t.peopleNear(c!.x, c!.y, 12);
    t.check('the courier ran or is running off', people.some((p) => p.state === 'flee' || p.away > 3), JSON.stringify(people));
    t.toBag();
    t.interact();
    t.check('E picks the bag up', t.bags().carried === colour && t.bags().lying.length === 0, JSON.stringify(t.bags()));
    await t.shot('courier-bag-carried');
    await t.drive('bike');
    t.exit();
    t.check('still carrying it after getting off', t.bags().carried === colour);
    // Away from any vehicle, E puts it down.
    await t.wait(2, { move: 1, run: true });
    t.interact();
    t.check('E puts it down when no vehicle is near', t.bags().carried === null && t.bags().lying.length === 1, JSON.stringify(t.bags()));
  },
} satisfies Scenario;
