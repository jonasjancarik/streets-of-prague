// Check actual beacon instances in an already-running, exclusively owned scene browser.
// node scripts/check-police-lights.mjs --port 5305
const portAt = process.argv.indexOf('--port');
const port = portAt < 0 ? 5199 : Number(process.argv[portAt + 1]);
const code = `
const d = window.__drive;
const check = (ok, message) => { if (!ok) throw new Error(message); };
await t.go('staromak');
const paused = t.paused;
t.paused = true;
try {
  t.set({stars:0});
  const c = await t.drive('police');
  t.forgive();
  t.push(0);
  const beacons = d.scene.children.find(o => o.isInstancedMesh && o.geometry.parameters?.width === .26 && o.geometry.parameters?.height === .14 && o.geometry.parameters?.depth === .3);
  check(!!beacons, 'actual beacon mesh');
  await t.shot('police-beacons-check');
  check(beacons.count === 2, 'stopped player police car has two roof lamps');
  check(!d.police.chasing.some(p => p.car === c), 'player car does not join the siren/chase list');
  const first = Array.from(beacons.instanceColor.array.slice(0,6));
  let changed = false;
  for (let i=0; i<40 && !changed; i++) {
    await new Promise(requestAnimationFrame);
    changed = first.some((v,j) => v !== beacons.instanceColor.array[j]);
  }
  check(changed, 'stopped lamps change colour as the strobe advances');
  t.exit();
  await t.shot('police-beacons-exit');
  check(beacons.count === 0, 'exit removes player beacon instances');
  await t.enter(c);
  await t.shot('police-beacons-return');
  check(beacons.count === 2, 're-entry restores two roof lamps');
  c.burnt = true;
  try {
    await t.shot('police-beacons-burnt');
    check(beacons.count === 0, 'burnt car has no beacon instances');
  } finally { c.burnt = false; }
  t.exit();
  await t.shot('police-beacons-cleanup');
  check(beacons.count === 0, 'no stale player lamps after final exit');
  return { backend: d.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL', flashing:true, finalInstances:beacons.count };
} finally { t.paused = paused; }
`;
const response = await fetch(`http://127.0.0.1:${port}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'eval', code }),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok || result.error || result.errors?.length) process.exitCode = 1;
