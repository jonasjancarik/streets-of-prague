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
  const beacons = d.scene.getObjectByName('Beacon LEDs'), halos = d.scene.getObjectByName('Beacon halos');
  check(beacons && halos, 'LED and halo batches are present');
  const checkPulses = async () => {
    // Inspect consecutive render frames. A double flash has a dark interval,
    // and both halves of the police bar have the same blue-white LED colour.
    const sides = new Set();
    let dark = false;
    for (let i=0; i<90 && (sides.size<2 || !dark); i++) {
      t.frameDt = 1/60;
      await t.frames(1);
      check(halos.count === beacons.count, 'each active LED has one halo');
      if (!beacons.count) { dark = true; continue; }
      check(beacons.count === 2 && beacons.instanceColor.array[2] > 1, 'two bright blue LED modules');
      const m = beacons.instanceMatrix.array;
      sides.add(Math.sign(-(m[12]-c.x)*Math.sin(c.h) - (m[14]+c.y)*Math.cos(c.h)));
    }
    check(sides.size === 2 && dark, 'both halves flash with a dark interval');
  };
  await checkPulses();
  check(!d.police.chasing.some(p => p.car === c), 'player car does not join the siren/chase list');
  t.exit();
  await t.shot('police-beacons-exit');
  check(beacons.count === 0 && halos.count === 0, 'exit removes player beacon instances');
  await t.enter(c);
  await t.shot('police-beacons-return');
  await checkPulses();
  c.burnt = true;
  try {
    await t.shot('police-beacons-burnt');
    check(beacons.count === 0 && halos.count === 0, 'burnt car has no beacon instances');
  } finally { c.burnt = false; }
  t.exit();
  await t.shot('police-beacons-cleanup');
  check(beacons.count === 0 && halos.count === 0, 'no stale player lamps after final exit');
  return { backend: d.renderer.backend?.isWebGPUBackend ? 'WebGPU' : 'WebGL', flashing:true, finalInstances:beacons.count };
} finally { t.frameDt = undefined; t.paused = paused; }
`;
const response = await fetch(`http://127.0.0.1:${port}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cmd: 'eval', code }),
});
const result = await response.json();
console.log(JSON.stringify(result, null, 2));
if (!response.ok || result.error || result.errors?.length) process.exitCode = 1;
