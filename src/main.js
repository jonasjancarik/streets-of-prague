import * as THREE from 'three';
import proj4 from 'proj4';
import { buildTransit } from './map/transit.js';
import { DriveGraph, WalkGraph, StreetNames, SpatialHash, clamp } from './network.js';
import { Car, CarPool, collideBodies, useKit } from './car.js';
import { loadKit } from './figures.js';
import { Traffic } from './traffic.js';
import { Crowd, Walker, nearestWalkable } from './people.js';
import { loadFootfall } from './footfall.js';
import { Trams } from './trams.js';
import { TramRide, FAST } from './ride.js';
import { Clock } from './clock.js';
import { StopBoard } from './board.js';
import { Metro } from './metro.js';
import { TileWorld } from './tiles.js';
import { groundSamples } from './surface.js';
import { CUTAWAY } from './shading.js';
import { setupDev } from './dev.js';
import { LaneAssist, turnOf } from './assist.js';
import { setupTouch } from './touch.js';
import { Police } from './police.js';
import { Chopper } from './helicopter.js';

const params = new URLSearchParams(location.search);
const AREA = params.get('area') || 'praha';
const $ = (id) => document.getElementById(id);
const status = (t) => { $('loading-text').textContent = t; };

const TRAFFIC = 40;
const PEOPLE = 600; // round the Old Town Square; fewer where it's quieter (src/footfall.js)
const FEW_PEOPLE = 40; // on the quietest edge of town
const PARKED_TWO = 10; // bikes and motorbikes parked around you
const SHOVE = 1.2; // m/s a tram pushes a car aside, off its track
const LIFE_RADIUS = 330; // traffic and people are kept within this distance of the player

async function main() {
  status('Loading the map…');
  const kitLoad = loadKit();
  const footfallLoad = loadFootfall(AREA);
  const index = await fetch(`data/${AREA}_now/index.json`).then((r) => r.json());
  // Tram lines (pipeline/build_lines.py); without them there are no trams.
  const lines = fetch(`data/${AREA}_now/lines.json`).then((r) => (r.ok ? r.json() : { lines: [] })).catch(() => ({ lines: [] }));
  // The metro (pipeline/build_metro.py); without it there are no entrances.
  const metroData = fetch(`data/${AREA}_now/metro.json`).then((r) => (r.ok ? r.json() : { lines: [] })).catch(() => ({ lines: [] }));
  const seeded = (() => { let s = 11; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // ?dpr=1 draws at that pixel ratio; otherwise it starts at the screen's (up to 2)
  // and comes down while frames take too long (see `resolution` below).
  const maxRatio = Math.min(Number(params.get('dpr')) || devicePixelRatio, 2);
  renderer.setPixelRatio(maxRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Asking the driver whether each shader compiled stalls the frame it's first used in;
  // only the developer panel's ?dev needs the errors.
  renderer.debug.checkShaderErrors = params.has('dev');
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a2622');
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 6000);
  camera.up.set(0, 0, -1);

  scene.add(new THREE.HemisphereLight('#e4ecf2', '#8a7a5e', 1.5));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); // about 9 cm a texel across the ±90 m it covers on foot
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;
  scene.add(sun, sun.target);
  const SUN_OFFSET = new THREE.Vector3(-110, 190, -80);

  // The street graphs grow as tiles load (each tile carries the edges that touch it).
  const drive = new DriveGraph();
  const walk = new WalkGraph();
  const names = new StreetNames(drive.edges, walk.edges);
  const time = { value: 0 };
  // People and two-wheelers (parked motorbikes come with the tiles, so load it first).
  const kit = await kitLoad;
  useKit(kit);
  const clock = new Clock(params);
  const world = new TileWorld({ area: AREA, index, scene, drive, walk, time, night: params.has('night') || clock.night, osmBuildings: params.has('osm') });
  const grid = world.grid;
  // Height of the ground at a point; with `who` (a car, a person), of whatever they're
  // on there: the ground, or a bridge deck (see TileWorld.track).
  const ground = (x, y, who) => (who ? world.groundFor(who, x, y) : world.heightAt(x, y));
  let crowd = null;
  world.onEdges = (d, w) => { names.add(d); names.add(w); crowd?.index(w); };

  // Parked cars come and go with their tiles; wrecks and abandoned cars are loose too.
  const loose = [];
  const tileCars = new Set();
  let restingStale = true; // see syncResting
  world.onCars = (cars) => { for (const c of cars) { loose.push(c); tileCars.add(c); } restingStale = true; };
  world.onDrop = (tile) => {
    const gone = new Set(tile.cars.filter((c) => c.mode === 'loose'));
    for (let i = loose.length - 1; i >= 0; i--) if (gone.has(loose[i])) { tileCars.delete(loose[i]); loose.splice(i, 1); }
    restingStale = true;
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
  const trams = new Trams((await lines).lines, scene, { clock, rng: seeded });
  const ride = new TramRide(trams, world, $('ride'));
  const board = new StopBoard(trams, $('board'));
  // Down into the metro and up again at the station you picked (the police lose you).
  const metro = new Metro(await metroData, scene, $('metro'), {
    clock,
    inMap: (x, y) => world.available.has(world.keyAt(x, y)),
    onArrive: async (x, y, name) => {
      await teleportTo(x, y);
      walker.mesh.visible = true;
      showBanner(name);
    },
  });
  const footfall = await footfallLoad;
  crowd = new Crowd(walk, grid, scene, seeded, PEOPLE, kit);
  crowd.footfall = footfall;
  const traffic = new Traffic(drive, scene, seeded, TRAFFIC);
  const carPool = new CarPool(scene);

  // ---- Player ------------------------------------------------------------
  const walker = new Walker(grid, kit);
  scene.add(walker.mesh);
  {
    const side = (startEdge.kerb?.[0] ?? startEdge.width / 2) + 1.2;
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
    // And a bike a few steps ahead of you.
    const bike = new Car('bike', seeded, x + Math.cos(q.ang) * 3, y + Math.sin(q.ang) * 3, q.ang);
    if (bike.worldSamples().every(([x, y]) => grid.at(x, y) === 0)) loose.push(bike);
  }
  let inCar = null, inHeli = null;
  const choppers = []; // helicopters you can fly (from the developer tools)
  let height = 100;
  const camPos = new THREE.Vector3(walker.x, 0, -walker.y);
  let camGround = ground(walker.x, walker.y, walker);
  let cutR = 0; // radius of the hole in the buildings above a passage or a bridge deck (see CUTAWAY)

  const viewRadius = () => height * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.hypot(1, camera.aspect) + 15;
  const px = () => (inCar || inHeli || walker).x, py = () => (inCar || inHeli || walker).y;
  const offscreen = (x, y) => Math.hypot(x - camPos.x, y + camPos.z) > viewRadius();
  const edgesNear = (x, y, rMax) => world.around(x, y, rMax).flatMap((k) => world.driveBy.get(k) || []);
  const walkNear = (x, y, rMax) => world.around(x, y, rMax).flatMap((k) => world.walkBy.get(k) || []);

  const lifeSpots = (x, y, rMin) => (sx, sy) => {
    const d = Math.hypot(sx - x, sy - y);
    return d > rMin && d < LIFE_RADIUS && world.grid.at(sx, sy) !== 255;
  };
  for (let i = 0; i < TRAFFIC; i++) traffic.spawn(lifeSpots(walker.x, walker.y, 25), edgesNear(walker.x, walker.y, LIFE_RADIUS));
  // How many people are about: from FEW_PEOPLE on the edge of town to PEOPLE round
  // the Old Town Square, by how busy the streets around you are.
  const peopleWanted = () => {
    const busy = Math.min(1, footfall.around(px(), py(), LIFE_RADIUS) / 0.2);
    return Math.round(FEW_PEOPLE + (PEOPLE - FEW_PEOPLE) * busy ** 0.6);
  };
  // A spot on one of the footpaths, busier ones likelier; `ok` can turn spots down.
  const pickSpot = (edges, ok) => {
    let total = 0;
    const upTo = edges.map((e) => (total += e.path.length * (0.02 + footfall.edge(e))));
    for (let t = 0; t < 8; t++) {
      const x = seeded() * total;
      let lo = 0, hi = upTo.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (upTo[mid] < x) lo = mid + 1; else hi = mid; }
      const e = edges[lo], s = seeded() * e.path.length, at = e.path.at(s);
      if (!ok || ok(at.x, at.y)) return { e, s };
    }
    return null;
  };
  // People who wander too far are moved to just outside the view, so they walk into it.
  // Where it's getting quieter some go home, out of sight; where it's getting busier
  // more turn up. `onlyFar` false: everyone at once, anywhere around you.
  const scatterPeople = (onlyFar) => {
    const edges = walkNear(px(), py(), onlyFar ? Math.min(LIFE_RADIUS, viewRadius() + 90) : LIFE_RADIUS * 0.6);
    if (!edges.length) return;
    const ok = onlyFar ? offscreen : null, most = onlyFar ? 20 : Infinity, want = peopleWanted();
    for (let k = crowd.people.length - 1, n = 0; k >= 0 && crowd.people.length > want && n < most; k--) {
      const p = crowd.people[k];
      if (p.state === 'walk' && (!onlyFar || offscreen(p.x, p.y))) { crowd.retire(p); n++; }
    }
    for (const p of crowd.people) {
      if (onlyFar && Math.hypot(p.x - px(), p.y - py()) < LIFE_RADIUS) continue;
      const at = pickSpot(edges, ok);
      if (!at) continue;
      Object.assign(p, { ...at, state: 'walk', vx: 0, vy: 0 });
      crowd.place(p);
    }
    for (let n = 0; crowd.people.length < want && n < most; n++) {
      const at = pickSpot(edges, ok);
      if (!at) break;
      crowd.add(at);
    }
  };
  scatterPeople(false);

  // Bikes and motorbikes left on the pavements around you, topped up out of sight as you
  // move (far ones go with the rest of the loose cars).
  const parkTwoWheelers = (onlyOffscreen) => {
    let n = loose.filter((c) => c.two && Math.hypot(c.x - px(), c.y - py()) < LIFE_RADIUS).length;
    const edges = n < PARKED_TWO ? walkNear(px(), py(), LIFE_RADIUS * 0.8) : [];
    for (let t = 0; t < 30 && n < PARKED_TWO && edges.length; t++) {
      const e = edges[Math.floor(seeded() * edges.length)], q = e.path.at(seeded() * e.path.length);
      const off = (e.side || 1.4) * (seeded() < 0.5 ? 1 : -1);
      const x = q.x + Math.sin(q.ang) * off, y = q.y - Math.cos(q.ang) * off;
      if (onlyOffscreen && !offscreen(x, y)) continue;
      if (loose.some((c) => Math.abs(c.x - x) < 4 && Math.abs(c.y - y) < 4)) continue;
      const c = new Car(seeded() < 0.6 ? 'bike' : 'moto', seeded, x, y, q.ang + (seeded() < 0.5 ? Math.PI : 0));
      if (!c.worldSamples().every(([sx, sy]) => grid.at(sx, sy) === 0)) continue;
      loose.push(c);
      n++;
    }
  };
  parkTwoWheelers(false);

  // Busted: out of the car (the police keep it), and a moment before you can move again.
  const stats = { knocked: 0, wrecked: 0, busted: 0 };
  let frozen = 0;
  const busted = () => {
    if (frozen > 0) return;
    if (inHeli) enterOrExit();
    if (inCar) {
      const c = inCar;
      enterOrExit();
      loose.splice(loose.indexOf(c), 1);
    }
    police.forgive();
    stats.busted++;
    frozen = 2.5;
    showBanner('Busted', true);
  };
  const police = new Police({ scene, drive, traffic, grid, height: ground, rng: seeded, edgesNear, offscreen, onBusted: busted, kit });

  const allCars = () => [...loose, ...traffic.agents.map((a) => a.car), ...police.cars.map((p) => p.car)];
  const drawn = []; // the cars drawn this frame
  // Off the tram onto the pavement beside it.
  const getOff = () => {
    const [x, y, h] = ride.leave();
    [walker.x, walker.y] = nearestWalkable(grid, x, y);
    Object.assign(walker, { h, vx: 0, vy: 0 });
    walker.mesh.visible = true;
    walker.sync();
  };
  const enterOrExit = () => {
    // On a tram: off at this stop (or here, if it's stuck), or at the next one.
    if (ride.on) {
      if (ride.canLeave()) getOff();
      else ride.requestStop();
      return;
    }
    if (inHeli) {
      if (!inHeli.landed) return;
      const c = inHeli;
      [walker.x, walker.y] = nearestWalkable(grid, c.x - Math.sin(c.h) * 3, c.y + Math.cos(c.h) * 3);
      walker.h = c.h;
      inHeli = null;
      walker.mesh.visible = true;
      walker.sync();
      return;
    }
    if (!inCar) {
      const heli = choppers.find((c) => c.landed && Math.hypot(c.x - walker.x, c.y - walker.y) < 4);
      if (heli) {
        inHeli = heli;
        walker.mesh.visible = false;
        return;
      }
    }
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
      c.rider = null;
      loose.push(c);
      inCar = null;
      walker.mesh.visible = true;
      walker.sync();
      return;
    }
    const tram = ride.boardable(walker.x, walker.y);
    if (tram) {
      ride.board(tram);
      walker.mesh.visible = false;
      return;
    }
    const station = metro.near(walker.x, walker.y);
    if (station) {
      metro.open(station);
      return;
    }
    let best = null, bestD = Infinity;
    for (const c of allCars()) {
      const d = Math.hypot(c.x - walker.x, c.y - walker.y) - c.spec.L / 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best || bestD > 1.8) return;
    const agent = traffic.agents.find((a) => a.car === best);
    // A police car: the officer in it gets out and comes after you.
    const cop = best.type === 'police';
    if (cop) police.take(best);
    if (agent) {
      traffic.release(agent);
      if (!cop) {
        // The driver gets out and runs off.
        const lx = -Math.sin(best.h), ly = Math.cos(best.h);
        const p = crowd.spawnAt(best.x + lx * 1.6, best.y + ly * 1.6);
        Object.assign(p, { state: 'flee', t: 2, vx: lx * 5, vy: ly * 5 });
        police.crime('carjack', best.x, best.y);
      }
    } else if (loose.includes(best)) {
      loose.splice(loose.indexOf(best), 1);
      tileCars.delete(best); // it's yours now: it stays when its tile unloads
    }
    best.mode = 'player';
    if (best.two) best.rider = walker.look;
    inCar = best;
    walker.mesh.visible = false;
  };

  // A hard knock on a bike or motorbike throws you off it.
  const throwOff = () => {
    const c = inCar;
    enterOrExit();
    walker.knock(c.vx * 0.6, c.vy * 0.6);
    c.vx *= 0.4;
    c.vy *= 0.4;
    shake = 0.8;
  };

  const backOnRoad = () => {
    if (!inCar) return;
    let best = null, bestD = Infinity, onto = null;
    for (const e of edgesNear(inCar.x, inCar.y, 150)) {
      for (let s = 0; s < e.path.length; s += 3) {
        const p = e.path.at(s), d = Math.hypot(p.x - inCar.x, p.y - inCar.y);
        if (d < bestD) { bestD = d; best = p; onto = e; }
      }
    }
    if (!best) return;
    // Onto a bridge's deck if that street is a bridge, else under it.
    Object.assign(inCar, { x: best.x, y: best.y, h: best.ang, vx: 0, vy: 0, w: 0, level: onto.bridge ? 1 : 0 });
    inCar._tx = inCar.x;
    inCar._ty = inCar.y;
  };

  // Jump anywhere in the area: load the tiles there first, then land on a pavement
  // (or on the road, if you're driving) and bring the traffic and people along.
  const teleportTo = async (x, y) => {
    if (ride.on) getOff();
    const who = inCar || inHeli || walker;
    Object.assign(who, { x, y, vx: 0, vy: 0 });
    if (inHeli) inHeli.z = Math.max(inHeli.z, ground(x, y) + 60);
    if (inCar) inCar.w = 0;
    camPos.set(x, 0, -y);
    await world.loadNow(x, y, 300);
    if (inCar) backOnRoad();
    else if (!inHeli) { [walker.x, walker.y] = nearestWalkable(grid, x, y, 150); walker.sync(); }
    for (const a of [...traffic.agents]) traffic.release(a);
    police.reset();
    scatterPeople(false);
    camPos.set(px(), 0, -py());
    camGround = ground(px(), py(), inHeli ? null : inCar || walker);
    street = null; // show the new street's name, not the old one
    $('street').textContent = '';
  };
  const assist = new LaneAssist(drive, (x, y, r) => edgesNear(x, y, r));
  let assisted = false;
  // Developer tools: a helicopter on the nearest open ground, facing the way you do.
  const addChopper = () => {
    const who = inCar || inHeli || walker;
    for (let r = 8; r < 80; r += 2) for (let a = 0; a < 12; a++) {
      const x = who.x + Math.cos(who.h + (a * Math.PI) / 6) * r, y = who.y + Math.sin(who.h + (a * Math.PI) / 6) * r;
      let open = true;
      for (let dx = -5; dx <= 5 && open; dx += 1) for (let dy = -5; dy <= 5 && open; dy += 1) open = grid.at(x + dx, y + dy) === 0;
      if (!open) continue;
      choppers.push(new Chopper(scene, grid, ground, x, y, who.h));
      return true;
    }
    return false;
  };
  const dev = setupDev({ area: AREA, index, teleport: teleportTo, position: () => [px(), py()], helicopter: addChopper, shiftTime: (h) => clock.advance(h * 3600) });

  // ---- Input -------------------------------------------------------------
  const input = { up: false, down: false, left: false, right: false, run: false, brake: false };
  const keymap = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'brake' };
  addEventListener('keydown', (e) => {
    // The metro screen takes the keys while it's up.
    if (metro.active) {
      metro.key(e.code);
      e.preventDefault();
      return;
    }
    if (keymap[e.code]) { input[keymap[e.code]] = true; e.preventDefault(); }
    if (e.shiftKey) input.run = true;
    if ((e.code === 'KeyE' || e.code === 'Enter') && !e.repeat) enterOrExit();
    if (e.code === 'KeyR') backOnRoad();
    // Space jumps, except at a tram stop, where holding it waits for a tram.
    if (e.code === 'Space' && !e.repeat && !board.shown && !inCar && !inHeli && !ride.on) input.jump = true;
    if (e.code === 'KeyH' && !e.repeat) foldHelp(!$('help').classList.contains('folded'));
    // On a tram, W and S move your pick along the stops ahead.
    if (ride.on && ['KeyW', 'ArrowUp'].includes(e.code)) ride.pick(-1);
    if (ride.on && ['KeyS', 'ArrowDown'].includes(e.code)) ride.pick(1);
  });
  // The controls card remembers whether you folded it away.
  const foldHelp = (folded) => {
    $('help').classList.toggle('folded', folded);
    try { localStorage.setItem('help-folded', folded ? '1' : ''); } catch {}
  };
  try { foldHelp(localStorage.getItem('help-folded') === '1'); } catch {}
  addEventListener('keyup', (e) => {
    if (keymap[e.code]) input[keymap[e.code]] = false;
    if (!e.shiftKey) input.run = false;
  });
  let zoom = 1;
  const zoomBy = (f) => { zoom = clamp(zoom * f, 0.5, 4); };
  addEventListener('wheel', (e) => zoomBy(Math.exp(e.deltaY * 0.0012)), { passive: true });
  const touch = setupTouch({ action: enterOrExit, backOnRoad, zoomBy, force: params.has('touch') });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---- Loop --------------------------------------------------------------
  const look = new THREE.Vector3();
  let last = performance.now(), shake = 0;
  let waitScale = 1, clockShown = '';
  let street = null, bannerT = 0, lifeT = 0;
  // The HUD is only written when what it says changes: every write makes the browser
  // lay the page out again.
  const shown = {};
  const show = (id, value, how = 'text') => {
    const key = `${id}/${how}`;
    if (shown[key] === value) return;
    shown[key] = value;
    const el = $(id);
    if (how === 'html') el.innerHTML = value;
    else if (how === 'opacity') el.style.opacity = value;
    else el.textContent = value;
  };
  const showBanner = (text, alert = false) => {
    $('banner').textContent = text;
    $('banner').classList.toggle('alert', alert);
    bannerT = alert ? 3.5 : 2.6;
  };
  // Everything that moves or blocks, made again every step; parked and abandoned cars
  // that stand still (thousands of them across the loaded tiles) have a hash of their
  // own, made again only when one of them moves, comes or goes.
  const hash = new SpatialHash(10), resting = new SpatialHash(10);
  function* obstacles(x, y, rr) {
    yield* hash.near(x, y, rr);
    yield* resting.near(x, y, rr);
  }
  const near = (a, b, d) => Math.abs(a.x - b.x) < d && Math.abs(a.y - b.y) < d;
  // The cars within rr of (x, y), each once, into `out` (reused, to spare the garbage).
  let stamp = 0;
  const carsNear = (x, y, rr, out = []) => {
    stamp++;
    out.length = 0;
    for (const o of obstacles(x, y, rr)) if (o.car && o.car.stamp !== stamp) { o.car.stamp = stamp; out.push(o.car); }
    return out;
  };
  const nearA = [], nearB = [];
  const pushCar = (h, c) => { for (const [x, y] of c.circles()) h.add({ x, y, z: c.gz, r: c.r, vx: c.vx, vy: c.vy, kind: c.mode === 'player' ? 'player' : 'car', car: c }); };
  // On a bridge and under it: two things that don't meet.
  const apart = (a, b) => a.gz !== undefined && b.gz !== undefined && Math.abs(a.gz - b.gz) > 3;
  const moving = (c) => c.mode === 'player' || c.vx * c.vx + c.vy * c.vy > 0.0025 || Math.abs(c.w) > 0.01; // over 5 cm/s
  let restingCount = -1;
  const syncResting = () => {
    let n = 0, stale = restingStale;
    for (const c of loose) {
      if (moving(c)) { stale ||= c.resting; continue; }
      n++;
      stale ||= !c.resting || c.restAt[0] !== c.x || c.restAt[1] !== c.y || c.restAt[2] !== c.h;
    }
    if (!stale && n === restingCount) return;
    resting.clear();
    for (const c of loose) {
      c.resting = !moving(c);
      if (!c.resting) continue;
      pushCar(resting, c);
      c.restAt = [c.x, c.y, c.h];
    }
    restingCount = n;
    restingStale = false;
  };
  let spawnT = 0;

  // One step of everything that moves (several per frame while a tram ride is sped up).
  let jolt = 0; // the hardest hit your own vehicle took this step
  const simulate = (dt, ctl) => {
    jolt = 0;
    clock.advance(dt);
    if (frozen > 0) {
      frozen -= dt;
      Object.assign(ctl, { move: 0, turn: 0, aim: null, run: false, brake: true });
    }
    assisted = false;
    if (inCar) {
      let steer = ctl.aim ? steerToward(inCar, ctl.aim.h, ctl.move) : ctl.turn;
      if (ctl.run) {
        const a = assist.steer(inCar, steer);
        if (a !== null) { steer = a; assisted = true; }
      } else assist.reset();
      // Keeping to the lane, you keep to the speed limit too.
      const cap = assisted ? assist.limit / 3.6 : null;
      const hit = inCar.update(dt, { throttle: ctl.move, steer, handbrake: ctl.brake, cap }, grid);
      if (hit > 6) shake = Math.min(1.2, shake + hit * 0.04);
      jolt = hit;
    } else if (!inHeli && !ride.on) walker.update(dt, ctl);
    // In the helicopter Space climbs and Shift comes down.
    const heliTurn = inHeli && ctl.aim ? clamp(turnOf(inHeli.h, ctl.aim.h) * 1.2, -1, 1) : ctl.turn;
    for (const c of choppers) c.update(dt, c === inHeli ? { move: ctl.move, turn: heliTurn, up: ctl.brake, down: ctl.run } : null);

    const movers = loose.filter(moving);
    for (const c of movers) c.update(dt, null, grid);
    const me = inCar || inHeli || walker;
    police.update(dt, { x: me.x, y: me.y, vx: me.vx, vy: me.vy, speed: Math.hypot(me.vx, me.vy), car: inCar, air: (!!inHeli && !inHeli.landed) || ride.on, riding: ride.on });
    const cops = police.cars.map((p) => p.car);

    // Everything the traffic, trams and people need to look out for.
    hash.clear();
    for (const a of traffic.agents) pushCar(hash, a.car);
    for (const c of movers) pushCar(hash, c);
    syncResting();
    for (const c of cops) pushCar(hash, c);
    if (inCar) pushCar(hash, inCar);
    else if (!inHeli && !ride.on) hash.add({ x: walker.x, y: walker.y, z: walker.gz, r: 0.5, vx: walker.vx, vy: walker.vy, kind: 'player' });
    for (const p of crowd.people) if (p.state !== 'walk' || p.e.side === 0) hash.add({ x: p.x, y: p.y, z: p.gz, r: 0.4, vx: p.vx, vy: p.vy, kind: 'person' });
    for (const o of police.officers) hash.add({ x: o.x, y: o.y, z: o.gz, r: 0.4, vx: o.vx, vy: o.vy, kind: 'person' });
    const tramBodies = trams.bodies(px(), py(), LIFE_RADIUS + 100);
    for (const t of tramBodies) for (const [x, y] of t.circles) hash.add({ x, y, r: 1.25, vx: t.vx, vy: t.vy, kind: 'tram' });

    traffic.update(dt, obstacles);
    // In view or not, each car keeps track of whether it's on a bridge or under it.
    for (const a of traffic.agents) world.track(a.car);

    // Trams stop for whatever is on the track in front of them; one waiting to move
    // across to the other track at a terminus with no loop does it out of sight.
    trams.update(dt, { near: obstacles, x: px(), y: py(), r: LIFE_RADIUS + 100, seen: (x, y) => !offscreen(x, y) });
    if (ride.on) ride.seat(walker);
    transit.update(dt);

    const threats = [...(inCar ? [inCar] : []), ...movers.filter((c) => c.speed > 5), ...cops.filter((c) => c.speed > 5)];
    crowd.update(dt, threats);

    // ---- Collisions ------------------------------------------------------
    const active = [...(inCar ? [inCar] : []), ...movers, ...cops];
    // A car a tram is pushing off its track, even while it still stands.
    for (const c of trams.shoved()) if (!active.includes(c)) active.push(c);
    const done = new Set();
    for (const a of active) {
      done.add(a);
      const ca = a.circles();
      for (const b of carsNear(a.x, a.y, 8, nearA)) {
        if (b === a || done.has(b) || !near(a, b, 7) || apart(a, b)) continue;
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
            if (a.mode !== 'police') stats.wrecked++;
            if (a === inCar) police.crime(b.type === 'police' ? 'hitCop' : 'wreck', b.x, b.y);
            const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
            if (a === inCar) jolt = Math.max(jolt, hit);
          } else {
            const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 0);
            if (a === inCar) jolt = Math.max(jolt, hit);
            if (a === inCar && b.type === 'police' && (a.vx * (b.x - a.x) + a.vy * (b.y - a.y)) / d > 3) police.crime('hitCop', b.x, b.y);
          }
          continue;
        }
        const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
        if (a === inCar || b === inCar) jolt = Math.max(jolt, hit);
        if (hit > 8) { a.damage += hit - 8; b.damage += hit - 8; }
        if (hit > 6 && (a === inCar || b === inCar)) shake = Math.min(1.2, shake + hit * 0.04);
        // Driving into a police car (not them into you).
        if (a === inCar && b.mode === 'police' && hit > 2) {
          const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          if ((a.vx * (b.x - a.x) + a.vy * (b.y - a.y)) / d > 3) police.crime('hitCop', b.x, b.y);
        }
      }
      for (const t of tramBodies) {
        if (!near(a, t, 22)) continue;
        const hit = collideBodies(t, t.circles, 1.25, 0, a, a.circles(), a.r, 1 / a.mass);
        // Pushing a car off the track: ahead, and to the right, away from the other track.
        if (hit && t.v.shove === a) {
          const ang = t.v.parts[2].ang, rx = Math.sin(ang), ry = -Math.cos(ang);
          const lat = a.vx * rx + a.vy * ry;
          if (lat < SHOVE) { a.vx += rx * (SHOVE - lat); a.vy += ry * (SHOVE - lat); }
        }
        if (hit > 6 && a === inCar) shake = Math.min(1.2, shake + hit * 0.04);
        if (a === inCar) jolt = Math.max(jolt, hit);
      }
    }
    if (inCar?.two && jolt > 7) throwOff();

    // People and cars
    const bump = (who, rad, onHit) => {
      for (const c of carsNear(who.x, who.y, 5, nearB)) {
        if (!near(who, c, 4) || apart(who, c)) continue;
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
          if (c === inCar) police.crime('knock', p.x, p.y);
        }
      });
    }
    for (const o of police.officers) {
      bump(o, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && o.down <= 0) {
          police.knock(o, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
          if (c === inCar) police.crime('hitCop', o.x, o.y);
        }
      });
    }
    if (!inCar && !inHeli && !ride.on) {
      bump(walker, 0.35, (c, nx, ny) => {
        if (c.speed > 4 && walker.down <= 0 && !walker.airborne) { walker.knock(c.vx + nx * 2, c.vy + ny * 2); shake = 0.6; }
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
      parkTwoWheelers(true);
    }
    // New traffic out of sight, a few times a second rather than every step (finding
    // the streets around you and a spot on them takes a while).
    spawnT -= dt;
    if (spawnT < 0 && traffic.agents.length < TRAFFIC) {
      spawnT = 0.25;
      const edges = edgesNear(px(), py(), LIFE_RADIUS), ok = lifeSpots(px(), py(), 40);
      for (let n = 0; n < 10 && traffic.agents.length < TRAFFIC; n++) if (!traffic.spawn((x, y) => offscreen(x, y) && ok(x, y), edges)) break;
    }
  };

  // Every kind of ground's shader, compiled before the game starts.
  {
    const samples = groundSamples(time);
    scene.add(samples.group);
    await renderer.compileAsync(scene, camera).catch((e) => console.warn(e));
    scene.remove(samples.group);
    samples.dispose();
  }
  $('loading').classList.add('done');

  // Resolution: the screen's pixel ratio (up to 2) while frames keep up. Where they
  // take too long, mostly the ground's patterns on a big high-density screen, it comes
  // down a step at a time, and back up once there's time to spare, but not to a step
  // it had to leave again soon after.
  const resolution = { ratio: maxRatio, ceiling: maxRatio, frame: 16.7, slow: 0, quick: 0, raised: -Infinity };
  const adapt = (ms, now) => {
    // (A frame over a quarter of a second is a pause, such as coming back to the tab.)
    if (params.get('dpr') || ms > 250) return;
    const r = resolution;
    r.frame += (Math.min(ms, 100) - r.frame) * 0.05;
    r.slow = r.frame > 25 ? r.slow + Math.min(ms, 100) : 0;
    r.quick = r.frame < 18 ? r.quick + ms : 0;
    let next = r.ratio;
    if (r.slow > 2000 && r.ratio > 1) {
      if (now - r.raised < 10000) r.ceiling = r.ratio - 0.25;
      next = Math.max(1, r.ratio - 0.25);
    } else if (r.quick > 8000 && r.ratio < r.ceiling) {
      next = Math.min(r.ceiling, r.ratio + 0.25);
      r.raised = now;
    }
    if (next === r.ratio) return;
    r.ratio = next;
    r.slow = r.quick = 0;
    renderer.setPixelRatio(next);
  };

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    adapt(now - last, now);
    last = now;
    time.value += dt;
    world.update(camPos.x, -camPos.z, viewRadius() + 220);

    // Player: keyboard and touch controls together. In the car, Shift is lane assist:
    // it steers along your lane, and A/D picks the turn at the next junction instead.
    const ctl = {
      move: touch.move || (input.up ? 1 : 0) - (input.down ? 1 : 0),
      turn: touch.turn || (input.left ? 1 : 0) - (input.right ? 1 : 0),
      run: input.run || touch.run,
      brake: input.brake || touch.brake,
      jump: input.jump,
      aim: touch.aim,
    };
    // On a tram, Shift speeds up the ride: the whole world runs faster, in steps short
    // enough for the physics.
    // At a tram stop, hold Space to wait: the same speed-up, until a tram is close.
    board.update(dt, walker.x, walker.y, !ride.on && !inCar && !inHeli);
    const waiting = !!board.shown && (input.brake || touch.fast) && board.next > 40;
    waitScale += ((waiting ? FAST : 1) - waitScale) * Math.min(1, dt * (waiting ? 1.5 : 4));
    if (Math.abs(waitScale - (waiting ? FAST : 1)) < 0.02) waitScale = waiting ? FAST : 1;
    const scale = ride.on ? ride.speedUp(dt, ctl.run || touch.fast) : waitScale;
    const steps = metro.active ? 0 : Math.ceil(scale - 1e-6); // underground, the street waits
    for (let i = 0; i < steps; i++) simulate((dt * scale) / steps, ctl);
    input.jump = false;
    if (ride.on) ride.watch(dt);
    if (ride.on && ride.arrived()) getOff();
    trams.sync(camPos.x, -camPos.z, viewRadius() + 150, ground);
    metro.update(dt);
    metro.sync(camPos.x, -camPos.z, viewRadius() + 60, ground);
    crowd.render(ground);
    police.render(ground, time.value);
    // Only the cars in view (and a little round it, for their shadows) are drawn.
    drawn.length = 0;
    {
      const cx = camPos.x, cy = -camPos.z, r = viewRadius() + 12;
      const see = (c) => {
        if (Math.abs(c.x - cx) < r && Math.abs(c.y - cy) < r) drawn.push(c);
        else c.lastH = undefined; // so a bike coming back into view doesn't lean at once
      };
      if (inCar) drawn.push(inCar);
      loose.forEach(see);
      for (const a of traffic.agents) see(a.car);
      for (const p of police.cars) see(p.car);
    }
    carPool.render(drawn, ground, dt);
    for (const c of choppers) c.render(dt);

    // ---- Camera ----------------------------------------------------------
    const vehicle = inCar || inHeli, sp = vehicle ? vehicle.speed : 0;
    // In the air the camera rises with the helicopter, so it stays well above it.
    const want = (inHeli ? 130 + sp * 2.5 : inCar ? 120 + sp * 3.4 : ride.on ? 125 + (scale - 1) * 12 : 100) * zoom + (inHeli ? inHeli.air : 0);
    height += (want - height) * Math.min(1, dt * (want > height ? 1.6 : 0.9));
    const lead = vehicle ? 0.7 : ride.on ? 0.5 : 0.3;
    look.set(px() + (vehicle || walker).vx * lead, 0, -(py() + (vehicle || walker).vy * lead));
    camPos.lerp(look, Math.min(1, dt * 4));
    shake *= Math.exp(-6 * dt);
    const jx = (Math.random() - 0.5) * shake * 2, jz = (Math.random() - 0.5) * shake * 2;
    // Follow the ground under the view, smoothed so the camera doesn't bob over kerbs.
    const body = inHeli ? null : inCar || walker;
    camGround += (ground(camPos.x, -camPos.z, body) - camGround) * Math.min(1, dt * 3);
    camera.position.set(camPos.x + jx, camGround + height, camPos.z + jz);
    camera.lookAt(camPos.x + jx, camGround, camPos.z + jz);

    // In a passage under a building, open a hole in the floors above so you stay in view.
    // The same under a bridge deck.
    const under = !inHeli && (world.passageAt(px(), py()) || (world.track(body) === 0 && world.deckAbove(px(), py())));
    cutR += ((under ? 9 : 0) - cutR) * Math.min(1, dt * 6);
    CUTAWAY.value.set(px(), ground(px(), py(), body) + 2.5, -py(), cutR > 0.3 ? cutR : 0);

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
      // (Not while a sped-up ride flicks through the streets.)
      if ((!$('banner').classList.contains('alert') || bannerT < 0) && scale < 1.5) showBanner(name);
    }
    bannerT -= dt;
    show('banner', clamp(bannerT, 0, 1), 'opacity');
    show('speed', String(inCar ? Math.round(Math.abs(inCar.forwardSpeed) * 3.6) : inHeli ? Math.round(inHeli.speed * 3.6)
      : ride.on ? Math.round(ride.v.speed * 3.6) : '–'));
    if (clock.label() !== clockShown) $('clock').textContent = clockShown = clock.label();
    // On a touch screen the buttons say what they do, so the hint only reports lane assist.
    const canBoard = !inCar && !inHeli && !ride.on && ride.boardable(walker.x, walker.y);
    const station = !inCar && !inHeli && !ride.on && !metro.active ? metro.near(walker.x, walker.y) : null;
    const gap = (c) => Math.hypot(c.x - walker.x, c.y - walker.y) - c.spec.L / 2;
    const enterable = !inCar && !inHeli && !ride.on && [...carsNear(walker.x, walker.y, 5)].filter((c) => gap(c) < 1.8).sort((a, b) => gap(a) - gap(b))[0];
    const canEnter = !inCar && !inHeli && !ride.on && (!!enterable || choppers.some((c) => c.landed && Math.hypot(c.x - walker.x, c.y - walker.y) < 4));
    const getIn = enterable?.two ? '<b>E</b> get on' : '<b>E</b> get in';
    const key = (k) => (touch.active ? '' : `<b>${k}</b> `);
    let hint = '';
    if (inHeli) {
      const up = `${Math.round(inHeli.air)} m up`;
      if (touch.active) hint = inHeli.landed ? '' : up;
      else hint = inHeli.landed ? '<b>Space</b> take off · <b>E</b> get out' : `${up} · <b>Space</b> climb · <b>Shift</b> down · land to get out`;
    } else if (inCar) {
      if (!assisted) hint = touch.active ? '' : `<b>E</b> get ${inCar.two ? 'off' : 'out'} · <b>Shift</b> lane assist`;
      else hint = `${key('Shift')}Lane assist, keeping to ${assist.limit} km/h${touch.active ? '' : ' (let go to drive faster)'} · ${assist.intent > 0 ? 'turning left at the next junction' : assist.intent < 0 ? 'turning right at the next junction' : `straight on (${touch.active ? 'point the stick' : 'A/D'} to turn)`}`;
    }
    else if (ride.on) {
      const halts = ride.v.line.halts, dest = ride.dest !== null ? halts[ride.dest].name : null;
      const next = ride.dest !== null && ride.dest === ride.upcoming()[0];
      const parts = [];
      if (ride.waiting) parts.push('The streets ahead are still loading');
      else if (scale > 1.5) parts.push(`${Math.round(scale)}× speed`);
      if (dest) parts.push(next ? `Getting off at ${dest}` : `Riding to ${dest}`);
      if (!touch.active) {
        if (ride.atStop()) parts.push('<b>E</b> get off');
        else if (ride.stuck) parts.push('<b>E</b> get off here');
        else if (!next) parts.push('<b>E</b> get off at the next stop');
        if (!dest) parts.push('<b>W</b>/<b>S</b> pick a stop', 'hold <b>Shift</b> to speed up');
      }
      hint = parts.join(' · ');
    } else if (canBoard && !touch.active) hint = `<b>E</b> get on the ${canBoard.line.ref} to ${ride.headsign(canBoard)}`;
    else if (station && !touch.active) hint = `<b>E</b> take the metro from ${station.name}`;
    else if (board.shown) {
      const wait = waitScale > 1.5 ? `Waiting for a tram · ${Math.round(waitScale)}× speed` : touch.active ? '' : 'Hold <b>Space</b> to wait for a tram';
      hint = [canEnter && !touch.active ? getIn : '', wait].filter(Boolean).join(' · ');
    } else if (canEnter && !touch.active) hint = getIn;
    show('hint', hint, 'html');
    $('help').dataset.mode = inHeli ? 'heli' : inCar ? 'car' : ride.on ? 'tram' : 'foot';
    ride.render();
    const label = ride.on ? (ride.atStop() ? 'Get off' : ride.stuck ? 'Get off here' : ride.dest === ride.upcoming()[0] ? 'Stop requested' : 'Request stop') : canBoard || enterable?.two ? 'Get on' : inCar?.two ? 'Get off' : null;
    touch.update({ car: inCar || inHeli, tram: ride.on, wait: !!board.shown, label: label || (station ? 'Metro' : null), canEnter: canEnter || !!canBoard || !!station, limit: assisted ? assist.limit : null });
    show('tally', `${stats.wrecked} cars wrecked · ${stats.knocked} people knocked over${stats.busted ? ` · busted ${stats.busted}×` : ''}`);
    // Wanted stars: they blink while the police have lost sight of you.
    const stars = police.stars, wanted = $('wanted');
    const face = `${stars}|${stars && !police.seen}`;
    if (wanted.dataset.face !== face) {
      wanted.dataset.face = face;
      wanted.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span${i <= stars ? ' class="on"' : ''}>★</span>`).join('');
      wanted.classList.toggle('hidden', stars === 0);
      wanted.classList.toggle('blink', stars > 0 && !police.seen);
      wanted.setAttribute('aria-label', stars ? `Wanted: ${stars} of 5 stars` : 'Not wanted');
    }

    dev.update();
    renderer.render(scene, camera);
  });

  window.__drive = {
    scene, camera, traffic, crowd, loose, drive, walk, grid, walker, stats, world, renderer, police, trams, ride, clock, board, metro, resolution,
    get car() { return inCar; },
    get heli() { return inHeli; },
    choppers, addChopper,
    teleport: (x, y) => { (inCar || inHeli || walker).x = x; (inCar || inHeli || walker).y = y; camPos.set(x, 0, -y); },
    enterOrExit, teleportTo, dev, touch,
    view: (z) => { zoom = z; height = (inCar ? 120 : 100) * z; },
  };
}

// The touch stick in a car points where you want to go on screen, as it does on foot:
// steer towards that heading, harder the further off it is. Reversing (or about to,
// with the brake held at a standstill), the back of the car is what follows the stick.
let lastOff = 0;
function steerToward(car, h, throttle) {
  const v = car.forwardSpeed;
  const back = v < -0.3 || (throttle < 0 && v < 0.5);
  let off = turnOf(car.h + (back ? Math.PI : 0), h);
  // Pointing straight behind: keep turning the way you started, not flip-flop.
  if (Math.abs(off) > 2.6 && lastOff && Math.sign(off) !== Math.sign(lastOff)) off = -off;
  lastOff = off;
  return clamp(off * 1.6, -1, 1) * (back ? -1 : 1);
}

function touching(ca, cb, rr) {
  for (const p of ca) for (const q of cb) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < rr) return true;
  return false;
}

main().catch((e) => {
  console.error(e);
  status(`Something went wrong: ${e.message}`);
});
