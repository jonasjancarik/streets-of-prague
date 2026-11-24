// Capture a named, already-built civilian through the game's scene runner.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AVATARS } from '../../../src/rocketboxClips.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { motion: { type: 'boolean' }, url: { type: 'string' } },
});
const [name, directory] = positionals;
const seed = AVATARS.findIndex(([candidate]) => candidate === name);
if (positionals.length !== 2 || seed < 0) {
  console.error('Usage: node capture.mjs AVATAR OUTPUT_DIRECTORY [--motion] [--url GAME_URL]');
  console.error('Avatars:', AVATARS.map(([avatar]) => avatar).join(', '));
  process.exit(1);
}

// This function runs inside the fresh scene browser; its only inputs are passed below.
async function capture(t, seed, motion) {
  const { camera, lifeSize, walker } = window.__drive;
  const square = [50.08747, 14.42108];
  await t.onFoot();
  walker.fig.avatarSeed = seed;
  await t.go(square, { heading: 90 });
  t.season('09-15');
  t.time('15:20');
  t.weather('clear');
  t.paused = true;
  t.eyes = { third: true, yaw: 0, pitch: -3 };

  async function subject(mounted = false) {
    const deadline = performance.now() + 60000;
    do {
      const actors = lifeSize.avatars;
      const actor = actors && [...actors.live.values()].find(candidate => candidate.self);
      if (actor?.root.visible && actor.kind === actors.baseKinds[seed] && actor.mounted === mounted) return actor;
      await t.frames(2);
    } while (performance.now() < deadline);
    throw Error('The requested detailed player did not appear ' + (mounted ? 'on the vehicle' : 'on foot'));
  }

  // Measure the character in screen space so different heights get comparable framing.
  async function shot(actor, name, yaw, centre, scale) {
    t.eyes.yaw = yaw;
    t.eyes.still = 0;
    camera.clearViewOffset();
    await t.frames(2);
    const project = bone => actor.root.getObjectByName('Bip01_' + bone)
      .getWorldPosition(camera.position.clone()).project(camera);
    const head = project('Head');
    const lowestToe = Math.min(project('L_Toe0').y, project('R_Toe0').y);
    const span = (head.y - lowestToe) * innerHeight / 2;
    if (!(span > 1)) throw Error('Could not frame the ' + name + ' view');
    const height = Math.min(innerHeight, span * scale), width = height * innerWidth / innerHeight;
    const x = (head.x + 1) * innerWidth / 2, y = (1 - head.y) * innerHeight / 2 + centre * span;
    camera.setViewOffset(innerWidth, innerHeight, x - width / 2, y - height / 2, width, height);
    await t.frames(2);
    await t.shot(name);
    camera.clearViewOffset();
  }
  async function step(controls) {
    t.frameDt = 1/30;
    await t.wait(1/30, controls);
  }

  const style = document.createElement('style');
  style.textContent = 'body > :not(#app) { visibility: hidden !important }';
  document.head.append(style);
  try {
    const actor = await subject();
    // One neutral pose for the comparison, even if this donor first spawned on the phone.
    actor.rest = 'idle_neutral_01';
    actor.t[actor.rest] = 0;
    for (const clip in actor.w) actor.w[clip] = Number(clip === actor.rest);
    t.frameDt = 0;
    await shot(actor, 'outfit', 168, .43, 1.36);
    await shot(actor, 'face', 173, -.045, .39);
    await shot(actor, 'left-quarter', 123, .14, .48);
    await shot(actor, 'right-quarter', 220, .14, .48);
    await shot(actor, 'nape', 0, .045, .46);
    if (!motion) return;

    for (const run of [false, true]) {
      t.eyes.yaw = 0;
      let ready = false;
      for (let i = 0; i < 80 && !ready; i++) {
        await step({ move: run ? 1 : .4, run });
        const left = actor.root.getObjectByName('Bip01_L_Foot').getWorldPosition(camera.position.clone());
        const right = actor.root.getObjectByName('Bip01_R_Foot').getWorldPosition(camera.position.clone());
        const stride = Math.hypot(left.x - right.x, left.z - right.z);
        ready = (run ? actor.w.run : actor.w.walk) > .5 && stride > (run ? .48 : .30);
      }
      if (!ready) throw Error('The player did not reach the requested gait');
      await shot(actor, run ? 'running' : 'walking', 110, .47, 1.43);
    }
    for (const kind of ['bike', 'moto']) {
      const vehicle = await t.drive(kind);
      const [x, y] = t.toLocal(square);
      Object.assign(vehicle, { x, y, h: 0, vx: 0, vy: 0, w: 0, level: 0 });
      const rider = await subject(true);
      for (let i = 0; i < 30; i++) await step({ move: .45 });
      if (!(vehicle.speed > .5)) throw Error(kind + ' did not move');
      await shot(rider, kind, 77, .65, 2.35);
      vehicle.vx = vehicle.vy = vehicle.w = 0;
      t.exit();
      await subject();
    }
  } finally {
    style.remove();
    camera.clearViewOffset();
  }
}

const scene = fileURLToPath(new URL('../../../scripts/scene.mjs', import.meta.url));
const args = [scene, 'eval', '--stdin', '--fresh', '--graphics', 'high', '--size', '1000x800', '--out', resolve(directory)];
if (values.url) args.push('--url', values.url);
const result = spawnSync(process.execPath, args, {
  input: `await (${capture.toString()})(t, ${seed}, ${Boolean(values.motion)});`,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
