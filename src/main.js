import * as THREE from 'three';
import { Geo, rng, signedArea } from '../geo.js';
import { paintGround } from '../ground.js';
import { initRoofs, buildBuildings, buildWalls } from '../buildings.js';
import { buildTrees } from '../vegetation.js';
import { buildTransit } from '../transit.js';
import { buildWalkGrid, nearestWalkable } from '../player.js';
import { buildDriveGraph, buildWalkGraph, StreetNames, Polyline, segDist, clamp } from './network.js';
import { Car, collideBodies, randomType } from './car.js';
import { Traffic } from './traffic.js';
import { Crowd, Walker } from './people.js';

const AREA = new URLSearchParams(location.search).get('area') || 'ujezd';
const $ = (id) => document.getElementById(id);
const status = (t) => { $('loading-text').textContent = t; };
const frame = () => new Promise((r) => setTimeout(r, 16));

const TRAFFIC = 34;
const PEOPLE = 140;

async function main() {
  status('Loading the map…');
  const [data, streets] = await Promise.all([
    fetch(`data/${AREA}.json`).then((r) => r.json()),
    fetch(`data/${AREA}_streets.json`).then((r) => r.json()),
  ]);
  // Present-day city: put back the buildings the 1945 map leaves out.
  for (const b of data.removed_for_1945 || []) {
    for (const rings of b.rings) {
      if (Math.abs(signedArea(rings[0])) < 30) continue;
      data.buildings.push({ id: b.id, kind: 'yes', name: b.name, h: 11, minh: 0, roof: null, church: false, part: false, rings });
    }
  }
  const geo = new Geo(data);
  const r = rng(11);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a2622');
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 5000);
  camera.up.set(0, 0, -1);

  scene.add(new THREE.HemisphereLight('#e4ecf2', '#8a7a5e', 1.5));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(-110, 190, -80);

  status('Painting the streets…');
  await frame();
  const groundTex = new THREE.CanvasTexture(paintGround(geo));
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(geo.W, geo.H), new THREE.MeshLambertMaterial({ map: groundTex }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(geo.cx, 0, -geo.cy);
  ground.receiveShadow = true;
  scene.add(ground);

  status('Raising roofs…');
  await frame();
  await initRoofs();
  scene.add(buildBuildings(data).mesh, buildWalls(data));
  status('Planting trees…');
  await frame();
  const trees = buildTrees(geo).mesh;
  scene.add(trees);
  const transit = buildTransit(data, scene);

  status('Filling the streets…');
  await frame();
  const grid = buildWalkGrid(geo);
  // Tree trunks are solid; you can drive under the canopy but not through the trunk.
  {
    const m = new THREE.Matrix4();
    for (let i = 0; i < trees.count; i++) {
      trees.getMatrixAt(i, m);
      const x = m.elements[12], y = -m.elements[14];
      const rad = 0.35 + Math.hypot(m.elements[0], m.elements[1], m.elements[2]) * 0.06;
      const [u, v] = geo.px(x, y, grid.res);
      const R = Math.ceil(rad * grid.res);
      for (let j = -R; j <= R; j++) {
        for (let k = -R; k <= R; k++) {
          if (Math.hypot(j, k) > rad * grid.res) continue;
          const cu = Math.floor(u) + k, cv = Math.floor(v) + j;
          if (cu >= 0 && cv >= 0 && cu < grid.w && cv < grid.h) grid.cells[cv * grid.w + cu] = 255;
        }
      }
    }
  }
  const drive = buildDriveGraph(streets);
  const walk = buildWalkGraph(streets);
  const names = new StreetNames(drive.edges, walk.edges);
  const crowd = new Crowd(walk, grid, scene, r, PEOPLE);
  const traffic = new Traffic(drive, scene, r, TRAFFIC);

  // Parked cars along the kerb, wherever they leave the driving lane free.
  const railSegs = [];
  for (const rl of data.rails) for (let i = 0; i < rl.pts.length - 1; i++) railSegs.push([rl.pts[i], rl.pts[i + 1]]);
  const nearRail = (x, y) => railSegs.some(([a, b]) => segDist(x, y, a, b) < 3.2);
  const loose = [];
  const addLoose = (car) => { car.mode = 'loose'; loose.push(car); scene.add(car.mesh); return car; };
  const clearAt = (car) => car.worldSamples().every(([x, y]) => grid.at(x, y) === 0);
  for (const e of drive.edges) {
    if (e.bridge || e.path.length < 30) continue;
    const kerb = e.width / 2 - 1.05;
    const sides = e.oneway ? [1, -1] : [1];
    for (const side of sides) {
      if (Math.abs(side * kerb - e.laneOffset) < 2.3) continue;
      const line = new Polyline(e.pts);
      for (let s = 10; s < line.length - 10; s += 5.6 + r() * 4) {
        if (r() > 0.45) continue;
        const q = line.at(s);
        const x = q.x + Math.sin(q.ang) * kerb * side, y = q.y - Math.cos(q.ang) * kerb * side;
        if (nearRail(x, y)) continue;
        const car = new Car(randomType(r), r, x, y, q.ang + (side < 0 && r() > 0.5 ? Math.PI : 0));
        if (!clearAt(car) || loose.some((c) => Math.hypot(c.x - x, c.y - y) < 5)) continue;
        addLoose(car);
      }
    }
  }

  // ---- Player ------------------------------------------------------------
  const walker = new Walker(grid);
  scene.add(walker.mesh);
  const ujezd = drive.edges.filter((e) => e.name === 'Újezd').sort((a, b) => b.path.length - a.path.length)[0] || drive.edges[0];
  {
    const q = ujezd.path.at(ujezd.path.length / 2);
    const side = ujezd.width / 2 + 1.2;
    const [x, y] = nearestWalkable(grid, q.x + Math.sin(q.ang) * side, q.y - Math.cos(q.ang) * side);
    walker.x = x;
    walker.y = y;
    walker.h = q.ang;
    walker.sync();
    // A car waiting at the kerb right next to the start.
    const car = new Car('hatch', r, q.x + Math.sin(q.ang) * (side - 2.3), q.y - Math.cos(q.ang) * (side - 2.3), q.ang);
    if (clearAt(car)) {
      for (let i = loose.length - 1; i >= 0; i--) if (Math.hypot(loose[i].x - car.x, loose[i].y - car.y) < 6) { scene.remove(loose[i].mesh); loose.splice(i, 1); }
      addLoose(car);
    }
  }
  const parked = loose.length;
  let inCar = null;
  let height = 75;
  const camPos = new THREE.Vector3(walker.x, 0, -walker.y);

  const viewRadius = () => height * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.hypot(1, camera.aspect) + 15;
  const px = () => (inCar ? inCar.x : walker.x), py = () => (inCar ? inCar.y : walker.y);
  const offscreen = (x, y) => Math.hypot(x - camPos.x, y + camPos.z) > viewRadius();
  for (let i = 0; i < TRAFFIC; i++) traffic.spawn((x, y) => Math.hypot(x - walker.x, y - walker.y) > 25);

  const enterOrExit = () => {
    if (inCar) {
      const c = inCar, lx = -Math.sin(c.h), ly = Math.cos(c.h);
      let spot = null;
      for (const s of [1, -1]) {
        const x = c.x + lx * s * (c.spec.W / 2 + 0.8), y = c.y + ly * s * (c.spec.W / 2 + 0.8);
        if (!walker.blocked(x, y)) { spot = [x, y]; break; }
      }
      [walker.x, walker.y] = spot || nearestWalkable(grid, c.x, c.y);
      walker.h = c.h;
      c.mode = 'loose';
      loose.push(c);
      inCar = null;
      walker.mesh.visible = true;
      walker.sync();
      return;
    }
    let best = null, bestD = Infinity;
    for (const c of [...loose, ...traffic.agents.map((a) => a.car)]) {
      const d = Math.hypot(c.x - walker.x, c.y - walker.y) - c.spec.L / 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best || bestD > 1.8) return;
    const agent = traffic.agents.find((a) => a.car === best);
    if (agent) {
      traffic.release(agent);
      // The driver gets out and runs off.
      const lx = -Math.sin(best.h), ly = Math.cos(best.h);
      const p = crowd.spawnAt(best.x + lx * 1.6, best.y + ly * 1.6);
      p.state = 'flee';
      p.t = 2;
      p.vx = lx * 5;
      p.vy = ly * 5;
    } else loose.splice(loose.indexOf(best), 1);
    best.mode = 'player';
    inCar = best;
    walker.mesh.visible = false;
  };

  const backOnRoad = () => {
    if (!inCar) return;
    let best = null, bestD = Infinity;
    for (const e of drive.edges) {
      for (let s = 0; s < e.path.length; s += 3) {
        const q = e.path.at(s), d = Math.hypot(q.x - inCar.x, q.y - inCar.y);
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (!best) return;
    Object.assign(inCar, { x: best.x, y: best.y, h: best.ang, vx: 0, vy: 0, w: 0 });
    inCar.sync();
  };

  // ---- Input -------------------------------------------------------------
  const input = { up: false, down: false, left: false, right: false, run: false, brake: false };
  const keymap = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'brake' };
  addEventListener('keydown', (e) => {
    if (keymap[e.code]) { input[keymap[e.code]] = true; e.preventDefault(); }
    if (e.shiftKey) input.run = true;
    if ((e.code === 'KeyE' || e.code === 'Enter') && !e.repeat) enterOrExit();
    if (e.code === 'KeyR') backOnRoad();
  });
  addEventListener('keyup', (e) => {
    if (keymap[e.code]) input[keymap[e.code]] = false;
    if (!e.shiftKey) input.run = false;
  });
  let zoom = 1;
  addEventListener('wheel', (e) => { zoom = clamp(zoom * Math.exp(e.deltaY * 0.0012), 0.5, 12); }, { passive: true });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---- Loop --------------------------------------------------------------
  const look = new THREE.Vector3();
  let last = performance.now(), shake = 0;
  let street = null, bannerT = 0;
  const stats = { knocked: 0, wrecked: 0 };

  const trams = transit.vehicles.filter((v) => v.mesh.children.length > 3);
  const tramBody = (v) => {
    const a = v.mesh.rotation.y, c = Math.cos(a), s = Math.sin(a);
    const x = v.mesh.position.x, y = -v.mesh.position.z;
    const moving = v.wait > 0 ? 0 : v.dir * v.speed;
    return { x, y, vx: c * moving, vy: s * moving, h: a, dirX: c * v.dir, dirY: s * v.dir, circles: [-5, -2.5, 0, 2.5, 5].map((o) => [x + c * o, y + s * o]) };
  };

  $('loading').classList.add('done');

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Player
    if (inCar) {
      const ctl = { throttle: (input.up ? 1 : 0) - (input.down ? 1 : 0), steer: (input.left ? 1 : 0) - (input.right ? 1 : 0), handbrake: input.brake };
      const hit = inCar.update(dt, ctl, grid);
      if (hit > 6) shake = Math.min(1.2, shake + hit * 0.04);
    } else walker.update(dt, input);

    for (const c of loose) if (c.speed > 0.05 || Math.abs(c.w) > 0.01) c.update(dt, null, grid);

    // Everything the traffic and the trams need to look out for.
    const obstacles = [];
    const pushCar = (c) => { for (const [x, y] of c.circles()) obstacles.push({ x, y, r: c.r, vx: c.vx, vy: c.vy, kind: c.mode === 'player' ? 'player' : 'car', car: c }); };
    for (const a of traffic.agents) pushCar(a.car);
    for (const c of loose) pushCar(c);
    if (inCar) pushCar(inCar);
    else obstacles.push({ x: walker.x, y: walker.y, r: 0.5, vx: walker.vx, vy: walker.vy, kind: 'player' });
    for (const p of crowd.people) if (p.state !== 'walk' || p.e.side === 0) obstacles.push({ x: p.x, y: p.y, r: 0.4, vx: p.vx, vy: p.vy, kind: 'person' });
    const tramBodies = trams.map(tramBody);
    for (const t of tramBodies) for (const [x, y] of t.circles) obstacles.push({ x, y, r: 1.25, vx: t.vx, vy: t.vy, kind: 'tram' });

    traffic.update(dt, obstacles);

    // Trams stop for whatever is on the track in front of them.
    trams.forEach((v, i) => {
      const t = tramBodies[i];
      for (const o of obstacles) {
        if (o.kind === 'tram') continue;
        const dx = o.x - t.x, dy = o.y - t.y;
        const ahead = dx * t.dirX + dy * t.dirY, side = Math.abs(dx * t.dirY - dy * t.dirX);
        if (ahead > 5 && ahead < 16 && side < 1.3 + o.r) { v.wait = Math.max(v.wait, 0.3); break; }
      }
    });
    transit.update(dt);

    const threats = [...(inCar ? [inCar] : []), ...loose.filter((c) => c.speed > 5)];
    crowd.update(dt, threats);

    // ---- Collisions ------------------------------------------------------
    const dynamic = inCar ? [inCar, ...loose] : loose;
    const near = (a, b, d) => Math.abs(a.x - b.x) < d && Math.abs(a.y - b.y) < d;
    for (const a of dynamic) {
      const ca = a.circles();
      for (const ag of [...traffic.agents]) {
        const b = ag.car;
        if (!near(a, b, 7)) continue;
        const cb = b.circles();
        if (!touching(ca, cb, a.r + b.r)) continue;
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const closing = ((a.vx - b.vx) * (b.x - a.x) + (a.vy - b.vy) * (b.y - a.y)) / d;
        if (closing > 3.5) {
          traffic.release(ag);
          b.mode = 'loose';
          loose.push(b);
          stats.wrecked++;
          collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
        } else collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 0);
      }
    }
    for (let i = 0; i < dynamic.length; i++) {
      const a = dynamic[i];
      for (let j = i + 1; j < dynamic.length; j++) {
        const b = dynamic[j];
        if (!near(a, b, 7)) continue;
        const hit = collideBodies(a, a.circles(), a.r, 1 / a.mass, b, b.circles(), b.r, 1 / b.mass);
        if (hit > 6 && (a === inCar || b === inCar)) shake = Math.min(1.2, shake + hit * 0.04);
      }
      for (const t of tramBodies) {
        if (!near(a, t, 10)) continue;
        const hit = collideBodies(t, t.circles, 1.25, 0, a, a.circles(), a.r, 1 / a.mass);
        if (hit > 6 && a === inCar) shake = Math.min(1.2, shake + hit * 0.04);
      }
      a.sync();
    }

    // People and cars
    const allCars = [...dynamic, ...traffic.agents.map((ag) => ag.car)];
    for (const p of crowd.people) {
      for (const c of allCars) {
        if (!near(p, c, 4)) continue;
        for (const [cx, cy] of c.circles()) {
          const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy), min = c.r + 0.3;
          if (d >= min) continue;
          const nx = dx / (d || 1), ny = dy / (d || 1);
          const sp = c.speed;
          if (sp > 3 && p.state !== 'down' && c.mode !== 'traffic') {
            crowd.knock(p, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
            c.vx *= 0.93;
            c.vy *= 0.93;
            stats.knocked++;
          }
          p.x = cx + nx * min;
          p.y = cy + ny * min;
          break;
        }
      }
    }
    if (!inCar) {
      for (const c of allCars) {
        if (!near(walker, c, 4)) continue;
        for (const [cx, cy] of c.circles()) {
          const dx = walker.x - cx, dy = walker.y - cy, d = Math.hypot(dx, dy), min = c.r + 0.35;
          if (d >= min) continue;
          const nx = dx / (d || 1), ny = dy / (d || 1);
          if (c.speed > 4 && walker.down <= 0) { walker.knock(c.vx + nx * 2, c.vy + ny * 2); shake = 0.6; }
          if (!walker.blocked(cx + nx * min, cy + ny * min)) { walker.x = cx + nx * min; walker.y = cy + ny * min; }
          break;
        }
      }
      walker.sync();
    }

    // Keep the streets full: top up traffic out of sight, clear old wrecks.
    if (traffic.agents.length < TRAFFIC) traffic.spawn((x, y) => offscreen(x, y));
    if (loose.length > parked + 30) {
      const far = loose.filter((c) => offscreen(c.x, c.y)).sort((a, b) => Math.hypot(b.x - px(), b.y - py()) - Math.hypot(a.x - px(), a.y - py()))[0];
      if (far) { scene.remove(far.mesh); loose.splice(loose.indexOf(far), 1); }
    }
    crowd.render();

    // ---- Camera ----------------------------------------------------------
    const sp = inCar ? inCar.speed : 0;
    const want = (inCar ? 95 + sp * 3.2 : 75) * zoom;
    height += (want - height) * Math.min(1, dt * (want > height ? 1.6 : 0.9));
    const lead = inCar ? 0.7 : 0.3;
    look.set(px() + (inCar ? inCar.vx : walker.vx) * lead, 0, -(py() + (inCar ? inCar.vy : walker.vy) * lead));
    camPos.lerp(look, Math.min(1, dt * 4));
    shake *= Math.exp(-6 * dt);
    const jx = (Math.random() - 0.5) * shake * 2, jz = (Math.random() - 0.5) * shake * 2;
    camera.position.set(camPos.x + jx, height, camPos.z + jz);
    camera.lookAt(camPos.x + jx, 0, camPos.z + jz);

    const ext = Math.max(90, height * 0.5);
    const sc = sun.shadow.camera;
    if (Math.abs(sc.right - ext) > 4) {
      sc.left = sc.bottom = -ext;
      sc.right = sc.top = ext;
      sc.far = 1400;
      sc.updateProjectionMatrix();
    }
    sun.target.position.set(camPos.x, 0, camPos.z);
    sun.position.copy(sun.target.position).add(SUN_OFFSET);

    // ---- HUD -------------------------------------------------------------
    const name = names.at(px(), py());
    if (name && name !== street) {
      street = name;
      $('street').textContent = name;
      $('banner').textContent = name;
      bannerT = 2.6;
    }
    bannerT -= dt;
    $('banner').style.opacity = clamp(bannerT, 0, 1);
    $('speed').textContent = inCar ? Math.round(Math.abs(inCar.forwardSpeed) * 3.6) : '–';
    let hint = '';
    if (inCar) hint = '<b>E</b> get out';
    else if ([...loose, ...traffic.agents.map((a) => a.car)].some((c) => Math.hypot(c.x - walker.x, c.y - walker.y) - c.spec.L / 2 < 1.8)) hint = '<b>E</b> get in';
    $('hint').innerHTML = hint;
    $('tally').textContent = `${stats.wrecked} cars wrecked · ${stats.knocked} people knocked over`;

    renderer.render(scene, camera);
  });

  window.__drive = {
    scene, camera, traffic, crowd, loose, drive, walk, grid, walker, stats,
    get car() { return inCar; },
    teleport: (x, y) => { (inCar || walker).x = x; (inCar || walker).y = y; camPos.set(x, 0, -y); },
    enterOrExit,
  };
}

function touching(ca, cb, rr) {
  for (const p of ca) for (const q of cb) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < rr) return true;
  return false;
}

main().catch((e) => {
  console.error(e);
  status(`Something went wrong: ${e.message}`);
});
