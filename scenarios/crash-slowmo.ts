import type { Scenario } from '../src/testkit.ts';
import type { CrashCam } from '../src/crashCam.ts';
import type { Car } from '../src/car.ts';
import * as THREE from 'three';
import { crashSlowMoOn, setCrashSlowMo } from '../src/crashCam.ts';

// A big crash in slow motion, seen from the side (src/crashCam.ts), in the live game (a
// scenario's own waits step the world themselves, at full speed): a nudge into a wall
// isn't slowed, a hard hit is, and then the game runs at full speed again.
export default {
  title: 'A hard crash plays in slow motion from the side; a nudge does not',
  async run(t) {
    const { crashCam, camera } = (globalThis as unknown as { __drive: { crashCam: CrashCam; camera: THREE.Camera } }).__drive;
    const paused = t.paused, wasOn = crashSlowMoOn();
    const real = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      await t.go('karlak', { heading: 324 });
      t.time('14:00'); t.weather('clear'); t.empty();
      const car: Car = await t.drive('sedan');
      const wall = t.wallRun();
      if (!t.check('a broad wall with a clear run up to it', !!wall) || !wall) return;
      setCrashSlowMo(true);
      t.eyes = { yaw: 0, pitch: 0, third: true };
      const start = { x: car.x, y: car.y };
      // Into the wall at `kmh` in the live game; the slowest the clock got, whether the
      // camera went off to the side, and how far it was from the car then.
      const run = async (kmh: number, shot?: string) => {
        t.paused = true;
        Object.assign(car, { x: start.x, y: start.y, vx: 0, vy: 0, w: 0, damage: 0 });
        car.physics = undefined;
        await t.wait(0.3, { brake: true });
        t.push(kmh, wall.heading);
        await t.wait(1 / 60); // (the push itself is a sudden change of speed)
        let slowest = 1, cut = false, side = 0, shotTaken = false, at = '';
        t.paused = false;
        for (let i = 0; i < 70; i++) {
          await real(50);
          if (crashCam.scale < 1 && !at) at = `${crashCam.moment} at ${(car.speed * 3.6).toFixed(0)} km/h`;
          slowest = Math.min(slowest, crashCam.scale);
          if (crashCam.cut) {
            cut = true;
            // How far off the line of the car's travel the camera stands.
            const p = new THREE.Vector3().copy(camera.position);
            side = Math.max(side, Math.abs((p.x - car.x) * -wall.dy + (-p.z - car.y) * wall.dx));
            if (shot && !shotTaken && crashCam.scale < 0.5 && car.speed < kmh / 3.6 / 2) { shotTaken = true; await t.shot(shot); }
          }
        }
        t.paused = true;
        return { slowest, cut, side: +side.toFixed(1), at, active: crashCam.active, scale: crashCam.scale };
      };
      const nudge = await run(12);
      t.check('a nudge into a wall at 12 km/h is not slowed', nudge.slowest === 1 && !nudge.cut, nudge);
      const hard = await run(65, 'crash-slowmo');
      t.check('a hard crash at 65 km/h slows the game right down', hard.slowest <= 0.35, hard);
      t.check('and the camera goes off to the side of the car', hard.cut && hard.side > 3, `${hard.side.toFixed(1)} m to the side`);
      t.check('three and a half seconds on, it runs at full speed again', !hard.active && hard.scale === 1, hard);
    } finally {
      t.eyes = null; t.paused = paused;
      setCrashSlowMo(wasOn);
    }
  },
} satisfies Scenario;
