// Which of the main pass's draws could be left out without changing a single pixel:
// what the buildings (and everything else in front) hide from the camera. For judging
// occlusion culling. Runs in the game through the scene runner:
//
//   node scripts/scene.mjs eval "const ARGS = { place: 'staromak', heading: 0 }; $(cat scripts/hidden-draws.js)"
//
// ARGS: place (a PLACES name or [lat, lon]) and heading (compass degrees; without one,
// the way t.runway finds longest), drive (in a car), overhead (the ordinary camera
// instead of the eyes), yaw/pitch, fov, settle (seconds for the tiles to appear, 8),
// shot (a screenshot's name), scale (of the picture), top (how many kinds to list),
// keep (leave the hidden objects in window.__hiddenDraws; scripts/cull-ab.js uses them),
// tiles (only the tiles' own meshes may go, each tile's ground layers together, as a
// culler working with the tiles could: not the shared pages of trees, people and cars,
// and no ground layer hidden only by another ground layer).
// Without place it measures the camera as it is.
//
// The live game is held (paused, no frames drawn, shadow maps and shader time frozen,
// birds hidden), so two pictures of the same view come out identical; pixels that still
// flicker (dithered shading) are left out of the comparison. Then the draws are taken
// away one at a time, biggest first, each staying away if the picture is unchanged, so
// the hidden set as a whole can go without a pixel changing (`check` is the pixels that
// changed with all of it gone: 0). Overlapping copies of a surface count once. The
// sun's shadow pass isn't measured: a caster hidden from the camera can still cast.
// An instanced mesh counts as hidden only if all its instances are.
const D = __drive, R = D.renderer, scene = D.scene, back = R.backend;
const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /deps\/three\.js\?/.test(n));
const THREE = await import(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (ARGS.place) {
  await t.go(ARGS.place, { heading: 0 });
  // Look the way with the longest clear view (along the street), unless told.
  let heading = ARGS.heading;
  if (heading === undefined) {
    let best = -1;
    for (let a = 0; a < 360; a += 10) { const r = t.runway(a); if (r > best) { best = r; heading = a; } }
  }
  await t.go(ARGS.place, { heading });
  if (ARGS.drive) await t.drive('sedan');
  t.eyes = ARGS.overhead ? null : { yaw: ARGS.yaw ?? 0, pitch: ARGS.pitch ?? 0, onFoot: !ARGS.drive, third: !!ARGS.third };
  if (ARGS.overhead) t.view(1);
  await sleep((ARGS.settle ?? 8) * 1000);
}
if (ARGS.shot) await t.shot(ARGS.shot);

const label = new Map();
for (const tile of D.world.loaded.values()) {
  const d = tile.drawn;
  if (!d) continue;
  d.surfaces?.group?.traverse((o) => label.set(o, 'ground'));
  for (const m of d.own ?? []) m.traverse((o) => label.set(o, 'buildings'));
  for (const f of tile.fixtures ?? []) f.traverse((o) => label.set(o, 'fixtures'));
  for (const f of tile.furniture ?? []) f.traverse((o) => label.set(o, 'furniture'));
  d.group.traverse((o) => { if (!label.has(o)) label.set(o, 'tile: landmark/other'); });
}
const skip = new Set(['scene', 'camera', 'renderer', 'world', 'graphics', 'dev', 'touch', 'dialog']);
for (const key of Object.keys(D)) {
  if (skip.has(key)) continue;
  let v; try { v = D[key]; } catch { continue; }
  if (!v || typeof v !== 'object') continue;
  const mark = (o, name) => { if (o?.isObject3D) o.traverse((c) => { if (!label.has(c)) label.set(c, name); }); };
  if (v === scene) continue;
  mark(v, key);
  for (const [prop, x] of Object.entries(v)) {
    if (x === scene) continue;
    if (x?.isObject3D) mark(x, `${key}.${prop}`);
    else if (Array.isArray(x)) x.slice(0, 50).forEach((y) => { mark(y, `${key}.${prop}`); mark(y?.mesh, `${key}.${prop}`); });
    else if (x instanceof Map) [...x.values()].slice(0, 50).forEach((y) => { mark(y, `${key}.${prop}`); mark(y?.mesh, `${key}.${prop}`); });
  }
}
const kind = (o) => {
  if (label.has(o)) return label.get(o);
  for (let p = o; p; p = p.parent) if (p.name) return p.name;
  let top = o;
  while (top.parent && top.parent !== scene) top = top.parent;
  return `${o.type} ${o.material?.type ?? ''}${o.isInstancedMesh ? ' inst' : ''} top#${scene.children.indexOf(top)}`;
};

// A copy of the camera, so the live game can't move it between pictures.
D.camera.updateMatrixWorld();
const cam = D.camera.clone();
if (ARGS.fov) { cam.fov = ARGS.fov; cam.updateProjectionMatrix(); }
cam.updateMatrixWorld();
const scale = ARGS.scale ?? 1;
const w = Math.round(R.domElement.width * scale), h = Math.round(R.domElement.height * scale);
const rt = new THREE.RenderTarget(w, h, { depthBuffer: true, stencilBuffer: true, samples: 0 });
const draw = back.draw;
const drawn = new Map();
let capture = false;
back.draw = function (ro, info) {
  if (capture && ro.camera === cam) {
    const p = ro.getDrawParameters?.();
    const g = ro.geometry, n = g.index ? g.index.count : g.attributes.position?.count ?? 0;
    const per = Math.max(0, Math.min(n, g.drawRange?.count ?? Infinity));
    const inst = p ? p.instanceCount : (ro.object.isInstancedMesh ? ro.object.count : 1);
    const e = drawn.get(ro.object) ?? { draws: 0, tris: 0 };
    e.draws++;
    e.tris += ro.object.isMesh ? Math.floor(per / 3) * inst : 0;
    drawn.set(ro.object, e);
  }
  return draw.call(this, ro, info);
};
const raf = window.requestAnimationFrame, held = [], movers = [];
const wasPaused = t.paused, autoClear = R.autoClear, target = R.getRenderTarget();
const shadows = [];
scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow) shadows.push(o.shadow); });
const auto = shadows.map((s) => s.autoUpdate);
const nf = R._nodes.nodeFrame, nfUpdate = nf.update;
const picture = async (count = false) => {
  R.setRenderTarget(rt);
  R.autoClear = true;
  capture = count;
  R.render(scene, cam);
  capture = false;
  R.setRenderTarget(target);
  return new Uint32Array((await R.readRenderTargetPixelsAsync(rt, 0, 0, w, h)).buffer);
};
// Pixels that flicker between identical pictures (dithered shading on cars and people),
// grown by 2 px, are left out of the comparison.
let mask = null;
const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(mask && mask[i])) n++; return n; };
const started = performance.now();
try {
  t.paused = true;
  // The live game stops drawing frames meanwhile: its frame callbacks wait.
  window.requestAnimationFrame = (cb) => { held.push(cb); return 0; };
  // Things that move even while the game is paused, and hide nothing: left out.
  scene.traverse((o) => { if (/^birds/.test(label.get(o) ?? '') && o.visible) movers.push(o); });
  movers.forEach((o) => { o.visible = false; });
  await sleep(300);
  R.setRenderTarget(rt);
  R.render(scene, cam);
  R.setRenderTarget(target);
  shadows.forEach((s) => { s.autoUpdate = false; Object.defineProperty(s, 'needsUpdate', { get: () => false, set: () => {}, configurable: true }); });
  // Shader time stands still too.
  nf.update = function () { this.deltaTime = 0; this.lastTime = performance.now(); };
  const base = await picture(true);
  const flicker = new Uint8Array(w * h);
  for (let k = 0; k < 10; k++) { const p = await picture(); for (let i = 0; i < p.length; i++) if (p[i] !== base[i]) flicker[i] = 1; }
  mask = new Uint8Array(w * h);
  let flickering = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (flicker[y * w + x]) {
    flickering++;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) mask[Y * w + X] = 1; }
  }
  const repeat = Math.max(changed(base, await picture()), changed(base, await picture()));
  if (repeat > 100) {
    const kinds = {};
    for (const o of drawn.keys()) (kinds[kind(o)] ??= []).push(o);
    const culprits = {};
    for (const [k, list] of Object.entries(kinds)) {
      list.forEach((o) => { o.userData.__was = o.visible; o.visible = false; });
      const a = await picture(), b = await picture();
      list.forEach((o) => { o.visible = o.userData.__was; delete o.userData.__was; });
      const n = changed(a, b);
      if (n < repeat) culprits[k] = n;
    }
    throw new Error(`the same picture twice differs in ${repeat} pixels; without these kinds: ${JSON.stringify(culprits)}`);
  }
  // Hidden together: each draw, biggest first, stays hidden if the picture is still the
  // same without it and all those already taken away. The set at the end can be left
  // out as a whole without changing a pixel.
  const seen = new Map();
  let units = [...drawn.keys()].map((o) => [o]);
  if (ARGS.tiles) {
    units = [];
    for (const tile of D.world.loaded.values()) {
      const d = tile.drawn;
      if (!d) continue;
      const ground = [];
      d.surfaces?.group?.traverse((o) => { if (drawn.has(o)) ground.push(o); });
      if (ground.length) units.push(ground);
      d.group.traverse((o) => { if (drawn.has(o) && !ground.includes(o)) units.push([o]); });
    }
  }
  const size = (u) => u.reduce((a, o) => a + drawn.get(o).tris, 0);
  const order = units.sort((a, b) => size(b) - size(a));
  const away = [];
  for (const unit of order) {
    const was = unit.map((o) => o.visible);
    unit.forEach((o) => { o.visible = false; });
    const n = changed(base, await picture());
    unit.forEach((o) => seen.set(o, n));
    if (n <= repeat) unit.forEach((o, k) => away.push([o, was[k]])); else unit.forEach((o, k) => { o.visible = was[k]; });
  }
  const check = changed(base, await picture());
  if (ARGS.keep) window.__hiddenDraws = away.map(([o]) => o);
  for (const [o, was] of away) o.visible = was;
  const near = cam.getWorldPosition(new THREE.Vector3());
  const by = {}, bands = {}, all = { draws: 0, tris: 0, hiddenDraws: 0, hiddenTris: 0 };
  const add = (s, e, hid) => { s.draws += e.draws; s.tris += e.tris; if (hid) { s.hiddenDraws += e.draws; s.hiddenTris += e.tris; } };
  for (const [o, e] of drawn) {
    const hid = seen.has(o) && seen.get(o) <= repeat;
    add((by[kind(o)] ??= { draws: 0, tris: 0, hiddenDraws: 0, hiddenTris: 0 }), e, hid);
    add(all, e, hid);
    if (o.geometry && !o.isInstancedMesh) {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const d = o.geometry.boundingSphere.center.clone().applyMatrix4(o.matrixWorld).distanceTo(near);
      add((bands[d < 100 ? 'under 100 m' : d < 250 ? '100–250 m' : 'over 250 m'] ??= { draws: 0, tris: 0, hiddenDraws: 0, hiddenTris: 0 }), e, hid);
    }
  }
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const line = (s) => `${s.hiddenDraws}/${s.draws} draws hidden, ${(s.hiddenTris / 1e3).toFixed(0)}k/${(s.tris / 1e3).toFixed(0)}k tris (${pct(s.hiddenTris, s.tris)} %)`;
  return {
    check, flickering, masked: mask.reduce((a, b) => a + b, 0),
    where: t.where(), heading: t.where().heading, runway: Math.round(t.runway(t.where().heading)), eye: near.toArray().map((v) => Math.round(v)), fov: cam.fov, size: [w, h], repeat,
    seconds: Math.round((performance.now() - started) / 1000),
    total: line(all),
    bands: Object.fromEntries(Object.entries(bands).map(([k, s]) => [k, line(s)])),
    kinds: Object.fromEntries(Object.entries(by).sort((a, b) => b[1].tris - a[1].tris).slice(0, ARGS.top ?? 99).map(([k, s]) => [k, line(s)])),
  };
} finally {
  back.draw = draw;
  shadows.forEach((s, i) => { delete s.needsUpdate; s.autoUpdate = auto[i]; s.needsUpdate = true; });
  nf.update = nfUpdate;
  R.autoClear = autoClear;
  R.setRenderTarget(target);
  t.paused = wasPaused;
  window.requestAnimationFrame = raf;
  held.splice(0).forEach((cb) => raf(cb));
  movers.forEach((o) => { o.visible = true; });
  rt.dispose();
}
