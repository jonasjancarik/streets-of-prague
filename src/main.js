import * as THREE from 'three';
import proj4 from 'proj4';
import { buildTransit } from '../transit.js';
import { nearestWalkable } from '../player.js';
import { DriveGraph, WalkGraph, buildDriveGraph, buildWalkGraph, StreetNames, SpatialHash, clamp } from './network.js';
import { Car, CarPool, collideBodies } from './car.js';
import { Traffic } from './traffic.js';
import { Crowd, Walker } from './people.js';
import { Trams } from './trams.js';
import { Zones } from './parking.js';
import { TileWorld } from './tiles.js';
import { setupDev } from './dev.js';
import { LaneAssist } from './assist.js';

const params = new URLSearchParams(location.search);
const AREA = params.get('area') || 'centrum';
const $ = (id) => document.getElementById(id);
const status = (t) => { $('loading-text').textContent = t; };

const TRAFFIC = 40;
const PEOPLE = 240;
const LIFE_RADIUS = 330; // traffic and people are kept within this distance of the player

async function main() {
  status('Loading the map…');
  const index = await fetch(`data/${AREA}_now/index.json`).then((r) => r.json());
  // Newer tiles carry their own paid-parking sections; older areas have one file.
  const parking = index.parkingInTiles ? null
    : await fetch(`data/${AREA}_parking.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // Newer tiles carry their own street graphs; older areas have one file for the lot.
  const streets = index.graphs ? null : await fetch(`data/${AREA}_traffic.json`).then((r) => r.json());
  const zones = new Zones(parking);
  const seeded = (() => { let s = 11; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a2622');
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 6000);
  camera.up.set(0, 0, -1);

  scene.add(new THREE.HemisphereLight('#e4ecf2', '#8a7a5e', 1.5));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(-110, 190, -80);

  const drive = streets ? buildDriveGraph(streets) : new DriveGraph();
  const walk = streets ? buildWalkGraph(streets) : new WalkGraph();
  const names = new StreetNames(drive.edges, walk.edges);
  const time = { value: 0 };
  const world = new TileWorld({ area: AREA, index, scene, drive, walk, zones, time, night: params.has('night'), osmBuildings: params.has('osm') });
  const grid = world.grid;
  const ground = (x, y) => world.heightAt(x, y);
  let crowd = null;
  world.onEdges = (d, w) => { names.add(d); names.add(w); crowd?.index(w); };

  // Parked cars come and go with their tiles; wrecks and abandoned cars are loose too.
  const loose = [];
  const tileCars = new Set();
  world.onCars = (cars) => { for (const c of cars) { loose.push(c); tileCars.add(c); } };
  world.onDrop = (tile) => {
    const gone = new Set(tile.cars.filter((c) => c.mode === 'loose'));
    for (let i = loose.length - 1; i >= 0; i--) if (gone.has(loose[i])) { tileCars.delete(loose[i]); loose.splice(i, 1); }
  };

  // Start on Újezd (or ?start=lon,lat) if it's in the area, otherwise in the middle.
  const [w0, s0, e0, n0] = index.bbox_wgs84, lon0 = (w0 + e0) / 2, lat0 = (s0 + n0) / 2;
  const [slon, slat] = (params.get('start') || '14.4052,50.0808').split(',').map(Number);
  const inArea = slon > w0 && slon < e0 && slat > s0 && slat < n0;
  // The pipeline's local metres: a transverse Mercator centred on the area.
  const [sx, sy] = inArea
    ? proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, [slon, slat])
    : [0, 0];
  status('Building the streets…');
  await world.loadNow(sx, sy, 380);
  const startEdge = drive.edges.reduce((best, e) => {
    const d = (f) => Math.hypot(f.pts[0][0] - sx, f.pts[0][1] - sy) + (f.name ? 0 : 60);
    return d(e) < d(best) ? e : best;
  }, drive.edges[0]);
  const q = startEdge.path.at(startEdge.path.length / 2);

  const transit = buildTransit({ rails: index.rails }, scene);
  const trams = new Trams(transit, scene);
  crowd = new Crowd(walk, grid, scene, seeded, PEOPLE);
  const traffic = new Traffic(drive, scene, seeded, TRAFFIC);
  const carPool = new CarPool(scene);

  // ---- Player ------------------------------------------------------------
  const walker = new Walker(grid);
  scene.add(walker.mesh);
  {
    const side = startEdge.width / 2 + 1.2;
    const [x, y] = nearestWalkable(grid, q.x + Math.sin(q.ang) * side, q.y - Math.cos(q.ang) * side);
    Object.assign(walker, { x, y, h: q.ang });
    walker.sync();
    // A car waiting at the kerb right next to the start.
    const car = new Car('hatch', seeded, q.x + Math.sin(q.ang) * (side - 2.3), q.y - Math.cos(q.ang) * (side - 2.3), q.ang);
    if (car.worldSamples().every(([x, y]) => grid.at(x, y) === 0)) {
      for (let i = loose.length - 1; i >= 0; i--) if (Math.hypot(loose[i].x - car.x, loose[i].y - car.y) < 6) loose.splice(i, 1);
      car.mode = 'loose';
      loose.push(car);
    }
  }
  let inCar = null;
  let height = 100;
  const camPos = new THREE.Vector3(walker.x, 0, -walker.y);
  let camGround = ground(walker.x, walker.y);

  const viewRadius = () => height * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.hypot(1, camera.aspect) + 15;
  const px = () => (inCar ? inCar.x : walker.x), py = () => (inCar ? inCar.y : walker.y);
  const offscreen = (x, y) => Math.hypot(x - camPos.x, y + camPos.z) > viewRadius();
  const edgesNear = (x, y, rMax) => world.around(x, y, rMax).flatMap((k) => world.driveBy.get(k) || []);
  const walkNear = (x, y, rMax) => world.around(x, y, rMax).flatMap((k) => world.walkBy.get(k) || []);

  const lifeSpots = (x, y, rMin) => (sx, sy) => {
    const d = Math.hypot(sx - x, sy - y);
    return d > rMin && d < LIFE_RADIUS && world.grid.at(sx, sy) !== 255;
  };
  for (let i = 0; i < TRAFFIC; i++) traffic.spawn(lifeSpots(walker.x, walker.y, 25), edgesNear(walker.x, walker.y, LIFE_RADIUS));
  // People who wander too far are moved to just outside the view, so they walk into it.
  const scatterPeople = (onlyFar) => {
    const edges = walkNear(px(), py(), onlyFar ? Math.min(LIFE_RADIUS, viewRadius() + 90) : LIFE_RADIUS * 0.6);
    if (!edges.length) return;
    for (const p of crowd.people) {
      if (onlyFar && Math.hypot(p.x - px(), p.y - py()) < LIFE_RADIUS) continue;
      for (let t = 0; t < 8; t++) {
        const e = edges[Math.floor(seeded() * edges.length)], s = seeded() * e.path.length, at = e.path.at(s);
        if (onlyFar && !offscreen(at.x, at.y)) continue;
        Object.assign(p, { e, s, state: 'walk', vx: 0, vy: 0 });
        crowd.place(p);
        break;
      }
    }
  };
  scatterPeople(false);

  const allCars = () => [...loose, ...traffic.agents.map((a) => a.car)];
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
    for (const c of allCars()) {
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
      Object.assign(p, { state: 'flee', t: 2, vx: lx * 5, vy: ly * 5 });
    } else {
      loose.splice(loose.indexOf(best), 1);
      tileCars.delete(best); // it's yours now: it stays when its tile unloads
    }
    best.mode = 'player';
    inCar = best;
    walker.mesh.visible = false;
  };

  const backOnRoad = () => {
    if (!inCar) return;
    let best = null, bestD = Infinity;
    for (const e of edgesNear(inCar.x, inCar.y, 150)) {
      for (let s = 0; s < e.path.length; s += 3) {
        const p = e.path.at(s), d = Math.hypot(p.x - inCar.x, p.y - inCar.y);
        if (d < bestD) { bestD = d; best = p; }
      }
    }
    if (!best) return;
    Object.assign(inCar, { x: best.x, y: best.y, h: best.ang, vx: 0, vy: 0, w: 0 });
  };

  // Jump anywhere in the area: load the tiles there first, then land on a pavement
  // (or on the road, if you're driving) and bring the traffic and people along.
  const teleportTo = async (x, y) => {
    const who = inCar || walker;
    Object.assign(who, { x, y, vx: 0, vy: 0 });
    if (inCar) inCar.w = 0;
    camPos.set(x, 0, -y);
    await world.loadNow(x, y, 300);
    if (inCar) backOnRoad();
    else { [walker.x, walker.y] = nearestWalkable(grid, x, y, 150); walker.sync(); }
    for (const a of [...traffic.agents]) traffic.release(a);
    scatterPeople(false);
    camPos.set(px(), 0, -py());
    camGround = ground(px(), py());
    street = null; // show the new street's name, not the old one
    $('street').textContent = '';
  };
  const assist = new LaneAssist(drive, (x, y, r) => edgesNear(x, y, r));
  let assisted = false;
  const dev = setupDev({ area: AREA, index, teleport: teleportTo, position: () => [px(), py()] });

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
  addEventListener('wheel', (e) => { zoom = clamp(zoom * Math.exp(e.deltaY * 0.0012), 0.5, 4); }, { passive: true });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---- Loop --------------------------------------------------------------
  const look = new THREE.Vector3();
  let last = performance.now(), shake = 0;
  let street = null, bannerT = 0, lifeT = 0;
  const stats = { knocked: 0, wrecked: 0 };
  const hash = new SpatialHash(10);
  const near = (a, b, d) => Math.abs(a.x - b.x) < d && Math.abs(a.y - b.y) < d;

  $('loading').classList.add('done');

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    time.value += dt;
    world.update(camPos.x, -camPos.z, viewRadius() + 220);

    // Player. In the car, Shift is lane assist: it steers along your lane, and A/D
    // picks the turn at the next junction instead of steering.
    assisted = false;
    if (inCar) {
      let steer = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      if (input.run) {
        const a = assist.steer(inCar, steer);
        if (a !== null) { steer = a; assisted = true; }
      } else assist.reset();
      const ctl = { throttle: (input.up ? 1 : 0) - (input.down ? 1 : 0), steer, handbrake: input.brake };
      const hit = inCar.update(dt, ctl, grid);
      if (hit > 6) shake = Math.min(1.2, shake + hit * 0.04);
    } else walker.update(dt, input);

    const moving = (c) => c.mode === 'player' || c.speed > 0.05 || Math.abs(c.w) > 0.01;
    const movers = loose.filter(moving);
    for (const c of movers) c.update(dt, null, grid);

    // Everything the traffic, trams and people need to look out for.
    hash.clear();
    const pushCar = (c) => { for (const [x, y] of c.circles()) hash.add({ x, y, r: c.r, vx: c.vx, vy: c.vy, kind: c.mode === 'player' ? 'player' : 'car', car: c }); };
    for (const a of traffic.agents) pushCar(a.car);
    for (const c of loose) pushCar(c);
    if (inCar) pushCar(inCar);
    else hash.add({ x: walker.x, y: walker.y, r: 0.5, vx: walker.vx, vy: walker.vy, kind: 'player' });
    for (const p of crowd.people) if (p.state !== 'walk' || p.e.side === 0) hash.add({ x: p.x, y: p.y, r: 0.4, vx: p.vx, vy: p.vy, kind: 'person' });
    const tramBodies = trams.bodies();
    for (const t of tramBodies) for (const [x, y] of t.circles) hash.add({ x, y, r: 1.25, vx: t.vx, vy: t.vy, kind: 'tram' });

    traffic.update(dt, (x, y, rr) => hash.near(x, y, rr));

    // Trams stop for whatever is on the track in front of them.
    for (const { v, head: t } of tramBodies) {
      for (const o of hash.near(t.x + t.dirX * 5, t.y + t.dirY * 5, 8)) {
        if (o.kind === 'tram') continue;
        const dx = o.x - t.x, dy = o.y - t.y;
        const ahead = dx * t.dirX + dy * t.dirY, side = Math.abs(dx * t.dirY - dy * t.dirX);
        if (ahead > 0 && ahead < 11 && side < 1.3 + o.r) { v.wait = Math.max(v.wait, 0.3); break; }
      }
    }
    transit.update(dt);
    trams.sync(camPos.x, -camPos.z, viewRadius() + 150, ground);

    const threats = [...(inCar ? [inCar] : []), ...movers.filter((c) => c.speed > 5)];
    crowd.update(dt, threats);

    // ---- Collisions ------------------------------------------------------
    const active = inCar ? [inCar, ...movers] : movers;
    const carsNear = (x, y, rr) => {
      const out = new Set();
      for (const o of hash.near(x, y, rr)) if (o.car) out.add(o.car);
      return out;
    };
    const done = new Set();
    for (const a of active) {
      done.add(a);
      const ca = a.circles();
      for (const b of carsNear(a.x, a.y, 8)) {
        if (b === a || done.has(b) || !near(a, b, 7)) continue;
        const cb = b.circles();
        if (b.mode === 'traffic') {
          if (!touching(ca, cb, a.r + b.r)) continue;
          const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const closing = ((a.vx - b.vx) * (b.x - a.x) + (a.vy - b.vy) * (b.y - a.y)) / d;
          const ag = traffic.agents.find((x) => x.car === b);
          if (closing > 3.5 && ag) {
            traffic.release(ag);
            b.mode = 'loose';
            loose.push(b);
            stats.wrecked++;
            collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
          } else collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 0);
          continue;
        }
        const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
        if (hit > 6 && (a === inCar || b === inCar)) shake = Math.min(1.2, shake + hit * 0.04);
      }
      for (const t of tramBodies) {
        if (!near(a, t, 22)) continue;
        const hit = collideBodies(t, t.circles, 1.25, 0, a, a.circles(), a.r, 1 / a.mass);
        if (hit > 6 && a === inCar) shake = Math.min(1.2, shake + hit * 0.04);
      }
    }

    // People and cars
    const bump = (who, rad, onHit) => {
      for (const c of carsNear(who.x, who.y, 5)) {
        if (!near(who, c, 4)) continue;
        for (const [cx, cy] of c.circles()) {
          const dx = who.x - cx, dy = who.y - cy, d = Math.hypot(dx, dy), min = c.r + rad;
          if (d >= min) continue;
          const nx = dx / (d || 1), ny = dy / (d || 1);
          onHit(c, nx, ny);
          if (!grid.at(cx + nx * min, cy + ny * min)) { who.x = cx + nx * min; who.y = cy + ny * min; }
          break;
        }
      }
    };
    for (const p of crowd.people) {
      if (!near(p, { x: px(), y: py() }, 120)) continue;
      bump(p, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && p.state !== 'down' && c.mode !== 'traffic') {
          crowd.knock(p, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
          c.vx *= 0.93;
          c.vy *= 0.93;
          stats.knocked++;
        }
      });
    }
    if (!inCar) {
      bump(walker, 0.35, (c, nx, ny) => {
        if (c.speed > 4 && walker.down <= 0) { walker.knock(c.vx + nx * 2, c.vy + ny * 2); shake = 0.6; }
      });
      walker.sync();
    }

    // Keep life around the player: traffic and people follow you, far ones are recycled.
    lifeT -= dt;
    if (lifeT < 0) {
      lifeT = 0.5;
      for (const a of [...traffic.agents]) if (Math.hypot(a.car.x - px(), a.car.y - py()) > LIFE_RADIUS * 1.3 && offscreen(a.car.x, a.car.y)) traffic.release(a);
      for (let i = loose.length - 1; i >= 0; i--) {
        const c = loose[i];
        if (!tileCars.has(c) && Math.hypot(c.x - px(), c.y - py()) > 600) loose.splice(i, 1);
      }
      scatterPeople(true);
    }
    if (traffic.agents.length < TRAFFIC) traffic.spawn((x, y) => offscreen(x, y) && lifeSpots(px(), py(), 40)(x, y), edgesNear(px(), py(), LIFE_RADIUS));
    crowd.render(ground);
    carPool.render(inCar ? [inCar, ...allCars()] : allCars(), ground);

    // ---- Camera ----------------------------------------------------------
    const sp = inCar ? inCar.speed : 0;
    const want = (inCar ? 120 + sp * 3.4 : 100) * zoom;
    height += (want - height) * Math.min(1, dt * (want > height ? 1.6 : 0.9));
    const lead = inCar ? 0.7 : 0.3;
    look.set(px() + (inCar ? inCar.vx : walker.vx) * lead, 0, -(py() + (inCar ? inCar.vy : walker.vy) * lead));
    camPos.lerp(look, Math.min(1, dt * 4));
    shake *= Math.exp(-6 * dt);
    const jx = (Math.random() - 0.5) * shake * 2, jz = (Math.random() - 0.5) * shake * 2;
    // Follow the ground under the view, smoothed so the camera doesn't bob over kerbs.
    camGround += (ground(camPos.x, -camPos.z) - camGround) * Math.min(1, dt * 3);
    camera.position.set(camPos.x + jx, camGround + height, camPos.z + jz);
    camera.lookAt(camPos.x + jx, camGround, camPos.z + jz);

    const ext = Math.max(90, height * 0.5);
    const sc = sun.shadow.camera;
    if (Math.abs(sc.right - ext) > 4) {
      sc.left = sc.bottom = -ext;
      sc.right = sc.top = ext;
      sc.far = 1400;
      sc.updateProjectionMatrix();
    }
    sun.target.position.set(camPos.x, camGround, camPos.z);
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
    if (inCar) {
      if (input.run && assist.tripped) hint = `<b>Shift</b> lane assist is off above ${assist.limit} km/h: slow down to get it back`;
      else if (!assisted) hint = '<b>E</b> get out · <b>Shift</b> lane assist';
      else hint = `<b>Shift</b> lane assist, up to ${assist.limit} km/h · ${assist.intent > 0 ? 'turning left at the next junction' : assist.intent < 0 ? 'turning right at the next junction' : 'straight on (A/D to turn)'}`;
    }
    else if ([...carsNear(walker.x, walker.y, 5)].some((c) => Math.hypot(c.x - walker.x, c.y - walker.y) - c.spec.L / 2 < 1.8)) hint = '<b>E</b> get in';
    $('hint').innerHTML = hint;
    $('tally').textContent = `${stats.wrecked} cars wrecked · ${stats.knocked} people knocked over`;

    dev.update();
    renderer.render(scene, camera);
  });

  window.__drive = {
    scene, camera, traffic, crowd, loose, drive, walk, grid, walker, stats, world, renderer,
    get car() { return inCar; },
    teleport: (x, y) => { (inCar || walker).x = x; (inCar || walker).y = y; camPos.set(x, 0, -y); },
    enterOrExit, teleportTo, dev,
    view: (z) => { zoom = z; height = (inCar ? 120 : 100) * z; },
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
