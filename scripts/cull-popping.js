// Does the culler (src/occlusion.ts) leave out anything visible while driving? Drives a car in
// first person with lane assist, and after every step compares the frame as the game
// drew it (with what the culler left out) with the same frame with everything drawn.
// Any pixel that differs is something that would have popped. Runs in the game through
// the scene runner (not with --extra "&cull=0"):
//
//   node scripts/scene.mjs eval "const ARGS = { place: 'vodickova' }; $(cat scripts/cull-popping.js)"
//
// ARGS: stereo (as in VR: the culler is given two eyes 6.4 cm apart, either side of the
// camera, and the pictures are from each), walk (on foot instead, running), place (a PLACES name or [lat, lon]), heading (compass degrees; without one, the
// way t.runway finds longest), kmh (50), steps (40), step (seconds of driving between
// comparisons, 0.1: about what a car covers between two frames on the Pixel 5), frames
// (live frames after each step, for the culler to update and its sweep to come back, 2).
const D = __drive, R = D.renderer, scene = D.scene, c = D.culler;
if (!c) return { error: 'no culler: the scene server was started with &cull=0' };
const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /deps\/three\.js\?/.test(n));
const THREE = await import(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

t.time('14:00');
t.weather('clear');
await t.go(ARGS.place ?? 'vodickova', { heading: 0 });
let heading = ARGS.heading;
if (heading === undefined) {
  let best = -1;
  for (let a = 0; a < 360; a += 10) { const r = t.runway(a); if (r > best) { best = r; heading = a; } }
}
await t.go(ARGS.place ?? 'vodickova', { heading });
if (!ARGS.walk) await t.drive('sedan');
t.eyes = { yaw: 0, pitch: 0, onFoot: !!ARGS.walk, third: false };
await sleep(6000);
if (!ARGS.walk) t.push(ARGS.kmh ?? 50);

const w = R.domElement.width, h = R.domElement.height;
const rt = new THREE.RenderTarget(w, h, { depthBuffer: true, stencilBuffer: true, samples: 0 });
const shadows = [];
scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow) shadows.push(o.shadow); });
const nf = R._nodes.nodeFrame, nfUpdate = nf.update, raf = window.requestAnimationFrame;
const picture = async (cam) => {
  const target = R.getRenderTarget();
  R.setRenderTarget(rt);
  R.render(scene, cam);
  R.setRenderTarget(target);
  return new Uint32Array((await R.readRenderTargetPixelsAsync(rt, 0, 0, w, h)).buffer);
};
const diff = (a, b, mask) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !mask[i]) n++; return n; };

// As the headset's eyes: each side of the camera, along its right.
const IPD = 0.064, eyeAt = (side) => D.camera.localToWorld(new THREE.Vector3(side * IPD / 2, 0, 0));
const update = c.update;
if (ARGS.stereo) c.update = function (camera, active) { D.camera.updateMatrixWorld(); return update.call(this, camera, active, [eyeAt(-1), eyeAt(1)]); };
const samples = [];
try {
for (let k = 0; k < (ARGS.steps ?? 40); k++) {
  await t.wait(ARGS.step ?? 0.1, { move: 1, run: true });
  for (let f = 0; f < (ARGS.frames ?? 2); f++) await frame();
  // Held as the game last drew it: no frames, shadows and shader time still.
  const held = [];
  window.requestAnimationFrame = (cb) => { held.push(cb); return 0; };
  shadows.forEach((s) => { s.autoUpdate = false; });
  nf.update = function () { this.deltaTime = 0; this.lastTime = performance.now(); };
  const s = { k, active: c.stats.active, culled: 0, wrong: 0, kmh: Math.round(t.probe().speed ?? 0), by: [] };
  try {
    D.camera.updateMatrixWorld();
    const cams = (ARGS.stereo === 'all' ? [-1, 0, 1] : ARGS.stereo ? [-1, 1] : [0]).map((side) => {
      const cam = D.camera.clone();
      cam.position.copy(D.camera.localToWorld(new THREE.Vector3(side * IPD / 2, 0, 0)));
      cam.updateMatrixWorld();
      return cam;
    });
    const out = c.culled(), masks = out.map((o) => o.layers.mask);
    s.culled = out.length;
    for (const cam of cams) {
      // (The first picture after the hold differs from the rest: thrown away.)
      await picture(cam);
      const drawnAsGame = await picture(cam), same = await picture(cam);
      out.forEach((o) => { o.layers.mask |= 1; });
      const all = await picture(cam), again = await picture(cam);
      out.forEach((o, i) => { o.layers.mask = masks[i]; });
      // (Pixels that differ between two identical pictures, dithered shading, don't count.)
      const mask = new Uint8Array(w * h);
      const flick = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) { const p = i + d * w + e; if (p >= 0 && p < mask.length) mask[p] = 1; } };
      flick(all, again); flick(drawnAsGame, same);
      s.masked = Math.max(s.masked ?? 0, mask.reduce((a, b) => a + b, 0));
      // (The game's frame again: if it differs, something changed meanwhile, such as a
      // shader finishing compiling, and the step isn't scored.)
      if (diff(drawnAsGame, await picture(cam), mask) > 0) { s.unsteady = true; continue; }
      const n = diff(drawnAsGame, all, mask);
      s.wrong += n;
      if (n > 0) {
        // Which of the left-out things show: each put back alone.
        for (let i = 0; i < out.length && s.by.length < 8; i++) {
          const o = out[i];
          o.layers.mask |= 1;
          const m = diff(drawnAsGame, await picture(cam), mask);
          o.layers.mask = masks[i];
          if (m > 0) {
            const b = new THREE.Box3().setFromObject(o), q = b.getCenter(new THREE.Vector3());
            const far = Math.round(q.distanceTo(cam.position));
            const chain = []; for (let p = o; p && chain.length < 4; p = p.parent) chain.push(p.name || p.type);
            const z = b.getSize(new THREE.Vector3());
            s.by.push({ name: o.name || o.parent?.name || o.type, type: o.type, chain: chain.join('<'), tile: c.tileMeshes.has(o), size: [z.x, z.z, z.y].map(Math.round), verts: o.geometry?.attributes?.position?.count, eye: Math.round(cam.position.distanceTo(D.camera.position) * 1000) / 1000, far, pixels: m, centre: [q.x, -q.z, q.y].map(Math.round) });
          }
        }
        s.eye = cam.position.toArray().map(Math.round);
      }
    }
    out.forEach((o, i) => { o.layers.mask = masks[i]; });
  } finally {
    shadows.forEach((x) => { x.autoUpdate = true; x.needsUpdate = true; });
    nf.update = nfUpdate;
    window.requestAnimationFrame = raf;
    held.forEach((cb) => raf(cb));
  }
  samples.push(s);
}
} finally { c.update = update; }
const st = c.stats;
return {
  place: ARGS.place, heading, steps: samples.length,
  wrongSteps: samples.filter((s) => s.wrong > 0).length,
  unsteadySteps: samples.filter((s) => s.unsteady).length,
  activeSteps: samples.filter((s) => s.active).length,
  culledMean: Math.round(samples.reduce((a, s) => a + s.culled, 0) / samples.length),
  maskedMax: Math.max(...samples.map((s) => s.masked ?? 0)), pixels: w * h,
  where: t.where(), why: st.why,
  wrong: samples.filter((s) => s.wrong > 0),
  speeds: samples.map((s) => s.kmh).join(' '),
};
