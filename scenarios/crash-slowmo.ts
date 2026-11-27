import type { Scenario } from '../src/testkit.ts';
import type { CrashCam } from '../src/crashCam.ts';
import type { Car } from '../src/car.ts';
import type { TileWorld } from '../src/tiles.ts';
import type * as THREE from 'three';
import { crashSlowMoOn, setCrashSlowMo } from '../src/crashCam.ts';

// A big crash in slow motion, seen from one of a few angles (src/crashCam.ts), in the live
// game (a scenario's own waits step the world themselves, at full speed): a nudge into a
// wall isn't slowed, a hard hit is, from an angle with nothing between the camera and the
// car, and then the game runs at full speed again; a car thrown off a bridge stays slowed
// until it's down in the river.
export default {
  title: 'A hard crash plays in slow motion from a clear angle; a nudge does not; a fall is slowed until it lands',
  async run(t) {
    const { crashCam, camera, world } = (globalThis as unknown as { __drive: { crashCam: CrashCam; camera: THREE.Camera; world: TileWorld } }).__drive;
    const paused = t.paused, wasOn = crashSlowMoOn();
    const real = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // (Ready for the next one at once, not after the usual pause.)
    const ready = () => { (crashCam as unknown as { pause: number }).pause = 0; };
    try {
      await t.go('karlak', { heading: 324 });
      t.time('14:00'); t.weather('clear'); t.empty();
      const car: Car = await t.drive('sedan');
      const wall = t.wallRun();
      if (!t.check('a broad wall with a clear run up to it', !!wall) || !wall) return;
      setCrashSlowMo(true);
      t.eyes = { yaw: 0, pitch: 0, third: true };
      const start = { x: car.x, y: car.y };
      // `s` seconds of the live game: the slowest the clock got, how long it was slowed (real
      // seconds), the angles the camera took, and whether it ever looked through something.
      const live = async (s: number, shot?: string) => {
        let slowest = 1, slowed = 0, through = 0, far = 0, at = '', shotTaken = false;
        const shots = new Set<string>();
        t.paused = false;
        for (let i = 0; i < s / 0.05; i++) {
          await real(50);
          if (crashCam.scale < 1) { slowed += 0.05; if (!at) at = `${crashCam.moment} at ${(car.speed * 3.6).toFixed(0)} km/h`; }
          slowest = Math.min(slowest, crashCam.scale);
          const name = crashCam.shotName();
          if (!name) continue;
          shots.add(name);
          const p = camera.position, z = car.physics ? car.physics.origin[2] : car.gz ?? 0;
          far = Math.max(far, Math.hypot(p.x - car.x, -p.z - car.y));
          if (world.sightBlocked(car.x, car.y, z + 0.7, p.x, -p.z, p.y, car.overboard?.level ?? Math.max(0, car.level ?? 0))) through++;
          if (shot && !shotTaken && crashCam.scale < 0.5) { shotTaken = true; await t.shot(shot); }
        }
        t.paused = true;
        return { slowest, slowed: +slowed.toFixed(2), shots: [...shots], through, far: +far.toFixed(1), at, active: crashCam.active };
      };
      // Into the wall at `kmh`.
      const hit = async (kmh: number, shot?: string) => {
        t.paused = true;
        Object.assign(car, { x: start.x, y: start.y, vx: 0, vy: 0, w: 0, damage: 0 });
        car.physics = car.roll = undefined;
        await t.wait(0.3, { brake: true });
        t.push(kmh, wall.heading);
        await t.wait(1 / 60); // (the push itself is a sudden change of speed)
        ready();
        return live(7, shot);
      };
      const nudge = await hit(12);
      t.check('a nudge into a wall at 12 km/h is not slowed', nudge.slowest === 1 && !nudge.shots.length, nudge);
      const angles = new Set<string>();
      let blocked = 0;
      for (let i = 0; i < 3; i++) {
        const hard = await hit(65, i ? undefined : 'crash-slowmo');
        if (i === 0) {
          t.check('a hard crash at 65 km/h slows the game right down', hard.slowest <= 0.35, hard);
          t.check('and the camera goes off to an angle of its own', hard.shots.length > 0 && hard.far > 3, hard);
          t.check('seven seconds on, it runs at full speed again', !hard.active, hard);
        }
        hard.shots.forEach((s) => angles.add(s));
        blocked += hard.through;
      }
      t.check('three crashes are seen from more than one angle', angles.size > 1, [...angles].join(', '));
      t.check('and never through a wall, a tree or the ground', blocked === 0, `${blocked} frames blocked`);

      // Thrown over Most Legií's parapet, as in bridge-overboard: slowed until it's down.
      await t.go([50.0813, 14.4125]);
      t.empty();
      const [x, y] = t.toLocal([50.0813, 14.4125]);
      const deck = world.below(x, y, Infinity);
      let lip = y;
      while (lip < y + 40 && Number.isFinite(world.levelAt(x, lip + 0.25, deck.level))) lip += 0.25;
      t.paused = true;
      car.physics = car.overboard = car.roll = undefined;
      Object.assign(car, { x, y: lip - 3, h: Math.PI / 2, vx: 0, vy: 0, w: 0, level: deck.level, gz: deck.h, _tx: undefined, _ty: undefined });
      await t.wait(0.3, { brake: true });
      const body = car.physics as unknown as { p: Float64Array; v: Float64Array } | undefined;
      if (!t.check('the physical body drives on the deck', !!body) || !body) return;
      body.p[2] += 1.1; body.v[1] = 7; body.v[2] = 3.5;
      ready();
      const fall = await live(8, 'crash-slowmo-fall');
      t.check('thrown over the parapet, it is slowed for the whole fall (more than the usual hold)', fall.slowest <= 0.35 && fall.slowed > 2.5, fall);
      t.check('and no longer than five seconds and the easing', fall.slowed < 5.6, fall);
      t.check('nothing between the camera and the falling car', fall.through === 0, fall);
    } finally {
      t.eyes = null; t.paused = paused;
      setCrashSlowMo(wasOn);
    }
  },
} satisfies Scenario;
