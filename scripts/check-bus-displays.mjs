// Rendering/resource regression in an already-running scene browser. This does not
// launch a browser: acquire the shared game test slot and start scripts/scene.mjs first.
// node scripts/check-bus-displays.mjs --port 5305
const portAt = process.argv.indexOf('--port');
const port = portAt < 0 ? 5199 : Number(process.argv[portAt + 1]);
const code = `
const d = window.__drive;
const loaded = performance.getEntriesByType('resource').filter(e => new URL(e.name).pathname === '/src/car.ts').at(-1)?.name || '/src/car.ts';
const { Car } = await import(loaded);
const pool = new d.carPool.constructor(new d.scene.constructor());
const check = (ok, message) => { if (!ok) throw new Error(message); };
const line = t.busLines().find(l => l.ref === '148') || t.busLines()[0];
check(!!line, 'loaded PID route required');
let renders = 0;
for (const type of ['bus', 'minibus']) {
  const c = new Car(type, () => .5);
  t.busLine(c, line.ref);
  pool.render([c]);
  const meshes = pool.boards.slice(0, 3), materials = meshes.map(b => b.material), textures = materials.map(m => m.map);
  check(meshes.length === 3 && meshes.every(b => b.visible), type + ': front, side and roof boards');
  check(materials[0] !== materials[1] || !line.to, type + ': front number is separate from side destination');
  const front = meshes[0].matrix.elements;
  check(Math.hypot(front[4], front[5], front[6]) >= .28, type + ': readable front board height');
  const create = document.createElement;
  let canvases = 0;
  document.createElement = function(name, ...args) { if (name === 'canvas') canvases++; return create.call(this, name, ...args); };
  try { for (let i = 0; i < 100; i++) { c.x = i; pool.render([c]); renders++; } }
  finally { document.createElement = create; }
  check(canvases === 0 && meshes.every((b, i) => b === pool.boards[i] && b.material === materials[i] && b.material.map === textures[i]), type + ': no per-frame canvases or replacement boards/textures');
  pool.render([]);
  check(pool.boards.every(b => !b.visible), type + ': despawn hides every board');
  pool.render([c]);
  check(meshes.every((b, i) => b === pool.boards[i] && b.visible && b.material === materials[i]), type + ': return reuses boards');
  c.line = undefined;
  pool.render([c]);
  check(pool.boards.every(b => !b.visible), type + ': missing route has no label');
  c.line = { ref: '  ', to: line.to };
  pool.render([c]);
  check(pool.boards.every(b => !b.visible), type + ': empty route has no label');
  t.busLine(c, line.ref);
  c.burn();
  pool.render([c]);
  check(pool.boards.every(b => !b.visible), type + ': burnt wreck has no label');
}
pool.render([]);
for (const pages of pool.meshes.values()) for (const mesh of pages) mesh.geometry.dispose();
return { backend: d.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL', renders, cachedBoards: pool.boards.length, line };
`;
const response = await fetch(`http://127.0.0.1:${port}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'eval', code }),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok || result.error || result.errors?.length) process.exitCode = 1;
