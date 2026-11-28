import type { Scenario } from '../src/testkit.ts';

export default {
  title: 'A car at 50 km/h knocks a lamp post over',
  async run(t) {
    // Along the street: the heading a new game leaves you with can face a house front,
    // where there is no room to put the car down.
    await t.go('vodickova', { heading: 315 });
    t.time('14:00');
    t.weather('clear');
    await t.drive('hatch');
    // (One with a clear run up to it and on past it: the nearest may stand between parked
    // cars, or before a wall the car would be stopped by a moment later.)
    const post = t.post(80, 18, 14);
    if (!t.check('a post nearby with a clear run up to it', !!post)) return;
    t.view(0.5);
    t.push(50);
    await t.wait(2);
    const p = t.probe();
    t.check('the post is down', !!post!.down);
    t.check('the car lost speed but kept going', p.speed > 10 && p.speed < 45, `${p.speed} km/h`);
    // Loose: a body thrown on, lying on the ground near where it stood.
    await t.wait(3, { brake: true });
    const body = t.pieces().find((b) => Math.hypot(b.from[0] - post!.x, b.from[1] - post!.y) < 0.01);
    const world = (window.__drive as { world: { surfaceAt(x: number, y: number, l: number): number } }).world;
    const away = body ? Math.hypot(body.x - post!.x, body.y - post!.y) : NaN, up = body ? body.z - world.surfaceAt(body.x, body.y, 0) : NaN;
    t.check('it lies on the ground near where it stood', !!body && away < 15 && up < 0.8 && body.up < 0.5, body ? `${away.toFixed(1)} m on, ${up.toFixed(2)} m up, its top ${body.up.toFixed(2)}` : 'no body');
    await t.shot('lamp-knock');
  },
} satisfies Scenario;
