#!/usr/bin/env node
// CPU checks for the tow scenario's premises, without simulating cleanup policy.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
globalThis.location = { search: '?go&lang=en' };
const server = await createServer({ configFile: false, cacheDir: '/tmp/streets-tow-fixture-vite', server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { default: scenario } = await server.ssrLoadModule('/scenarios/wreck-tow.ts');
  const { setupTestkit } = await server.ssrLoadModule('/src/testkit.ts');
  const camera = { x: 10, y: 20, height: 100 }, player = { x: 0, y: 0 };
  const kit = setupTestkit({ canvas: { addEventListener() {} }, me: () => player, view0: () => camera,
    viewRadius: () => 80, offscreen: (x, y) => Math.hypot(x - camera.x, y - camera.y) > 80 });
  assert.deepEqual(kit.carView({ x: 10, y: 20 }), { playerDistance: Math.hypot(10, 20), cameraDistance: 0, radius: 80, outOfSight: false });
  assert.equal(kit.carView({ x: 10, y: 101 }).outOfSight, true, 'uses current camera rather than player or requested spawn distance');

  const run = async (farDistance, nearKept = true, radius = 80) => {
    const checks = [], spawns = [];
    let elapsed = 0;
    const t = {
      async go(_where, opt) { assert.equal(opt.heading, 0, 'fixed heading avoids inherited scenario direction'); },
      time() {}, weather() {}, set() {},
      car(_type, opt) { const c = { x: spawns.length ? -farDistance : 57.7, y: 0, speed: 0, damage: 0 }; spawns.push({ c, opt }); return c; },
      standing(c) { return !elapsed || (c === spawns[0].c && nearKept); },
      carView(c) { const distance = Math.abs(c.x); return { playerDistance: distance, cameraDistance: distance, radius, outOfSight: distance > radius }; },
      check(name, pass, detail) { checks.push({ name, pass, detail }); return pass; },
      async wait(seconds) { elapsed += seconds; },
    };
    await scenario.run(t);
    return { checks, elapsed, spawns };
  };
  const valid = await run(160);
  assert.ok(valid.checks.every(c => c.pass)); assert.equal(valid.elapsed, 90);
  const repeated = await run(160);
  assert.deepEqual(valid, repeated, 'same actual fixture positions yield deterministic setup');
  const shortened = await run(73.5425);
  assert.equal(shortened.spawns[1].opt.ahead, -160);
  assert.equal(shortened.elapsed, 0, 'inside-view fallback is rejected before the cleanup wait');
  assert.equal(shortened.checks.at(-1).name, 'the far wreck starts beyond the cleanup view');
  assert.equal(shortened.checks.at(-1).pass, false);
  assert.equal((await run(601)).elapsed, 0, 'cannot pass via the unrelated 600 m immediate cull');
  assert.equal((await run(160, true, 50)).elapsed, 0, 'near wreck must actually be in view');
  const removedNear = await run(160, false);
  assert.equal(removedNear.checks.at(-1).name, 'the one beside you stays');
  assert.equal(removedNear.checks.at(-1).pass, false, 'near-retention assertion remains effective');
  console.log('Tow fixture: actual camera view, fixed heading, deterministic setup, shortened far spawn, near view, 600 m guard and retained near assertion passed.');
} finally { await server.close(); }
