#!/usr/bin/env node
// Run against the scene server (or let scene.mjs open the game once).
// Checks both model distances: underside coverage and inward-facing body panels.
import { spawnSync } from 'node:child_process';

const code = `
const loaded = path => performance.getEntriesByType('resource')
  .filter(e => new URL(e.name).pathname === path).at(-1)?.name || path;
const { Car, CarPool } = await import(loaded('/src/car.ts'));
const THREE = await import(loaded('/node_modules/.vite/deps/three.js'));
const pool = new CarPool(new THREE.Scene());
const report = [];
for (const type of ['hatch', 'sedan', 'estate', 'suv', 'van', 'taxi', 'police', 'pickup']) {
  const car = new Car(type, () => .3, 0, 0, 0);
  for (const close of [false, true]) {
    pool.render([car], null, 0, 1, close, { x: 0, z: 0 });
    const active = [...pool.meshes.values()].flat().filter(m => m.count > 0);
    if (active.length !== 1) throw Error(type + ': expected one active body');
    const body = active[0];
    const materials = Array.isArray(body.material) ? body.material : [body.material];
    if (materials.some(m => m.side !== THREE.DoubleSide)) throw Error(type + ': one-sided body');
    const mesh = new THREE.Mesh(body.geometry, body.material);
    mesh.updateMatrixWorld(true);
    for (const along of [-.4, 0, .4]) for (const across of [-.3, 0, .3]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(car.spec.L * along, -.1, car.spec.W * across),
        new THREE.Vector3(0, 1, 0), 0, .85);
      if (!ray.intersectObject(mesh).length) throw Error(type + ': hole in underside at ' + [along, across]);
    }
    report.push(type + (close ? ' close' : ' distant') + ': solid underside, two-sided panels');
  }
}
return report;
`;
const run = spawnSync(process.execPath, ['scripts/scene.mjs', 'eval', '--stdin', ...process.argv.slice(2)],
  { input: code, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
process.exit(run.status ?? 1);
