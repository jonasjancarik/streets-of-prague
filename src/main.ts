import { DATA_FORMAT, dataUrl, mapData } from './data.ts';
import { STATIONS } from './radio.ts';
import { stationAllowed, onRadioPreferencesChange } from './radio-preferences.ts';
import * as THREE from 'three';
import proj4 from 'proj4';
import { Funicular } from './funicular.ts';
import { parseBusLines } from './buses.ts';
import { DriveGraph, WalkGraph, StreetNames, SpatialHash, clamp } from './network.ts';
import { Car, TYPES, CarPool, collideBodies, contact, loadCars, ordinaryCarBodies, useKit, variantName } from './car.ts';
import { RestingCars } from './restingCars.ts';
import { loadKit } from './figures.ts';
import { Traffic, trafficWanted } from './traffic.ts';
import { preparePeople, pickPerson } from './spawn.ts';
import { PavementDrivers } from './pavement.ts';
import { Bags } from './bags.ts';
import { Crowd, Walker, nearestWalkable } from './people.ts';
import type { Pedestrian } from './people.ts';
import { GetIn } from './getin.ts';
import { Arrest } from './arrest.ts';
import { loadFootfall } from './footfall.ts';
import { Trams, loadTrams, pushOutOfTram } from './trams.ts';
import { TramRide, FAST } from './ride.ts';
import { TrackNet } from './tracks.ts';
import { Passengers } from './passengers.ts';
import { Taxis } from './taxi.ts';
import { Clock } from './clock.ts';
import { Sky } from './sky.ts';
import { Weather, WeatherFx, KINDS, automaticWeather, LIVE_EVERY } from './weather.ts';
import { MIST_MODE } from './localmist.ts';
import type { Kind } from './weather.ts';
import { Lamps, type Flashing } from './lamps.ts';
import { Signals } from './signals.ts';
import { Skids } from './skids.ts';
import { SteerGuide, aimSteer, type Held } from './steerGuide.ts';
import { Spray } from './spray.ts';
import { Water } from './water.ts';
import { Beacons } from './beacons.ts';
import { Cannon, TANK, HOSE } from './cannon.ts';
import { Graphics } from './graphics.ts';
import { createGameRenderer } from './renderer.ts';
import { StopBoard } from './board.ts';
import { Metro } from './metro.ts';
import { TramStops } from './tramstops.ts';
import { Districts } from './districts.ts';
import { TileWorld } from './tiles.ts';
import { loadFacadeAtlas } from './facades.ts';
import { groundSamples } from './surface.ts';
import { CUTAWAY, DIG } from './shading.ts';
import { setupDev } from './dev.ts';
import { setupSettings } from './settings.ts';
import { setScreenshot } from './feedback.ts';
import { readSave, writeSave, clearSave, listSaves, newSlot, unreadable, describe } from './save.ts';
import type { Slot, SaveData } from './save.ts';
import { dressLoading, Dialog } from './portraits.ts';
import { startScreen } from './startscreen.ts';
import { liveWeather } from './liveweather.ts';
import { Season, parseDay } from './season.ts';
import { LaneAssist, turnOf, project } from './assist.ts';
import { Sound, surfaceOf } from './audio.ts';
import type { Surface, HornKind } from './audio.ts';
import { setupTouch } from './touch.ts';
import { setupGamepad, padLabels, usingPad } from './gamepad.ts';
import './credits.ts';
import { Police } from './police.ts';
import type { Officer } from './police.ts';
import { Brigade } from './brigade.ts';
import { Ambulances } from './ambulance.ts';
import { Tracers, Health, MAX_HEALTH } from './guns.ts';
import { Fires } from './fire.ts';
import { Chopper } from './helicopter.ts';
import { Boats } from './boats.ts';
import { isMapIndex } from './contracts.ts';
import type { MapIndex } from './contracts.ts';
import type { RawTramLine } from './trams.ts';
import type { MetroLine } from './metro.ts';
import { BikeShare } from './bikeshare.ts';
import { rentalCost } from './pricing.ts';
import { Wallet, PidRide, TICKET, TICKETS, validity, FINE, CHECK_STOP, CHECK_METRO, kc } from './money.ts';
import { Inspector } from './inspector.ts';
import type { DriveEdge, WalkEdge } from './network.ts';
import type { Point2 } from './map/geo.ts';
import type { Tracked } from './tiles.ts';
import { getLang, onLang, t, tn, translatePage } from './i18n.ts';
const VEHICLE_NAMES: Record<string, string> = {
  van: 'Van', taxi: 'Taxi', police: 'Police car', bike: 'Bicycle', moto: 'Motorbike',
  truck: 'Lorry', artic: 'Articulated lorry', bus: 'Bus', minibus: 'Minibus', fire: 'Fire engine',
};
import { haptic, hapticCrash, hapticBlast } from './haptics.ts';
import { tunnelHole } from './tunnelView.ts';
import { setupTestkit, PLACES } from './testkit.ts';
import * as telemetry from './telemetry.ts';
import { benchPause } from './benchpause.ts';
import type { Testkit } from './testkit.ts';

interface Obstacle { x: number; y: number; z?: number; r: number; vx: number; vy: number; kind: string; car?: Car }
type InputKey = 'up' | 'down' | 'left' | 'right' | 'run' | 'brake' | 'jump';
interface Controls { move: number; turn: number; run: boolean; brake: boolean; jump: boolean; aim: { h: number; mag: number } | null }

declare global { interface Window { __drive?: unknown; __test?: Testkit } }

const params = new URLSearchParams(location.search);
const AREA = params.get('area') || 'praha';
// The dashes showing where the stick will take the car (src/steerGuide.ts); ?guide=off hides them.
const guideOn = params.get('guide') !== 'off';
// Where a new game can begin: lon, lat of a spot on a street with room for a car at the kerb.
const STARTS: [string, number, number][] = [
  ['Újezd', 14.40455, 50.08105],
  ['Malostranské náměstí', 14.4030, 50.0883],
  ['Pařížská', 14.4196, 50.0886],
  ['Masarykovo nábřeží', 14.4139, 50.0779],
  ['Václavské náměstí', 14.4283, 50.0803],
  ['Karlovo náměstí', 14.4185, 50.0760],
  ['Náměstí Míru', 14.4378, 50.0754],
  ['Anděl', 14.4036, 50.0712],
  ['Letenské náměstí', 14.4250, 50.0998],
  ['Náměstí Jiřího z Poděbrad', 14.4486, 50.0776],
];
const wallet = new Wallet(params);
const pid = new PidRide(wallet);
const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing interface element: ${id}`);
  return el;
};
let statusText = '';
const status = (text: string) => { statusText = text; $('loading-text').textContent = text ? t(text) : ''; };

// Parts of the game load on demand under names that change with every release, so a
// page opened just as a new version goes online asks for files that are gone. Reload
// once to pick up the new version; the time kept in sessionStorage stops a real outage
// from reloading over and over.
let reloading = false, outdated = false;
window.addEventListener('vite:preloadError', () => {
  outdated = true;
  let last = 0;
  try {
    last = Number(sessionStorage.getItem('reloaded-for-update'));
    sessionStorage.setItem('reloaded-for-update', String(Date.now()));
  } catch { return; } // no storage to remember the reload in, so don't risk a loop
  if (Date.now() - last < 60_000) return;
  reloading = true;
  location.reload();
});

const BUSES = 3; // of the traffic, on the main roads
const PEOPLE = 1200; // at most, round the Old Town Square; fewer where it's quieter (src/footfall.ts)
const FEW_PEOPLE = 40; // on the quietest edge of town
const CROWD = 1; // people a metre of footpath that draws people fully (Footfall.pull)
const PARKED_TWO = 10; // bikes and motorbikes parked around you
const SHOVE = 1.2; // m/s a tram pushes a car aside, off its track
const LIFE_RADIUS = 330; // traffic and people are kept within this distance of the player

async function main() {
  dressLoading($('loading'));
  translatePage();
  await benchPause.clear();
  // The pad works from the start screen on; what it does in the game is hooked up further down.
  const padHooks = { settings: () => {}, menu: () => false, zoomBy: (_factor: number) => {} };
  const pad = setupGamepad({ settings: () => padHooks.settings(), menu: () => padHooks.menu(), zoomBy: (f) => padHooks.zoomBy(f) });
  onLang(() => status(statusText));
  // Rolled now, so the start screen can say what the game will begin with.
  const clock = new Clock(params);
  const season = new Season(params);
  const weather = new Weather(params, clock.t, season);
  let savedSound = '';
  try { savedSound = localStorage.getItem('sound') ?? ''; } catch {}
  // The game saved by itself last time, unless it's a test run (?go).
  const saved = params.has('go') ? null : readSave('auto', AREA);
  const start = params.has('go') ? null : startScreen($('loading'), { now: Clock.nowLabel(), season: season.day, dateLinked: parseDay(params.get('date')) !== null || parseDay(params.get('season')) !== null, weather: weather.kind, weatherFixed: weather.fixed,
    weatherForSeason: (day) => { const preview = new Season(params); preview.set(day); return weather.preview(clock.t, preview); },
    sound: savedSound !== 'off', saved: saved && (() => describe(saved)), savedLook: saved ? { clock: saved.clock, weather: saved.weather.fixed ? saved.weather.kind : automaticWeather(saved.weather.kind), season: saved.season } : undefined, lost: !saved && !params.has('go') && unreadable('auto', AREA) });
  // The weather in Prague now, for the start screen (the URL's ?weather wins).
  if (start && !params.has('weather')) void liveWeather().then((k) => { if (k) start.live(k); });
  // ?menu stops here, at the start screen with nothing loaded under it, for working on
  // the screen and on what opens from it. The button shows the beta note every time.
  if (start && params.has('menu')) {
    status('');
    for (;;) await start.ready(true);
  }
  status('Loading the map…');
  const kitLoad = loadKit();
  const carsLoad = loadCars();
  const tramsLoad = loadTrams();
  const footfallLoad = loadFootfall(AREA);
  const indexValue: unknown = await fetch(dataUrl(AREA, 'index.json')).then((r) => {
    if (!r.ok) throw new Error(`Map index could not be loaded (${r.status})`);
    return r.json();
  });
  if (!isMapIndex(indexValue)) throw new Error('The map index has invalid data');
  const index: MapIndex = indexValue;
  // The map and the game are made for each other (DATA_FORMAT): stop here rather than
  // misread the tiles.
  const format = index.format ?? 1;
  if (format > DATA_FORMAT) throw new Error('The map is newer than this version of the game. Reload the page to get the latest version.');
  if (format < DATA_FORMAT) throw new Error('This version of the game needs a newer map, which isn\'t available yet. Please try again later.');
  mapData.built = index.built ?? '';
  // Tram lines (pipeline/build_lines.py); without them there are no trams.
  const lines: Promise<{ lines: RawTramLine[] }> = fetch(dataUrl(AREA, 'lines.json'))
    .then(async (r) => r.ok ? parseTramLines(await r.json()) : { lines: [] })
    .catch(() => ({ lines: [] }));
  // Bus lines (pipeline/build_buses.py); without them buses wander the main roads.
  const busLines = fetch(dataUrl(AREA, 'buses.json'))
    .then(async (r) => r.ok ? parseBusLines(await r.json()) : [])
    .catch(() => []);
  // The metro (pipeline/build_metro.py); without it there are no entrances.
  const metroData: Promise<{ lines: MetroLine[] }> = fetch(dataUrl(AREA, 'metro.json'))
    .then(async (r) => r.ok ? parseMetroLines(await r.json()) : { lines: [] })
    .catch(() => ({ lines: [] }));
  const seeded = (() => { let s = 11; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

  // (Its pixel ratio comes from the graphics setting, see Graphics. The stencil is for
  // shading each pixel of the ground once, see surface.ts.)
  // (three.js's WebGPURenderer, see webgpu.ts. The old WebGLRenderer is no longer kept up to
  // date: it is for ?renderer=webgl and for browsers with no WebGPU.)
  status('Preparing graphics…');
  const renderer = await createGameRenderer(params);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Asking the driver whether each shader compiled stalls the frame it's first used in;
  // only the developer panel's ?dev needs the errors.
  renderer.debug.checkShaderErrors = params.has('dev');
  $('app').appendChild(renderer.domElement);
  // The graphics card giving up mid-game, for the statistics (src/telemetry.ts).
  const gpuBackend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; device?: { lost?: Promise<{ reason?: string; message?: string }> } } }).backend;
  void gpuBackend?.device?.lost?.then((info) => telemetry.error('graphics lost', info.message || info.reason || 'WebGPU device lost'));
  renderer.domElement.addEventListener('webglcontextlost', () => telemetry.error('graphics lost', 'WebGL context lost'));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#2a2622');
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 1, 6000);
  camera.up.set(0, 0, -1);

  // The sun and the sky's light follow the clock (see Sky).
  const sky = new Sky(scene, renderer);
  const sun = sky.sun;
  // How sharp the picture is and whether the costlier looks are on; Auto adapts.
  const graphics = new Graphics(renderer, sky, params);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.4;

  // The street graphs grow as tiles load (each tile carries the edges that touch it).
  const drive = new DriveGraph();
  const walk = new WalkGraph();
  const names = new StreetNames(drive.edges, walk.edges);
  // The part of town you're in, as a title when it changes (pipeline/build_districts.py).
  const districts = new Districts(AREA, $('district'));
  const time = { value: 0 };
  // People and two-wheelers (parked motorbikes come with the tiles, so load it first).
  status('Loading people and vehicles…');
  const kit = await kitLoad;
  useKit(kit);
  await carsLoad;
  await tramsLoad;
  if (params.get('mist') === 'volume') MIST_MODE.value = 'volume';
  const weatherFx = new WeatherFx(scene);
  const world = new TileWorld({ area: AREA, index, scene, drive, walk, time, night: params.has('night') || clock.night, osmBuildings: params.has('osm'), ortho: params.has('ortho'), countryside: params.has('countryside') });
  const grid = world.grid;
  // Height of the ground at a point; with `who` (a car, a person), of whatever they're
  // on there: the ground, or a bridge deck (see TileWorld.track).
  const ground = (x: number, y: number, who?: Tracked | null) => (who ? world.groundFor(who, x, y) : world.heightAt(x, y));
  const mistGround = (x: number, z: number) => world.terrainAt(x, -z);
  const mistWater = (x: number, z: number) => world.waterAt(x, -z) ? world.terrainAt(x, -z, true) : null;
  let crowd: Crowd | null = null;
  // The deck of a bridge at a point, or within a few metres of it (a lamp on the parapet is just off it).
  const deckAt = (x: number, y: number, within: number) => {
    for (let r = 0; r <= within; r += 2) {
      for (let a = 0; a < (r ? 8 : 1); a++) {
        const b = world.lowestBridge(x + Math.cos(a * Math.PI / 4) * r, y + Math.sin(a * Math.PI / 4) * r);
        if (b) return b.h;
      }
    }
    return null;
  };
  const lamps = new Lamps(scene, renderer, AREA, (x, y) => world.terrainAt(x, y), deckAt);
  const signals = new Signals(scene, AREA, () => clock.t, (x, y, bridge) => (bridge ? world.heightAt(x, y) : world.terrainAt(x, y)), (x, y) => world.onRoad(x, y));
  world.onEdges = (d, w, b, first) => { names.add(d); names.add(w); crowd?.index(w); if (first) lamps.fill(d, b); signals.add(d); };

  // Parked cars come and go with their tiles; wrecks and abandoned cars are loose too.
  const loose: Car[] = [];
  const tileCars = new Set<Car>();
  const standing = new Map<Car, number>(); // loose wrecks and left cars out of sight: seconds so far
  const TOW_AFTER = 60; // s
  let restingStale = true; // see syncResting
  world.onCars = (cars) => { for (const c of cars) { loose.push(c); tileCars.add(c); } restingStale = true; };
  world.onDrop = (tile) => {
    const gone = new Set(tile.cars.filter((c) => c.mode === 'loose'));
    for (let i = loose.length - 1; i >= 0; i--) if (gone.has(loose[i])) { tileCars.delete(loose[i]); loose.splice(i, 1); }
    restingStale = true;
  };

  // A new game begins at one of STARTS, picked at random (or at ?start=lon,lat, or
  // ?place= one of the test places in testkit.ts); in the middle if none is in the area.
  const [w0, s0, e0, n0] = index.bbox_wgs84, lon0 = (w0 + e0) / 2, lat0 = (s0 + n0) / 2;
  const inside = (lon: number, lat: number) => lon > w0 && lon < e0 && lat > s0 && lat < n0;
  const named = PLACES[params.get('place') ?? ''];
  const starts = STARTS.filter(([, lon, lat]) => inside(lon, lat));
  const random = starts.length ? starts[Math.floor(Math.random() * starts.length)] : null;
  const [slon, slat] = named ? [named.at[1], named.at[0]] : params.get('start')?.split(',').map(Number) ?? (random ? [random[1], random[2]] : [lon0, lat0]);
  // The pipeline's local metres: a transverse Mercator centred on the area.
  const [sx, sy] = inside(slon, slat)
    ? proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, [slon, slat])
    : [0, 0];
  status('Building the streets…');
  // (The view at the start is about 85 m across; what's beyond is loaded but not yet drawn.)
  await world.loadNow(sx, sy, 380, 85 + world.drawBeyond);
  // You stand at the spot on a street nearest to that point (a named street, if one is close).
  let startEdge = drive.edges[0], startS = 0, startD = Infinity;
  for (const e of drive.edges) {
    for (let d = 0; d <= e.path.length; d += 3) {
      const p = e.path.at(d), far = Math.hypot(p.x - sx, p.y - sy) + (e.name ? 0 : 60);
      if (far < startD) { startEdge = e; startS = d; startD = far; }
    }
  }
  const q = startEdge.path.at(startS);

  // Up Petřín and down again (E at a station).
  const funicular = new Funicular(index.rails, scene, {
    clock,
    terrain: (x, y) => (world.loaded.has(world.keyAt(x, y)) ? world.terrainAt(x, y) : null),
    toLocal: (lon, lat) => (lon > w0 && lon < e0 && lat > s0 && lat < n0 ? proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, [lon, lat]) as [number, number] : null),
  });
  const tramLines = (await lines).lines;
  const trams = new Trams(tramLines, scene, { clock, rng: seeded });
  const ride = new TramRide(trams, world, $('ride'), new TrackNet(tramLines));
  const board = new StopBoard(trams, $('board'));
  const tramStops = new TramStops(trams, scene);
  // Down into the metro and up again at the station you picked (the police lose you).
  const metro = new Metro(await metroData, scene, $('metro'), {
    clock,
    inMap: (x, y) => world.available.has(world.keyAt(x, y)),
    ready: (x, y) => { const k = world.keyAt(x, y); return !world.available.has(k) || world.loaded.has(k); },
    terrain: (x, y) => world.terrainAt(x, y),
    standAt: (x, y) => nearestWalkable(grid, x, y, 30),
    onArrive: async (x, y, name) => {
      await teleportTo(x, y);
      police.forgive();
      police.seen = false;
      telemetry.did('travelled by metro');
      walker.mesh.visible = true;
      showBanner(name);
      if (metro.dodging && Math.random() < CHECK_METRO) inspector.start('street', walker.x, walker.y);
      metro.dodging = false;
    },
    onStation: (name) => showBanner(name),
    fares: { valid: () => wallet.hasTicket(clock.t), afford: (k) => wallet.has(k.price), buy: (k) => wallet.buyTicket(clock.t, k) },
  });
  const footfall = await footfallLoad;
  crowd = new Crowd(walk, grid, scene, seeded, PEOPLE, kit);
  crowd.footfall = footfall;
  ride.passengers = new Passengers(trams, () => crowd, seeded);
  const traffic = new Traffic(drive, scene, seeded, trafficWanted(clock.t));
  traffic.signals = signals;
  traffic.busLines = await busLines;
  const pavementDrivers = new PavementDrivers(traffic, seeded);
  const carPool = new CarPool(scene);
  const skids = new Skids(scene);
  const steerGuide = new SteerGuide(scene);
  let held: Held | null = null; // the heading the stick asks of your car, for the guide
  const spray = new Spray(scene, weatherFx.tint);
  const water = new Water(scene, weatherFx.tint);
  const beacons = new Beacons(scene);
  // The emergency vehicles with their lights going, and what the lamps need each frame
  // besides the cars (the people in view stand in their light too).
  const flashing: Flashing[] = [];
  const lightOpt: Parameters<Lamps['update']>[8] & object = {
    flashing, eye: camera.position,
    blocks: (put) => {
      const person = (p: { x: number; y: number; h: number; gz?: number; state?: string; down?: number }) => {
        if (offscreen(p.x, p.y)) return;
        const lying = p.state === 'down' || (p.down ?? 0) > 0;
        put(p.x, p.y, p.h, lying ? 0.8 : 0.22, 0.25, p.gz ?? ground(p.x, p.y), lying ? 0.3 : 1.75);
      };
      crowd.people.forEach(person);
      police.officers.forEach(person);
      brigade.crew.forEach(person);
      if (!inCar && !inHeli && !ride.on && !taxi.riding) person(walker);
    },
  };
  const cannon = new Cannon();
  let cannonHeld = false;
  // Boats on the river; the pedal boats round Slovanský ostrov, if it's in the area.
  const [ilon, ilat] = [14.4135, 50.0787];
  const islands = ilon > w0 && ilon < e0 && ilat > s0 && ilat < n0
    ? proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, [ilon, ilat]) as [number, number]
    : null;
  const boats = new Boats(scene, world, islands);

  // ---- Player ------------------------------------------------------------
  const walker = new Walker(grid, kit);
  scene.add(walker.mesh);
  // A courier's bag you've picked up rides on your back.
  const bags = new Bags(scene, (x, y) => ground(x, y));
  walker.mesh.add(bags.back);
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
  let inCar: Car | null = null, inHeli: Chopper | null = null;
  const choppers: Chopper[] = []; // helicopters you can fly (from the developer tools)
  let height = 100;
  let heightWanted = height; // where the camera is heading (zooming out, speeding up)
  const camPos = new THREE.Vector3(walker.x, 0, -walker.y);
  let camGround = ground(walker.x, walker.y, walker);
  let cutR = 0; // radius of the hole above a passage, under a bridge or down into a tunnel (see CUTAWAY)

  const viewRadius = (h = height) => h * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.hypot(1, camera.aspect) + 15;
  // The sun's shadow map covers only what is on screen: the view's rectangle from a
  // little below the lowest ground in it to 40 m above the highest (the roofs), as the
  // sun sees it. Its sides follow the screen's, and a low sun no longer spreads it over
  // ground far past the screen's top or bottom. Rounded out to 4 m so small changes
  // don't move it.
  const sunX = new THREE.Vector3(), sunY = new THREE.Vector3(), sunZ = new THREE.Vector3(), corner = new THREE.Vector3();
  const fitShadow = () => {
    const sc = sun.shadow.camera;
    sunZ.copy(sky.offset).normalize();
    sunX.set(1, 0, 0).addScaledVector(sunZ, -sunZ.x).normalize();
    sunY.crossVectors(sunZ, sunX);
    sc.up.copy(sunY); // (three.js aims the shadow camera at the target with this up)
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const hx = height * tan * camera.aspect, hz = height * tan;
    let low = Infinity, high = -Infinity;
    for (const sx of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
      const h = world.terrainAt(camPos.x + sx * hx, -camPos.z - sz * hz) - camGround;
      low = Math.min(low, h); high = Math.max(high, h);
    }
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity;
    for (const dy of [Math.min(0, low) - 5, Math.max(0, high) + 40]) {
      const d = Math.max(0, height - dy);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        corner.set(sx * d * tan * camera.aspect, dy, sz * d * tan);
        const u = corner.dot(sunX), v = corner.dot(sunY);
        l = Math.min(l, u); r = Math.max(r, u); b = Math.min(b, v); t = Math.max(t, v);
      }
    }
    const out = (x: number, dir: number) => (dir < 0 ? Math.floor(x / 4) - 1 : Math.ceil(x / 4) + 1) * 4;
    l = out(l, -1); r = out(r, 1); b = out(b, -1); t = out(t, 1);
    if (sc.left !== l || sc.right !== r || sc.bottom !== b || sc.top !== t || sc.far !== 1400) {
      sc.left = l; sc.right = r; sc.bottom = b; sc.top = t;
      sc.far = 1400;
      sc.updateProjectionMatrix();
    }
  };
  const px = () => (inCar || inHeli || walker).x, py = () => (inCar || inHeli || walker).y;
  const offscreen = (x: number, y: number) => Math.hypot(x - camPos.x, y + camPos.z) > viewRadius();
  const edgesNear = (x: number, y: number, rMax: number) => world.around(x, y, rMax).flatMap((k) => world.driveBy.get(k) || []);
  const walkNear = (x: number, y: number, rMax: number) => world.around(x, y, rMax).flatMap((k) => world.walkBy.get(k) || []);

  const lifeSpots = (x: number, y: number, rMin: number) => (sx: number, sy: number) => {
    const d = Math.hypot(sx - x, sy - y);
    return d > rMin && d < LIFE_RADIUS && world.grid.at(sx, sy) !== 255;
  };
  for (let i = 0; i < BUSES; i++) traffic.buses(lifeSpots(walker.x, walker.y, 25), edgesNear(walker.x, walker.y, LIFE_RADIUS), BUSES);
  const firstTrafficEdges = edgesNear(walker.x, walker.y, LIFE_RADIUS);
  const firstTrafficSampler = traffic.prepareSpawn(firstTrafficEdges);
  for (let i = trafficWanted(clock.t); i > 0; i--) traffic.spawn(lifeSpots(walker.x, walker.y, 25), firstTrafficEdges, null, firstTrafficSampler);
  // How many people are about: CROWD a metre along each footpath around you, times
  // how strongly it draws people, so a busy street adds its own crowd (Karlův most,
  // Anděl) rather than sharing out a fixed number. At most PEOPLE, half on Lowest.
  const peopleWanted = () => {
    let draw = 0;
    for (const e of walkNear(px(), py(), LIFE_RADIUS)) {
      const [x, y] = e.pts[e.pts.length >> 1];
      if (Math.hypot(x - px(), y - py()) < LIFE_RADIUS) draw += e.path.length * footfall.pull(e);
    }
    return Math.min(Math.round(PEOPLE * graphics.crowd), Math.round(FEW_PEOPLE + CROWD * draw));
  };
  const spawnWork = { peoplePasses: 0, peopleWeights: 0, peoplePicks: 0, peoplePrepareMs: 0 };
  // People who wander too far are moved to just outside the view, so they walk into it.
  // Where it's getting quieter some go home, out of sight; where it's getting busier
  // more turn up. `onlyFar` false: everyone at once, anywhere around you.
  const scatterPeople = (onlyFar: boolean) => {
    const edges = walkNear(px(), py(), onlyFar ? Math.min(LIFE_RADIUS, viewRadius() + 90) : LIFE_RADIUS * 0.6);
    if (!edges.length) return;
    const prepareStart = performance.now();
    const sampler = preparePeople(edges, (e) => e.path.length * footfall.pull(e));
    spawnWork.peoplePasses++;
    spawnWork.peopleWeights += edges.length;
    spawnWork.peoplePrepareMs += performance.now() - prepareStart;
    const ok = onlyFar ? offscreen : null, most = onlyFar ? 20 : Infinity, want = peopleWanted();
    for (let k = crowd.people.length - 1, n = 0; k >= 0 && crowd.people.length > want && n < most; k--) {
      const p = crowd.people[k];
      if (p.state === 'walk' && (!onlyFar || offscreen(p.x, p.y))) { crowd.retire(p); n++; }
    }
    for (const p of crowd.people) {
      if (onlyFar && Math.hypot(p.x - px(), p.y - py()) < LIFE_RADIUS) continue;
      spawnWork.peoplePicks++;
      const at = pickPerson(sampler, seeded, ok);
      if (!at) continue;
      Object.assign(p, { ...at, state: 'walk', vx: 0, vy: 0 });
      crowd.place(p);
    }
    for (let n = 0; crowd.people.length < want && n < most; n++) {
      spawnWork.peoplePicks++;
      const at = pickPerson(sampler, seeded, ok);
      if (!at) break;
      crowd.add(at);
    }
  };
  scatterPeople(false);

  // Bikes and motorbikes left on the pavements around you, topped up out of sight as you
  // move (far ones go with the rest of the loose cars).
  const parkTwoWheelers = (onlyOffscreen: boolean) => {
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
  // Shared bikes at their stations (src/bikeshare.ts), stood there as you come near.
  const bikeShare = new BikeShare(AREA);
  const bikeWorld = {
    loose, seeded, walkNear, free: (x: number, y: number) => grid.at(x, y) === 0, loaded: (x: number, y: number) => grid.at(x, y) !== 255,
    onRoad: (x: number, y: number) => world.onRoad(x, y),
    standAt: (x: number, y: number) => nearestWalkable(grid, x, y, 20),
  };

  // Busted: out of the car (the police keep it), and a moment before you can move again.
  const stats = { knocked: 0, wrecked: 0, busted: 0, wasted: 0 };
  let frozen = 0;
  const busted = (by?: Officer) => {
    if (frozen > 0) return;
    getIn.cancel();
    if (inHeli) enterOrExit();
    // Out of a car through its door, an officer's hand on your collar; off a bike at once.
    let car: Car | null = null;
    if (inCar) {
      kept = inCar;
      if (inCar.two) enterOrExit();
      else {
        car = inCar;
        Object.assign(walker, { x: car.x, y: car.y, _tx: car.x, _ty: car.y, level: world.track(car), gz: car.gz });
      }
    }
    inspector.reset();
    let text = t('Busted');
    if (inspector.owed) {
      text = t('Busted · fine for riding without a ticket: {fine}', { fine: kc(wallet.take(inspector.owed, 'fine')) });
      inspector.owed = 0;
    }
    stats.busted++;
    telemetry.did('arrested');
    // Not a jump: the banner comes up as the handcuffs go on, you're walked to the police
    // car, the screen fades out, you're taken to the station, and it fades back in.
    frozen = Infinity;
    arrest.begin(by ?? null, car);
    showBanner(text, true);
  };
  // What you were driving when you were caught: gone when you come out.
  let kept: Car | null = null;
  const arrest = new Arrest({
    walker,
    hold: (on) => { police.arresting = on; },
    leave: (car, at) => leaveCar(car, at),
    fade: (on) => $('fade').classList.toggle('on', on),
    taken: () => {
      // Three stars or more: the prison in Pankrác (if the map reaches that far), else the station in Bartolomějská.
      const inMap = (lon: number, lat: number) => lon > w0 && lon < e0 && lat > s0 && lat < n0;
      const cell = police.stars >= 3 && inMap(14.43747, 50.05786) ? [14.43747, 50.05786] : [14.41636, 50.08256];
      if (kept && loose.includes(kept)) loose.splice(loose.indexOf(kept), 1);
      kept = null;
      police.forgive();
      clock.advance((3 + seeded() * 5) * 3600); // hours in a cell
      if (inMap(cell[0], cell[1])) {
        const [cx, cy] = proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, cell);
        void teleportTo(cx, cy);
      }
    },
    done: () => { frozen = 0.3; },
  });
  const stepArrest = (dt: number) => arrest.update(dt);
  // Wasted: you drop where you are, and a few seconds later you come round outside the
  // nearest hospital, patched up and no longer wanted.
  const health = new Health(), tracers = new Tracers(scene);
  const HOSPITALS = [
    [14.42275, 50.07468], [14.4217, 50.09185], [14.3412, 50.0753], [14.4745, 50.0737], // VFN, Na Františku, Motol, Vinohrady
    [14.463, 50.1163], [14.4604, 50.0306], [14.368, 50.072], [14.366, 50.093], // Bulovka, Thomayer, Homolka, ÚVN
  ];
  let wastedT = 0;
  const wasted = () => {
    if (funicular.me) { funicular.leave(); pid.leave(); }
    boats.me = null;
    if (inHeli) enterOrExit();
    if (inCar) enterOrExit();
    walker.mesh.visible = true;
    walker.knock((seeded() - 0.5) * 2, (seeded() - 0.5) * 2);
    walker.down = 99; // until you come round
    inspector.reset();
    inspector.owed = 0;
    police.forgive();
    stats.wasted++;
    telemetry.did('killed');
    frozen = 3.2;
    wastedT = 3;
    showBanner(t('Wasted'), true);
  };
  const comeRound = () => {
    const tm = `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`;
    const near = HOSPITALS.filter(([lon, lat]) => lon > w0 && lon < e0 && lat > s0 && lat < n0).map((ll) => proj4('EPSG:4326', tm, ll) as [number, number])
      .sort((a, b) => Math.hypot(a[0] - px(), a[1] - py()) - Math.hypot(b[0] - px(), b[1] - py()))[0];
    health.reset();
    clock.advance((4 + seeded() * 8) * 3600); // a night or a day in hospital
    walker.down = 0;
    walker.anim.play('idle', true);
    if (near) void teleportTo(near[0], near[1]);
  };
  let testkit: Testkit | null = null;
  const hurt = (points: number) => { if (!testkit?.unhurt && wastedT <= 0 && health.hurt(points)) wasted(); };
  const police = new Police({
    scene, drive, traffic, grid, height: ground, rng: seeded, edgesNear, walk, walkNear, offscreen, onBusted: busted, kit,
    // A shot is heard, seen and sends people running; one that hits you in a car mostly
    // hits the car.
    onShot: (from, to, hit) => {
      tracers.fire(from, to);
      // A stray bullet can hit someone on the pavement along its path.
      for (const p of crowd.people) {
        if (p.state === 'down') continue;
        const dx = to[0] - from[0], dy = to[1] - from[1], len2 = dx * dx + dy * dy || 1;
        const k = clamp(((p.x - from[0]) * dx + (p.y - from[1]) * dy) / len2, 0, 1);
        if (Math.hypot(from[0] + dx * k - p.x, from[1] + dy * k - p.y) < 0.8) crowd.knock(p, dx * 0.01, dy * 0.01, 2);
      }
      sound.shot(Math.hypot(from[0] - px(), from[1] - py()), from[0] - px());
      crowd.scare(from[0], from[1], 35);
      if (!hit) return;
      telemetry.did('shot by the police');
      if (inCar) { inCar.damage += 6; hurt(inCar.two ? 10 : 3); } else hurt(inHeli ? 3 : 10);
      shake = Math.max(shake, 0.3);
    },
    // Officers on foot go round cars and trams (see obstacles below).
    bodyAt: (x, y, r, skip) => {
      for (const o of obstacles(x, y, r + 3)) {
        if (o.kind !== 'tram' && (!o.car || o.car === skip)) continue;
        if (Math.hypot(o.x - x, o.y - y) < o.r + r) return true;
      }
      return false;
    },
  });

  const inspector = new Inspector({
    scene, kit, grid, rng: seeded, wallet, bodyAt: (x, y, r, skip) => police.bodyAt(x, y, r, skip), offscreen,
    crime: (x, y) => police.crime('fareDodge', x, y),
    fined: (paid) => showBanner(paid < FINE
      ? t('Ticket inspection! You had no ticket, so they took all your money ({paid})', { paid: kc(paid) })
      : t('Ticket inspection! Fine for riding without a ticket: {fine}', { fine: kc(paid) }), true),
    banner: (text) => showBanner(text),
  });
  const allCars = () => [...loose, ...traffic.agents.map((a) => a.car), ...police.cars.map((p) => p.car), ...brigade.engines.map((e) => e.car), ...ambulances.rigs.map((r) => r.car)];
  const drawn: Car[] = []; // the cars drawn this frame
  // Off the tram onto the pavement beside it.
  const getOff = () => {
    const [x, y, h] = ride.leave();
    pid.leave();
    [walker.x, walker.y] = nearestWalkable(grid, x, y);
    Object.assign(walker, { h, vx: 0, vy: 0 });
    walker.mesh.visible = true;
    walker.sync();
    if (inspector.phase === 'decide') inspector.run(walker.x, walker.y, h);
  };
  // A PID ticket, while you're riding without one.
  const buyTicket = (kind = TICKET) => {
    if (pid.state !== 'grace' && pid.state !== 'dodging') return;
    const price = kc(kind.price);
    const bought = pid.buy(clock.t, kind);
    if (bought) telemetry.count('tickets');
    showBanner(bought ? t('Ticket for {validity}: {price}', { validity: validity(kind.minutes), price }) : t('Not enough money for a ticket ({price})', { price }));
  };
  // Take the tram you're on: the driver gets out of the way and it's yours.
  const stealTram = () => {
    if (!ride.on || ride.driving || inspector.phase === 'decide') return;
    const p = ride.v!.parts[1], cab = ride.v!.parts[0], speed = ride.v!.speed;
    if (!ride.steal()) return;
    // The driver is out of the front door (the other side if there's a wall there) and
    // runs: off their feet first, if the tram was going.
    let ox = Math.sin(cab.ang), oy = -Math.cos(cab.ang);
    if (walker.blocked(cab.x + ox * 1.8, cab.y + oy * 1.8)) { ox = -ox; oy = -oy; }
    const driver = crowd.spawnAt(cab.x + ox * 1.8, cab.y + oy * 1.8, { shirt: '#9fb7cf', trousers: '#1f2a3d', skin: '#e3b99a', hair: '#3a2b20', sleeves: false });
    if (speed > 2) {
      crowd.knock(driver, Math.cos(cab.ang) * speed * 0.6 + ox * 2, Math.sin(cab.ang) * speed * 0.6 + oy * 2);
      driver.then = [ox * 5, oy * 5];
    } else Object.assign(driver, { state: 'flee', t: 3, vx: ox * 5, vy: oy * 5 });
    pid.leave(); // no fare, no inspector: you're the driver now
    police.crime('stealTram', p.x, p.y);
    showBanner(t('You took over the tram'));
  };
  // The horn (and a tram's bell), for as long as the key is down: people ahead step aside.
  let hornHeld = false, hornT = 0;
  const hornKind = (c: Car): HornKind => (c.two === 'bike' ? 'bike' : c.two === 'moto' ? 'moto' : c.spec.heavy ? 'heavy' : 'car');
  const honk = (on: boolean) => {
    if (ride.driving) {
      if (on) { ride.drive!.ring(); hornT = 0; hornHeld = true; } else hornHeld = false;
      return;
    }
    if (inCar && !inHeli) {
      hornHeld = on;
      hornT = 0;
      sound.horn(on, hornKind(inCar));
      if (on) haptic('tick');
      return;
    }
    hornHeld = false;
    sound.horn(false);
  };
  // Whoever is walking about in front of you (of the car, or along the track) hurries off.
  const scareAhead = () => {
    const f = ride.driving ? ride.v!.parts[0] : inCar;
    if (!f) return;
    const h = 'ang' in f ? f.ang : f.h, reach = ride.driving ? 14 : 8;
    crowd.scare(f.x + Math.cos(h) * reach, f.y + Math.sin(h) * reach, ride.driving ? 10 : 8);
  };
  const pressB = () => { if (inspector.phase === 'decide') inspector.pay(); else buyTicket(); };
  // Out of the car you're driving, to `at` (or beside it, wherever there's room).
  const leaveCar = (c: Car, at?: Point2) => {
    const lx = -Math.sin(c.h), ly = Math.cos(c.h);
    Object.assign(walker, { x: c.x, y: c.y, _tx: c.x, _ty: c.y, level: world.track(c), gz: c.gz });
    let spot = at ?? null;
    for (const s of spot ? [] : [1, -1]) {
      const x = c.x + lx * s * (c.spec.W / 2 + 0.8), y = c.y + ly * s * (c.spec.W / 2 + 0.8);
      if (!walker.blocked(x, y)) { spot = [x, y]; break; }
    }
    [walker.x, walker.y] = spot || (walker.level ? [c.x, c.y] : nearestWalkable(grid, c.x, c.y));
    walker.h = c.h;
    c.mode = 'loose';
    c.rider = null;
    c.setBox(); // (the bag you carry goes back on your back)
    loose.push(c);
    if (c.share) {
      bikeShare.charge(clock.t, (n) => wallet.take(n, 'shared bike'));
      const done = bikeShare.leave(c, clock.t);
      if (done) showBanner(t('{name}: returned after {minutes} min, {price} in all', { name: done.system.name, minutes: String(Math.max(1, Math.round(done.seconds / 60))), price: kc(done.paid) }));
    }
    inCar = null;
    walker.mesh.visible = true;
    walker.sync();
  };
  // Into the seat: the car is yours to drive.
  const takeSeat = (best: Car) => {
    if (loose.includes(best)) {
      loose.splice(loose.indexOf(best), 1);
      tileCars.delete(best); // it's yours now: it stays when its tile unloads
    }
    best.mode = 'player';
    // (A car taken from its driver also counts as the crime, in police.ts.)
    telemetry.did(`drove: ${VEHICLE_NAMES[best.type]?.toLowerCase() ?? 'car'}`);
    if (best.share) telemetry.did('rented a shared bike');
    inCar = best;
    if (best.variant) showBanner(variantName(best.variant), false, true); // always the small card, so it sits the same under a district title
    walker.perch = 0;
    walker.mesh.visible = false;
  };
  // Whoever was driving the car you're taking, waiting for the door to open on them.
  let evicting: ((pulled: boolean) => void) | null = null;
  const getIn = new GetIn({
    walker,
    evict: (_car, pulled) => { evicting?.(pulled); evicting = null; },
    seated: (car) => { evicting?.(false); evicting = null; takeSeat(car); },
    left: (car, at) => leaveCar(car, at),
  });
  // `quick`: at once, as the game's own moves and the tests want it. The player's key
  // (`interact`) goes through the car's door instead, when there is one to use.
  const enterOrExit = (quick = true) => {
    if (getIn.active) {
      if (!quick && getIn.walking) getIn.cancel();
      if (!quick) return;
      getIn.cancel();
    }
    // In a taxi: out here, and into the one waiting for you.
    if (taxi.riding) { taxi.leave(); return; }
    if (!inCar && !inHeli && !ride.on && !boats.me && !funicular.me && taxi.enter()) return;
    // On the funicular: off beside it, when it stands at a station.
    if (funicular.me) {
      const c = funicular.me;
      if (c.stop === null) return;
      const lx = -Math.sin(c.h), ly = Math.cos(c.h);
      const side = [1, -1].map((k) => [c.x + lx * k * 2.8, c.y + ly * k * 2.8] as [number, number]).find(([x, y]) => !walker.blocked(x, y));
      const [x, y] = side || nearestWalkable(grid, c.x, c.y);
      funicular.leave();
      pid.leave();
      street = null; // the street here, not the line's name
      $('street').textContent = '';
      Object.assign(walker, { x, y, h: c.h, vx: 0, vy: 0 });
      walker.mesh.visible = true;
      walker.sync();
      if (inspector.phase === 'decide') inspector.run(x, y, c.h);
      return;
    }
    // On a tram: off at this stop (or here, if it's stuck), or at the next one.
    if (ride.on) {
      if (ride.canLeave()) getOff();
      else if (ride.driving) showBanner(t('Stop the tram first'));
      else ride.requestStop();
      return;
    }
    // Out of a pedal boat onto the bank, when it's beside one.
    if (boats.me) {
      const b = boats.me, bank = boats.landing(b);
      if (!bank) return;
      const [x, y] = bank;
      boats.me = null;
      Object.assign(walker, { x, y, h: b.h, vx: 0, vy: 0, level: 0, gz: world.terrainAt(x, y) });
      walker.mesh.visible = true;
      walker.sync();
      return;
    }
    if (inHeli) {
      if (!inHeli.landed) return;
      const c = inHeli;
      // Out onto what it landed on (a bridge's deck, not the ground under it).
      const level = c.level, lx = -Math.sin(c.h), ly = Math.cos(c.h);
      Object.assign(walker, { x: c.x, y: c.y, _tx: c.x, _ty: c.y, level, gz: c.z });
      const side = [1, -1].map((k) => [c.x + lx * k * 3, c.y + ly * k * 3] as [number, number]).find(([x, y]) => !walker.blocked(x, y));
      [walker.x, walker.y] = side || (level ? [c.x, c.y] : nearestWalkable(grid, c.x + lx * 3, c.y + ly * 3));
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
        telemetry.did('flew a helicopter');
        walker.mesh.visible = false;
        return;
      }
    }
    if (inCar) {
      const c = inCar;
      // Out onto what the car is on (a bridge's deck, not the ground under it).
      Object.assign(walker, { x: c.x, y: c.y, _tx: c.x, _ty: c.y, level: world.track(c), gz: c.gz });
      // Through the door (leaveCar follows, once it's open), or straight out.
      if (!quick && getIn.exit(c)) return;
      leaveCar(c);
      return;
    }
    const boat = boats.near(walker.x, walker.y, world.groundFor(walker, walker.x, walker.y) + walker.z + walker.perch);
    if (boat) {
      boats.me = boat;
      telemetry.did('took a pedal boat');
      walker.mesh.visible = false;
      return;
    }
    const cabin = funicular.near(walker.x, walker.y);
    if (cabin) {
      funicular.board(cabin);
      telemetry.did('rode the funicular');
      if (cabin.line.spec.ticket) pid.board(clock.t);
      walker.mesh.visible = false;
      return;
    }
    const tram = ride.boardable(walker.x, walker.y);
    if (tram) {
      ride.board(tram);
      telemetry.did('rode a tram');
      pid.board(clock.t);
      walker.mesh.visible = false;
      return;
    }
    const station = metro.near(walker.x, walker.y);
    if (station) {
      metro.open(station);
      telemetry.did('went down into the metro');
      return;
    }
    let best = null, bestD = Infinity;
    for (const c of allCars()) {
      if (c.burnt || apartOnFoot(c)) continue;
      const d = c.gap(walker.x, walker.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    // A bag lying within reach is picked up (unless a vehicle is closer); with one on your
    // back and nothing to get into, E puts it down.
    const lying = !bags.carried && bags.near(walker.x, walker.y);
    if (lying && (!best || bestD > 1.8 || lying.d <= bestD)) {
      bags.take(lying.bag);
      telemetry.did("picked up a courier's bag");
      return;
    }
    if (!best || bestD > 1.8) {
      if (bags.carried) {
        bags.putDown(walker.x + Math.cos(walker.h) * 0.7, walker.y + Math.sin(walker.h) * 0.7, walker.h);
        telemetry.did("put down a courier's bag");
      }
      return;
    }
    if (best.share && !bikeShare.rent(best, clock.t, (n) => wallet.has(n))) {
      const sys = bikeShare.systems[best.share.system];
      showBanner(t('Not enough money for a bike ({price})', { price: kc(rentalCost(sys && bikeShare.planOf(sys), 0)) }));
      return;
    }
    if (best.share) bikeShare.charge(clock.t, (n) => wallet.take(n, 'shared bike'));
    const agent = traffic.agents.find((a) => a.car === best);
    const box = best.courier;
    // A car is got into through a door, when you can get to one.
    const door = quick || best.two ? null : getIn.door(best);
    // A police car: the officer in it gets out and comes after you.
    const cop = best.type === 'police';
    if (cop) police.take(best);
    const engine = brigade.take(best) || ambulances.take(best);
    if (engine) police.crime('carjack', best.x, best.y);
    if (agent) traffic.release(agent);
    // The driver leaves the car and runs off: pulled out through their door by you (and
    // left on the ground beside it for a moment), or out by themselves. A rider is pushed
    // off on the side away from you (the other side if there's a wall there), knocked
    // down if the bike was going, and runs off once up again.
    const evict = (pulled: boolean) => {
      const car = best!, own = car.doors[0];
      let lx = -Math.sin(car.h), ly = Math.cos(car.h), off = 1.6, back = 0;
      if (car.two) {
        off = car.spec.W / 2 + 0.5;
        if ((walker.x - car.x) * lx + (walker.y - car.y) * ly > 0) { lx = -lx; ly = -ly; }
        if (walker.blocked(car.x + lx * off, car.y + ly * off)) { lx = -lx; ly = -ly; }
      } else if (door && own) {
        // Out of the driver's door: behind you if you pulled them, where you'd stand otherwise.
        off = car.spec.W / 2 + (pulled ? 1.25 : 0.6);
        back = (own.front + own.back) / 2 - (pulled ? 1.3 : 0.25);
      }
      const fx = Math.cos(car.h), fy = Math.sin(car.h);
      const p = crowd.spawnAt(car.x + lx * off + fx * back, car.y + ly * off + fy * back, car.rider || undefined);
      // A courier leaves the bag behind, on the ground by the bike.
      if (box) bags.drop(car.x + lx * (car.spec.W / 2 + 0.35) - fx * 0.4, car.y + ly * (car.spec.W / 2 + 0.35) - fy * 0.4, box, car.h);
      if (car.two && car.speed > 2) {
        crowd.knock(p, car.vx * 0.7 + lx * 2, car.vy * 0.7 + ly * 2);
        p.then = [lx * 5, ly * 5];
      } else if (pulled) {
        crowd.knock(p, lx * 2.2 - fx * 1.6, ly * 2.2 - fy * 1.6);
        p.then = [lx * 4 - fx * 3, ly * 4 - fy * 3];
      } else Object.assign(p, { state: 'flee', t: 2, vx: lx * 5, vy: ly * 5 });
      police.crime('carjack', car.x, car.y);
    };
    const driver = !!agent && !cop;
    if (door) {
      // The car waits where it is (its driver still in it) until you're at the door.
      if (!loose.includes(best)) loose.push(best);
      best.mode = 'loose';
      evicting = driver ? evict : null;
      getIn.enter(best, door, driver);
      return;
    }
    if (driver) evict(false);
    if (best.two) {
      best.rider = walker.look;
      // A box already on it (a parked courier's bike): its bag is yours now. Carrying one, it rides the bike.
      if (box && !agent && !bags.carried) bags.carry(box);
      best.setBox(bags.carried ?? undefined);
    }
    takeSeat(best);
  };
  const interact = () => enterOrExit(false);

  // A hard knock on a bike or motorbike throws you off it.
  const throwOff = () => {
    const c = inCar;
    if (!c) return;
    telemetry.did('thrown off a bike');
    enterOrExit();
    hurt(Math.hypot(c.vx, c.vy) * 1.5);
    walker.knock(c.vx * 0.6, c.vy * 0.6);
    c.vx *= 0.4;
    c.vy *= 0.4;
    shake = 0.8;
  };

  // Whoever rides a bike or moped that's been hit hard goes over the handlebars, to the side
  // away from the blow, and runs once up again; a courier leaves the bag on the ground.
  const throwRider = (c: Car, vx: number, vy: number, hurt = 0) => {
    if (!c.two || !c.rider) return;
    const off = c.spec.W / 2 + 0.5;
    let lx = -Math.sin(c.h), ly = Math.cos(c.h);
    if (vx * lx + vy * ly < 0) { lx = -lx; ly = -ly; }
    if (walker.blocked(c.x + lx * off, c.y + ly * off)) { lx = -lx; ly = -ly; }
    const p = crowd.spawnAt(c.x + lx * off, c.y + ly * off, c.rider);
    crowd.knock(p, vx * 0.7 + lx * 2, vy * 0.7 + ly * 2, hurt);
    p.then = [lx * 5, ly * 5];
    if (c.courier) bags.drop(c.x + lx * (c.spec.W / 2 + 0.35) - Math.cos(c.h) * 0.4, c.y + ly * (c.spec.W / 2 + 0.35) - Math.sin(c.h) * 0.4, c.courier, c.h);
    c.setBox();
    c.rider = null;
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
    if (!best || !onto) return;
    // Onto a bridge if that street is a bridge, into a tunnel if it's a tunnel, else
    // onto the ground.
    Object.assign(inCar, { x: best.x, y: best.y, h: best.ang, vx: 0, vy: 0, w: 0, level: undefined, hint: onto.bridge ? 'bridge' : onto.tunnel ? 'tunnel' : 'ground' });
  };

  // Jump anywhere in the area: load the tiles there first, then land on a pavement
  // (or on the road, if you're driving) and bring the traffic and people along.
  const teleportTo = async (x: number, y: number) => {
    inspector.reset();
    if (ride.on) getOff();
    const who = inCar || inHeli || walker;
    Object.assign(who, { x, y, vx: 0, vy: 0 });
    if (inHeli) inHeli.z = Math.max(inHeli.z, ground(x, y) + 60);
    if (inCar) inCar.w = 0;
    camPos.set(x, 0, -y);
    await world.loadNow(x, y, 300, viewRadius() + world.drawBeyond);
    if (inCar) backOnRoad();
    else if (!inHeli) { [walker.x, walker.y] = nearestWalkable(grid, x, y, 150); walker.sync(); }
    for (const a of [...traffic.agents]) traffic.release(a);
    police.reset();
    brigade.reset();
    ambulances.reset();
    fires.reset();
    scatterPeople(false);
    camPos.set(px(), 0, -py());
    camGround = ground(px(), py(), inHeli ? null : inCar || walker);
    street = null; // show the new street's name, not the old one
    $('street').textContent = '';
  };
  const taxi = new Taxis({
    scene, traffic, drive, world, el: $('taxi'), walker, edgesNear, offscreen, standAt: (x, y) => nearestWalkable(grid, x, y), banner: (t) => showBanner(t), wallet,
    toLocal: (lon, lat) => (lon > w0 && lon < e0 && lat > s0 && lat < n0 ? proj4('EPSG:4326', `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m`, [lon, lat]) as [number, number] : null),
  });
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
      choppers.push(new Chopper(scene, grid, (x, y, z) => world.below(x, y, z), x, y, who.h, inHeli ? inHeli.z : ground(who.x, who.y, who) + 1));
      return true;
    }
    return false;
  };
  // Developer tools: the nearest person on the pavement is left lying hurt (the ambulance comes).
  const hurtNearest = (grave = true) => {
    let best: Pedestrian | null = null, bestD = 80;
    for (const p of crowd.people) {
      const d = Math.hypot(p.x - px(), p.y - py());
      if (p.state !== 'walk' || d >= bestD) continue;
      best = p;
      bestD = d;
    }
    if (best) crowd.knock(best, 0.4, 0, grave ? 2 : 1);
    return best;
  };
  // Developer tools: the nearest car (not yours) is set on fire.
  const setFire = () => {
    let best: Car | null = null, bestD = 80;
    for (const c of allCars()) {
      const d = Math.hypot(c.x - px(), c.y - py());
      if (c === inCar || c.burnt || c.two === 'bike' || c.type === 'fire' || c.type === 'ambulance' || d >= bestD) continue;
      best = c;
      bestD = d;
    }
    if (!best) return false;
    const ag = traffic.agents.find((a) => a.car === best);
    if (ag) { traffic.release(ag); best.mode = 'loose'; loose.push(best); }
    best.damage = 100;
    fires.check(best);
    return true;
  };
  const sound = new Sound();
  benchPause.onChange((paused) => sound.hold(paused));
  // What the ground under a car is made of, for its tyres: the OSM surface of the street
  // it's on, or the pavement off the streets.
  let surface: Surface = 'asphalt', surfaceT = 0;
  let busy = 0.5, busyT = 0; // how busy the streets around you are, for the city's sound
  const surfaceUnder = (x: number, y: number): Surface => {
    let best: DriveEdge | null = null, bestD = Infinity;
    for (const e of edgesNear(x, y, 20)) {
      const d = project(e.path, x, y).d - e.width / 2 - Math.abs(e.laneOffset);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best && bestD < 1 ? surfaceOf(best.surface) : 'pavement';
  };
  const dev = setupDev({ area: AREA, index, teleport: teleportTo, position: () => [px(), py()], helicopter: addChopper, setFire, setHurt: () => !!hurtNearest(), backOnRoad,
    timeOfDay: () => clock.t % 86400, setTimeOfDay: (sec) => clock.advance(sec - clock.t % 86400), graphics,
    season: { day: () => season.day, set: (day) => season.set(day), label: () => season.label() },
    weather: { kinds: KINDS, get: () => (weather.fixed ? weather.kind : 'auto'), set: (k: Kind | 'auto') => { if (k === 'auto') weather.fixed = false; else weather.set(k, true); }, label: () => weather.name } });
  // ---- Saved games (save.ts) ---------------------------------------------
  // The game saves itself into the "auto" slot every few seconds and when the page is
  // left; a refresh then offers to continue from there (see `resume`). Test runs (?go)
  // never save, so they can't overwrite a real game.
  let playing = false; // set once the start screen is done
  let saving = true; // off while the page restarts into another game
  let saveT = 0;
  const capture = (): SaveData => {
    const c = inCar && !inCar.burnt ? inCar : null, who = c || walker;
    const [lon, lat] = dev.toLonLat(who.x, who.y);
    return {
      v: 1, area: AREA, at: Date.now(), lat, lon, heading: ((((90 - (who.h * 180) / Math.PI) % 360) + 360) % 360), street,
      car: c ? { type: c.type, paint: c.paint, box: c.courier, variant: c.modelName, damage: c.damage, radio: c.radio, broken: c.broken, ram: c.ram } : null,
      money: wallet.balance, ticket: wallet.held, health: health.value, heat: police.heat,
      clock: clock.t, season: season.day, weather: { kind: weather.kind, fixed: weather.fixed },
    };
  };
  const autosave = () => {
    if (playing && saving && wastedT <= 0 && !arrest.active && !health.dead && !inHeli) writeSave('auto', capture());
  };
  window.addEventListener('pagehide', autosave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
  // Back into a saved game: the map is already loaded, so this is a teleport with your
  // belongings, and into your car if you were driving.
  const resume = async (s: SaveData) => {
    clock.t = s.clock;
    world.night = clock.night;
    if (s.season) season.set(s.season);
    weather.begin(s.weather.fixed ? s.weather.kind : automaticWeather(s.weather.kind), clock.t);
    weather.fixed = s.weather.fixed;
    wallet.balance = Math.max(0, Math.floor(s.money));
    wallet.held = s.ticket;
    health.value = Math.max(1, Math.min(100, s.health));
    const [x, y] = dev.toLocal(s.lon, s.lat), h = ((90 - s.heading) * Math.PI) / 180;
    await teleportTo(x, y);
    police.heat = Math.max(0, Math.min(40, s.heat));
    if (!s.car || !TYPES[s.car.type]) return;
    const car = new Car(s.car.type, seeded, x, y, h, s.car.paint, s.car.box);
    if (s.car.variant) car.setVariant(s.car.variant);
    car.damage = s.car.damage;
    car.radio = s.car.radio;
    if (s.car.ram) car.armour();
    car.broken = s.car.broken ?? 0;
    for (let i = loose.length - 1; i >= 0; i--) if (Math.hypot(loose[i].x - car.x, loose[i].y - car.y) < 5) loose.splice(i, 1);
    car.mode = 'loose';
    loose.push(car);
    restingStale = true;
    const side = car.spec.W / 2 + 0.6;
    Object.assign(walker, { x: car.x - Math.sin(car.h) * side, y: car.y + Math.cos(car.h) * side, h: car.h, vx: 0, vy: 0 });
    walker.sync();
    enterOrExit();
  };
  const restart = () => { saving = false; location.reload(); };
  const saves = {
    list: () => listSaves(AREA),
    save: () => { writeSave(newSlot(), capture()); telemetry.count('saves'); telemetry.did('saved the game by hand'); },
    // Loading restarts the page into that game (it becomes the auto save, and the start screen offers it).
    load: (slot: Slot) => { const s = readSave(slot, AREA); if (!s) return; writeSave('auto', s); telemetry.did('loaded a saved game'); restart(); },
    remove: (slot: Slot) => clearSave(slot),
    newGame: () => { clearSave('auto'); telemetry.did('started a new game from the settings'); restart(); },
    // Back to the start screen, which offers to continue from this save.
    exit: () => { autosave(); telemetry.did('went back to the main menu'); restart(); },
  };
  const settingsPanel = setupSettings({ sound, graphics, weather: { kinds: KINDS, get: () => (weather.fixed ? weather.kind : 'auto'), set: (k: Kind | 'auto') => { if (k === 'auto') weather.fixed = false; else weather.set(k); } }, saves });

  // ---- Input -------------------------------------------------------------
  const input: Record<InputKey, boolean> = { up: false, down: false, left: false, right: false, run: false, brake: false, jump: false };
  const keymap: Record<string, InputKey> = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'brake' };
  const dialog = new Dialog();
  window.addEventListener('keydown', (e) => {
    // The metro screen and a conversation take the keys while they're up.
    if (metro.active || dialog.active) {
      if (!dialog.active) metro.key(e.code, e.repeat);
      else if (!e.repeat) dialog.key(e.code);
      e.preventDefault();
      return;
    }
    // Escape pauses the game by opening the settings, which also hold the saves.
    if (e.code === 'Escape') { if (!e.repeat && !settingsPanel.open) settingsPanel.show(); e.preventDefault(); return; }
    if (taxi.key(e.code, !inCar && !inHeli && !ride.on && !boats.me && !funicular.me)) { e.preventDefault(); return; }
    if (keymap[e.code]) { input[keymap[e.code]] = true; e.preventDefault(); }
    if (e.shiftKey) input.run = true;
    if ((e.code === 'KeyE' || e.code === 'Enter') && !e.repeat) interact();
    if (e.code === 'KeyB' && !e.repeat) pressB();
    const pick = /^Digit([1-4])$/.exec(e.code);
    if (pick && !e.repeat && inspector.phase !== 'decide') buyTicket(TICKETS[Number(pick[1]) - 1]);
        if (e.code === 'KeyF') { cannonHeld = true; if (!e.repeat) stealTram(); }
    if (e.code === 'KeyX' && !e.repeat) { if (ride.driving) telemetry.did('opened the tram doors'); ride.doors(); }
    if (e.code === 'KeyQ' && !e.repeat) honk(true);
    // Space jumps, except at a tram stop, where holding it waits for a tram.
    if (e.code === 'Space' && !e.repeat && !board.shown && !inCar && !inHeli && !ride.on && taxi.state !== 'coming') { input.jump = true; telemetry.did('jumped'); }
    if (e.code === 'KeyM' && !e.repeat) sound.toggle();
    if (e.code === 'KeyR' && !e.repeat && inCar && !inCar.two && sound.radio) {
      const station = sound.radio.next();
      telemetry.did('changed the radio station');
      showBanner(station ? station.name : t('Radio off'));
    }
    if (e.code === 'KeyG' && !e.repeat) { graphics.cycle(); showBanner(graphics.label()); telemetry.setting('Graphics', graphics.choice); }
    if (e.code === 'KeyP' && !e.repeat) { weather.cycle(); showBanner(weather.label()); telemetry.setting('Weather', weather.kind); }
    if (e.code === 'KeyH' && !e.repeat) foldHelp(!$('help').classList.contains('folded'));
    // On a tram, W and S move your pick along the stops ahead.
    if (ride.on && ['KeyW', 'ArrowUp'].includes(e.code)) ride.pick(-1);
    if (ride.on && ['KeyS', 'ArrowDown'].includes(e.code)) ride.pick(1);
  });
  // The controls card remembers whether you folded it away.
  const foldHelp = (folded: boolean) => {
    $('help').classList.toggle('folded', folded);
    try { localStorage.setItem('help-folded', folded ? '1' : ''); } catch {}
  };
  try { foldHelp(localStorage.getItem('help-folded') === '1'); } catch {}
  window.addEventListener('keyup', (e) => {
    if (keymap[e.code]) input[keymap[e.code]] = false;
    if (!e.shiftKey) input.run = false;
    if (e.code === 'KeyQ') honk(false);
    if (e.code === 'KeyF') cannonHeld = false;
  });
  let zoom = 1;
  const zoomBy = (f: number) => { zoom = clamp(zoom * f, 0.5, 4); };
  window.addEventListener('wheel', (e) => {
    const f = Math.exp(e.deltaY * 0.0012);
    if (testkit?.cam) testkit.cam.height = clamp(testkit.cam.height * f, 5, 1500);
    else zoomBy(f);
  }, { passive: true });
  $('t-ticket').addEventListener('click', pressB);
  const touch = setupTouch({ action: interact, backOnRoad, zoomBy, horn: honk, steal: stealTram, cannon: (on) => { cannonHeld = on; }, doors: () => ride.doors(), jump: () => {
    if (!inCar && !inHeli && !ride.on && !metro.active && !dialog.active && !boats.me && !funicular.me && !taxi.riding) { input.jump = true; telemetry.did('jumped'); }
  }, force: params.has('touch') });
  Object.assign(padHooks, { settings: () => settingsPanel.show(), menu: () => metro.active || dialog.active, zoomBy });
  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---- Loop --------------------------------------------------------------
  const look = new THREE.Vector3();
  let last = performance.now(), shake = 0;
  // The car you're standing on, and where it was last step (to carry you with it).
  let onCar: { c: Car; x: number; y: number; h: number } | null = null;
  // A car blowing up knocks down and hurts whoever is near, shoves the cars round about
  // and damages them (close by, enough to set them going too), and kills you if you're
  // still inside. Setting it going yourself is a crime.
  const BLAST = 9;
  const HURTS = 9; // m/s: a car going faster than this leaves the person it hits lying hurt, and one faster than half as much again has them taken away
  const fires: Fires = new Fires({
    scene, height: ground, rng: seeded,
    onIgnite: (c) => {
      if (c === inCar) telemetry.did('own car caught fire');
      if (c === inCar) showBanner(t('Your car is on fire!'), true);
      brigade.call(c);
      // A driver from the traffic gets out of a car that's on fire and runs, leaving it where it stands.
      const agent = traffic.agents.find((k) => k.car === c);
      if (agent && c !== inCar) {
        traffic.release(agent);
        c.mode = 'loose';
        loose.push(c);
        const lx = -Math.sin(c.h), ly = Math.cos(c.h), off = 1.6;
        const p = crowd.spawnAt(c.x + lx * off, c.y + ly * off, c.rider || undefined);
        Object.assign(p, { state: 'flee', t: 3, vx: lx * 5, vy: ly * 5 });
      }
    },
    awaited: (c) => brigade.awaited(c),
    onBlast: (c, blamed) => {
      if (!blamed) telemetry.did('a car blew up nearby'); // (one you set off is a crime, counted in police.ts)
      const { x, y } = c, near = (p: { x: number; y: number }) => 1 - Math.hypot(p.x - x, p.y - y) / BLAST;
      const away = (p: { x: number; y: number }, v: number) => {
        const d = Math.hypot(p.x - x, p.y - y) || 1;
        return [((p.x - x) / d) * v, ((p.y - y) / d) * v] as const;
      };
      const d = Math.hypot(x - px(), y - py());
      sound.boom(d, x - px());
      hapticBlast(d);
      shake = Math.min(1.6, shake + (1.4 * 30) / (30 + d));
      if (c === inCar) hurt(MAX_HEALTH);
      else if (inCar) hurt(25 * Math.max(0, near(inCar)));
      else if (!inHeli && !ride.on && !taxi.riding && !boats.me && !funicular.me && near(walker) > 0) {
        const k = near(walker);
        if (walker.down <= 0) walker.knock(...away(walker, 3 + 7 * k));
        hurt(95 * k);
      }
      for (const p of crowd.people) if (near(p) > 0 && p.state !== 'down') crowd.knock(p, ...away(p, 3 + 7 * near(p)), near(p) > 0.6 ? 2 : near(p) > 0.35 ? 1 : 0);
      for (const m of ambulances.crew) if (near(m) > 0 && m.down <= 0) ambulances.knock(m, ...away(m, 3 + 7 * near(m)));
      crowd.scare(x, y, 45);
      for (const o of police.officers) if (near(o) > 0 && o.down <= 0) police.knock(o, ...away(o, 3 + 7 * near(o)));
      for (const f of brigade.crew) if (near(f) > 0 && f.down <= 0) brigade.knock(f, ...away(f, 3 + 7 * near(f)));
      brigade.call(c);
      if (inspector.person && near(inspector.person) > 0 && inspector.person.down <= 0) inspector.knock(...away(inspector.person, 3 + 7 * near(inspector.person)));
      for (const b of [...carsNear(x, y, BLAST)]) {
        const k = near(b);
        if (b === c || k <= 0) continue;
        const ag = traffic.agents.find((a) => a.car === b);
        if (ag) { traffic.release(ag); b.mode = 'loose'; loose.push(b); }
        const [vx, vy] = away(b, (8 * k * 1500) / b.mass);
        b.vx += vx;
        b.vy += vy;
        b.w += (seeded() - 0.5) * 3 * k;
        b.damage += 120 * k;
        if (blamed) fires.blame(b);
        fires.check(b);
      }
      if (blamed) police.crime(c.type === 'police' ? 'blowUpCop' : 'blowUp', x, y);
    },
  });
  const brigade: Brigade = new Brigade({
    scene, police, grid, fires, kit, height: ground, rng: seeded, edgesNear, offscreen, viewRadius,
    bodyAt: (x, y, r, skip) => police.bodyAt(x, y, r, skip),
  });
  const ambulances: Ambulances = new Ambulances({
    scene, police, grid, kit, height: ground, rng: seeded, edgesNear, offscreen, viewRadius,
    bodyAt: (x, y, r, skip) => police.bodyAt(x, y, r, skip),
    people: () => crowd.people, revive: (p) => crowd.revive(p),
    take: (p) => { if (crowd.people.includes(p)) crowd.retire(p); },
  });
  // Streets far behind you leave the graphs, and what is indexed from them, unless one
  // of these is still out there (see TileWorld.forget).
  world.anchors = () => {
    const out: { x: number; y: number }[] = [{ x: px(), y: py() }];
    for (const c of police.cars) out.push(c.car);
    for (const e of brigade.engines) out.push(e.car, e.target);
    for (const r of ambulances.rigs) out.push(r.car, r.patient);
    if (taxi.agent) out.push(taxi.agent.car);
    return out;
  };
  world.onForget = (d, w) => {
    names.remove(d);
    names.remove(w);
    crowd.forget(w);
    signals.forget(d);
    police.forget(d);
    police.forget(w);
  };
  let waitScale = 1, clockShown = '';
  let ticketWas = false;
  let rideAt: boolean | null = null, funiAt: number | null | undefined;
  let street: string | null = null, bannerT = 0, lifeT = 0;
  // The HUD is only written when what it says changes: every write makes the browser
  // lay the page out again.
  const shown: Record<string, string | number> = {};
  let radioShown = '';
  let carShown = '';
  const stationList = $('radio').querySelector('select')!;
  for (const [i, label] of [[-1, t('Radio off')], ...STATIONS.map((s, i) => [i, s.name] as const)] as [number, string][]) stationList.add(new Option(label, String(i)));
  const refreshStations = () => {
    for (const option of stationList.options) {
      const station = STATIONS[Number(option.value)];
      option.disabled = option.hidden = !!station && !stationAllowed(station.id);
    }
  };
  refreshStations();
  onRadioPreferencesChange(refreshStations);
  stationList.addEventListener('change', () => { sound.radio?.pick(Number(stationList.value)); stationList.blur(); });
  $('radio').addEventListener('click', (e) => {
    const radio = sound.radio, what = (e.target as HTMLElement).closest('button')?.dataset.radio;
    if (!radio || !what) return;
    if (what === 'prev') radio.prev(); else if (what === 'next') radio.next(); else radio.set(!radio.station);
    telemetry.did('changed the radio station');
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const show = (id: string, value: string | number, how: 'text' | 'html' | 'opacity' = 'text') => {
    const key = `${id}/${how}`;
    if (shown[key] === value) return;
    shown[key] = value;
    const el = $(id);
    if (how === 'html') el.innerHTML = String(value);
    else if (how === 'opacity') el.style.opacity = String(value);
    else el.textContent = String(value);
  };
  sound.onRadioFail = (station) => showBanner(t('{name} isn’t playing right now').replace('{name}', station.name), true);
  // A short word (Wasted, a station's name) goes up big; a sentence or a setting (a fee,
  // a fare, "Weather: rain") goes in a card, so it doesn't stretch across the screen.
  // "Busted · fine…" gives both: the word big and the rest in the card under it.
  const showBanner = (text: string, alert = false, card = false) => {
    const [head, ...rest] = text.split(' · ');
    const big = !card && head.length <= 22 && !head.includes(':') ? head : '';
    const note = big ? rest.join(' · ') : text;
    const el = $('banner');
    el.replaceChildren();
    if (big) el.appendChild(Object.assign(document.createElement('div'), { className: 'big', textContent: big }));
    if (note) el.appendChild(Object.assign(document.createElement('div'), { className: 'note', textContent: note }));
    el.classList.toggle('alert', alert);
    bannerT = alert ? 3.5 : 2.6;
  };
  // Everything that moves or blocks, made again every step; parked and abandoned cars
  // that stand still (thousands of them across the loaded tiles) have a hash of their
  // own, made again only when one of them moves, comes or goes.
  const hash = new SpatialHash<Obstacle>(10), restingWhole = new SpatialHash<Obstacle>(10);
  // Plan 012 Part B: the same index kept up to date car by car instead of made again
  // whenever one changes. Off unless ?resting=incremental: it measured no quicker.
  const restingByCar = new RestingCars(10);
  let incremental = params.get('resting') === 'incremental';
  let resting: { near: (x: number, y: number, r: number, out?: Obstacle[]) => Obstacle[] } = incremental ? restingByCar : restingWhole;
  // (For comparing the two in one page: each starts again from nothing.)
  const restingIndex = (byCar: boolean) => {
    incremental = byCar;
    resting = byCar ? restingByCar : restingWhole;
    restingByCar.reset();
    for (const c of loose) c.resting = false;
    restingStale = true;
  };
  // The moving cars alone, again: carsNear, run for every person near you, needn't wade through the crowd in `hash`.
  const carHash = new SpatialHash<Obstacle>(10);
  // (The list is reused: it holds until the next call, and no caller looks up more
  // obstacles while it goes through one list.)
  const found: Obstacle[] = [];
  const obstacles = (x: number, y: number, rr: number) => {
    found.length = 0;
    hash.near(x, y, rr, found);
    return resting.near(x, y, rr, found);
  };
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, d: number) => Math.abs(a.x - b.x) < d && Math.abs(a.y - b.y) < d;
  // The cars within rr of (x, y), each once, into `out` (reused, to spare the garbage).
  let stamp = 0;
  const carsNear = (x: number, y: number, rr: number, out: Car[] = []) => {
    stamp++;
    out.length = 0;
    found.length = 0;
    carHash.near(x, y, rr, found);
    resting.near(x, y, rr, found);
    for (const o of found) if (o.car && o.car.stamp !== stamp) { o.car.stamp = stamp; out.push(o.car); }
    return out;
  };
  const nearA: Car[] = [], nearB: Car[] = [];
  // The cars (moving and resting) near a spot, as obstacles: what a walker steps round.
  const carsOnly = (x: number, y: number, rr: number) => {
    found.length = 0;
    carHash.near(x, y, rr, found);
    return resting.near(x, y, rr, found);
  };
  const pushCar = (h: SpatialHash<Obstacle>, c: Car) => {
    for (const [x, y] of c.circles()) {
      const o: Obstacle = { x, y, z: c.gz, r: c.r, vx: c.vx, vy: c.vy, kind: c.mode === 'player' ? 'player' : 'car', car: c };
      h.add(o);
      if (h === hash) carHash.add(o);
    }
  };
  // On a bridge and under it: two things that don't meet.
  const apart = (a: { gz?: number }, b: { gz?: number }) => a.gz !== undefined && b.gz !== undefined && Math.abs(a.gz - b.gz) > 3;
  // A car on the road above a tunnel you walk in (or under your bridge) is out of reach.
  const apartOnFoot = (c: Car) => { world.track(c); world.track(walker); return apart(c, walker); };
  const moving = (c: Car) => c.mode === 'player' || c.vx * c.vx + c.vy * c.vy > 0.0025 || Math.abs(c.w) > 0.01; // over 5 cm/s
  let restingCount = -1;
  const syncResting = () => {
    if (incremental) { restingByCar.sync(loose, moving); return; }
    let n = 0, stale = restingStale;
    for (const c of loose) {
      if (moving(c)) { stale ||= !!c.resting; continue; }
      n++;
      stale ||= !c.resting || !c.restAt || c.restAt[0] !== c.x || c.restAt[1] !== c.y || c.restAt[2] !== c.h;
    }
    if (!stale && n === restingCount) return;
    restingWhole.clear();
    for (const c of loose) {
      c.resting = !moving(c);
      if (!c.resting) continue;
      pushCar(restingWhole, c);
      c.restAt = [c.x, c.y, c.h];
    }
    restingCount = n;
    restingStale = false;
  };
  let spawnT = 0;

  // One step of everything that moves (several per frame while a tram ride is sped up).
  let jolt = 0; // the hardest hit your own vehicle took this step
  const simulate = (dt: number, ctl: Controls) => {
    jolt = 0;
    clock.advance(dt);
    if (frozen > 0) {
      frozen -= dt;
      Object.assign(ctl, { move: 0, turn: 0, aim: null, run: false, brake: true });
    }
    stepArrest(dt);
    health.update(dt);
    if (wastedT > 0 && (wastedT -= dt) <= 0) comeRound();
    assisted = false;
    // Getting in or out through a door: the figure is moved for you, the car held still.
    const scripted = getIn.active;
    if (scripted) {
      Object.assign(ctl, { move: 0, turn: 0, aim: null, run: false, brake: true });
      if (walker.down > 0) getIn.cancel();
      else getIn.update(dt);
    }
    if (inCar) {
      let steer = ctl.aim ? steerToward(inCar, ctl.aim.h, ctl.move) : ctl.turn;
      if (ctl.run) {
        const a = assist.steer(inCar, steer);
        if (a !== null) { steer = a; assisted = true; }
      } else assist.reset();
      held = ctl.aim && !assisted ? { h: ctl.aim.h, throttle: ctl.move, handbrake: ctl.brake } : null;
      // Keeping to the lane, you keep to the speed limit too.
      const cap = assisted ? (assist.limit ?? 50) / 3.6 : null;
      const hit = inCar.update(dt, { throttle: ctl.move, steer, handbrake: ctl.brake, cap }, grid);
      if (hit > 6) { shake = Math.min(1.2, shake + hit * 0.04); hapticCrash(hit); }
      jolt = hit;
    } else if (!scripted && !arrest.active && !inHeli && !ride.on && !boats.me && !funicular.me && !taxi.riding) walker.update(dt, ctl);
    // In the helicopter Space climbs and Shift comes down.
    const heliTurn = inHeli && ctl.aim ? clamp(turnOf(inHeli.h, ctl.aim.h) * 1.2, -1, 1) : ctl.turn;
    for (const c of choppers) c.update(dt, c === inHeli ? { move: ctl.move, turn: heliTurn, up: ctl.brake, down: ctl.run } : null);

    const movers = loose.filter(moving);
    for (const c of movers) c.update(dt, null, grid);
    const me = inCar || inHeli || walker;
    police.update(dt, { x: me.x, y: me.y, z: inHeli ? inHeli.z : ground(me.x, me.y, inCar || walker), vx: me.vx, vy: me.vy, speed: Math.hypot(me.vx, me.vy), car: inCar, air: (!!inHeli && !inHeli.landed) || ride.on || taxi.riding, riding: ride.on || taxi.riding });
    inspector.update(dt, { x: me.x, y: me.y, h: inCar ? inCar.h : walker.h, onFoot: !inCar && !inHeli && !ride.on && !taxi.riding && !boats.me && !funicular.me, inVehicle: !!inCar || !!inHeli || taxi.riding || !!boats.me });
    brigade.update(dt, me);
    ambulances.update(dt, me);
    cannon.update(dt, inCar, cannonHeld, (x, y) => ground(x, y));
    if (cannon.jet && inCar) {
      // The water puts out burning cars and knocks people (and officers) over, gently.
      const car = inCar, { x: dx, y: dy } = cannon.dir;
      for (const c of allCars()) if (c !== car && fires.onFire(c) && cannon.hit(car, c.x, c.y, 2 + c.spec.L / 2) >= 0) fires.douse(c, dt * HOSE);
      for (const p of crowd.people) {
        if (p.state === 'down' || cannon.hit(car, p.x, p.y, 1.8) < 0) continue;
        crowd.knock(p, dx * 3, dy * 3);
        stats.knocked++;
        police.crime('knock', p.x, p.y);
      }
      for (const o of police.officers) {
        if (o.down > 0 || cannon.hit(car, o.x, o.y, 1.8) < 0) continue;
        police.knock(o, dx * 3, dy * 3);
        police.crime('hitCop', o.x, o.y);
      }
      for (const f of brigade.crew) if (f.down <= 0 && cannon.hit(car, f.x, f.y, 1.8) >= 0) brigade.knock(f, dx * 3, dy * 3);
    }
    const cops = [...police.cars.map((p) => p.car), ...brigade.engines.map((e) => e.car), ...ambulances.rigs.map((r) => r.car)];

    // Everything the traffic, trams and people need to look out for.
    hash.clear();
    carHash.clear();
    for (const a of traffic.agents) pushCar(hash, a.car);
    for (const c of movers) pushCar(hash, c);
    syncResting();
    for (const c of cops) pushCar(hash, c);
    if (inCar) pushCar(hash, inCar);
    else if (!inHeli && !ride.on && !taxi.riding) hash.add({ x: walker.x, y: walker.y, z: walker.gz, r: 0.5, vx: walker.vx, vy: walker.vy, kind: 'player' });
    // (People walking along the pavement only where a car is driving along it too.)
    traffic.gatherPavementCars();
    for (const p of crowd.people) if (p.state !== 'walk' || p.e.side === 0 || traffic.pavementNear(p.x, p.y, 12)) hash.add({ x: p.x, y: p.y, z: p.gz, r: 0.4, vx: p.vx, vy: p.vy, kind: 'person' });
    for (const o of police.officers) hash.add({ x: o.x, y: o.y, z: o.gz, r: 0.4, vx: o.vx, vy: o.vy, kind: 'person' });
    for (const o of brigade.crew) hash.add({ x: o.x, y: o.y, z: o.gz, r: 0.4, vx: o.vx, vy: o.vy, kind: 'person' });
    for (const o of ambulances.crew) hash.add({ x: o.x, y: o.y, z: o.gz, r: 0.4, vx: o.vx, vy: o.vy, kind: 'person' });
    if (inspector.person) hash.add({ x: inspector.person.x, y: inspector.person.y, z: inspector.person.gz, r: 0.4, vx: inspector.person.vx, vy: inspector.person.vy, kind: 'person' });
    const tramBodies = trams.bodies(px(), py(), LIFE_RADIUS + 100);
    for (const t of tramBodies) for (const [x, y] of t.circles) hash.add({ x, y, r: 1.25, vx: t.vx, vy: t.vy, kind: 'tram' });
    const funiBodies = funicular.bodies(px(), py(), LIFE_RADIUS + 100);
    for (const f of funiBodies) for (const [x, y] of f.circles) hash.add({ x, y, z: f.gz, r: f.line.spec.w / 2, vx: f.vx, vy: f.vy, kind: 'tram' });

    traffic.emergency = [...police.chasing, ...brigade.engines.filter((e) => e.phase === 'go' && !e.wrecked), ...ambulances.rigs.filter((r) => r.phase === 'go' && !r.wrecked)].map((e) => e.car);
    traffic.update(dt, obstacles);
    // In view or not, each car keeps track of whether it's on a bridge or under it.
    for (const a of traffic.agents) world.track(a.car);

    // Trams stop for whatever is on the track in front of them; one waiting to move
    // across to the other track at a terminus with no loop does it out of sight.
    if (ride.driving) {
      ride.drives(dt, ctl);
      const hit = ride.drive!.hit;
      ride.drive!.hit = 0;
      if (hit > 0) { shake = Math.min(1.2, shake + hit * 0.06); hapticCrash(hit); }
    }
    trams.update(dt, { near: obstacles, x: px(), y: py(), r: LIFE_RADIUS + 100, seen: (x, y) => !offscreen(x, y) });
    if (ride.on) ride.seat(walker);
    taxi.seat();
    funicular.update();
    if (funicular.me) funicular.seat(walker);
    boats.update(dt, px(), py(), ctl);
    if (boats.me) { walker.x = boats.me.x; walker.y = boats.me.y; walker.h = boats.me.h; walker.vx = walker.vy = 0; }

    const threats = [...(inCar ? [inCar] : []), ...movers.filter((c) => c.speed > 5), ...cops.filter((c) => c.speed > 5)];
    crowd.update(dt, threats, carsOnly, (x, y) => !offscreen(x, y));
    bags.update(dt, px(), py());

    // ---- Collisions ------------------------------------------------------
    // Two cars that have just met: the lamps the blow landed on break.
    const smash = (a: Car, b: Car, hit: number) => { a.knock(contact.x, contact.y, hit); b.knock(contact.x, contact.y, hit); };
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
            throwRider(b, a.vx, a.vy, closing > HURTS ? 1 : 0);
            if (a.mode !== 'police') stats.wrecked++;
            if (a === inCar) police.crime(b.type === 'police' ? 'hitCop' : 'wreck', b.x, b.y, b);
            const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
            smash(a, b, hit);
            if (a === inCar) jolt = Math.max(jolt, hit);
            if (hit > 8) { a.damage += hit - 8; b.damage += hit - 8; }
            if (a === inCar) fires.blame(b);
          } else {
            const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 0);
            smash(a, b, hit);
            if (a === inCar) jolt = Math.max(jolt, hit);
            if (a === inCar && b.type === 'police' && (a.vx * (b.x - a.x) + a.vy * (b.y - a.y)) / d > 3) police.crime('hitCop', b.x, b.y, b);
          }
          continue;
        }
        const hit = collideBodies(a, ca, a.r, 1 / a.mass, b, cb, b.r, 1 / b.mass);
        smash(a, b, hit);
        if (a === inCar || b === inCar) jolt = Math.max(jolt, hit);
        if (hit > 8) { a.damage += hit - 8; b.damage += hit - 8; }
        if (hit > 8 && a === inCar) fires.blame(b);
        else if (hit > 8 && b === inCar) fires.blame(a);
        if (hit > 6 && (a === inCar || b === inCar)) { shake = Math.min(1.2, shake + hit * 0.04); hapticCrash(hit); }
        // Driving into a police car (not them into you).
        if (a === inCar && b.mode === 'police' && hit > 2) {
          const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          if ((a.vx * (b.x - a.x) + a.vy * (b.y - a.y)) / d > 3) police.crime('hitCop', b.x, b.y, b);
        }
      }
    }
    // Trams: nothing moves one, and it shoves aside any car in its way, parked or
    // driving, instead of running over it. A car in traffic it hits leaves the traffic.
    for (const t of tramBodies) {
      const tz = { gz: t.v.levels?.[1]?.gz };
      for (const a of carsNear(t.x, t.y, 20, nearA)) {
        if (!near(a, t, 22) || apart(a, tz)) continue;
        const ca = a.circles();
        if (a.mode === 'traffic') {
          if (!touching(t.circles, ca, 1.25 + a.r)) continue;
          const d = Math.hypot(a.x - t.x, a.y - t.y) || 1;
          const closing = ((t.vx - a.vx) * (a.x - t.x) + (t.vy - a.vy) * (a.y - t.y)) / d;
          const ag = traffic.agents.find((x) => x.car === a);
          if ((closing < 1 && t.v.shove !== a) || !ag) continue; // only just touching: the car is braking for the tram
          traffic.release(ag);
          a.mode = 'loose';
          loose.push(a);
          throwRider(a, t.vx, t.vy);
          if (t.v.driven && t.v.rider) { stats.wrecked++; police.crime('wreck', a.x, a.y, a); }
        }
        const hit = collideBodies(t, t.circles, 1.25, 0, a, ca, a.r, 1 / a.mass);
        // Pushing a car off the track: ahead, and to the right, away from the other track.
        if (hit && t.v.shove === a) {
          const ang = t.v.parts[2].ang, rx = Math.sin(ang), ry = -Math.cos(ang);
          const lat = a.vx * rx + a.vy * ry;
          if (lat < SHOVE) { a.vx += rx * (SHOVE - lat); a.vy += ry * (SHOVE - lat); }
        }
        if (hit > 6 && a === inCar) { shake = Math.min(1.2, shake + hit * 0.04); hapticCrash(hit); }
        if (a === inCar) jolt = Math.max(jolt, hit);
      }
    }
    // Funicular cars: nothing moves one either.
    for (const f of funiBodies) {
      const r = f.line.spec.w / 2;
      for (const a of carsNear(f.x, f.y, f.line.spec.len / 2 + 5, nearA)) {
        if (apart(a, f)) continue;
        const hit = collideBodies(f, f.circles, r, 0, a, a.circles(), a.r, 1 / a.mass);
        if (hit > 6 && a === inCar) { shake = Math.min(1.2, shake + hit * 0.04); hapticCrash(hit); }
        if (a === inCar) jolt = Math.max(jolt, hit);
      }
    }
    if (inCar?.two && jolt > 7) throwOff();

    // People and cars
    // `onHit` returns true to let `who` in over the car rather than out of it.
    const bump = (who: { x: number; y: number; gz?: number }, rad: number, onHit: (car: Car, nx: number, ny: number, d: number) => boolean | void) => {
      for (const c of carsNear(who.x, who.y, 5, nearB)) {
        if (!near(who, c, 4) || apart(who, c)) continue;
        // The car as one rounded box (the line through its circles, as wide as they
        // are), so there's no gap between the circles to slip into; out to the nearest
        // point of its outline.
        const fx = Math.cos(c.h), fy = Math.sin(c.h), end = c.spec.L / 2 - c.r, min = c.r + rad;
        const along = clamp((who.x - c.x) * fx + (who.y - c.y) * fy, -end, end);
        const cx = c.x + fx * along, cy = c.y + fy * along;
        const d = Math.hypot(who.x - cx, who.y - cy);
        if (d >= min) continue;
        const nx = d > 1e-6 ? (who.x - cx) / d : -fy, ny = d > 1e-6 ? (who.y - cy) / d : fx;
        if (onHit(c, nx, ny, d)) continue;
        if (!grid.at(cx + nx * min, cy + ny * min)) { who.x = cx + nx * min; who.y = cy + ny * min; }
      }
    };
    // Nobody walks through a tram or a funicular car: out to the nearer side (knocked over if it's moving).
    const closeTrams = tramBodies.filter((t) => near(t, { x: px(), y: py() }, 150));
    const open = (x: number, y: number) => !grid.at(x, y);
    const offTrams = (who: { x: number; y: number; gz?: number }, rad: number, free: (x: number, y: number) => boolean, onHit?: (vx: number, vy: number, driven: boolean) => void) => {
      for (const t of closeTrams) {
        if (!near(who, t, 18)) continue;
        const n = pushOutOfTram(t, who, rad, free);
        if (n && onHit && t.vx * n[0] + t.vy * n[1] > 2) onHit(t.vx + n[0] * 2, t.vy + n[1] * 2, !!t.v.driven && !!t.v.rider);
      }
      // (And out of a funicular car; knocked over if it's coming at them.)
      const f = funiBodies.length ? funicular.pushOut(who, rad, free) : null;
      if (f && onHit && f.c.vx * f.nx + f.c.vy * f.ny > 1) onHit(f.c.vx + f.nx * 2, f.c.vy + f.ny * 2, false);
    };
    for (const p of crowd.people) {
      if (!near(p, { x: px(), y: py() }, 120)) continue;
      offTrams(p, 0.3, open, (vx, vy, yours) => {
        // Run down by the tram you're driving.
        if (!yours || p.state === 'down') return;
        crowd.knock(p, vx, vy, 2);
        stats.knocked++;
        police.crime('knock', p.x, p.y);
      });
      bump(p, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && p.state !== 'down' && c.mode !== 'traffic') {
          crowd.knock(p, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2, c.speed > HURTS * 1.5 ? 2 : c.speed > HURTS ? 1 : 0);
          c.vx *= 0.93;
          c.vy *= 0.93;
          stats.knocked++;
          if (c === inCar) police.crime('knock', p.x, p.y);
        }
      });
    }
    for (const o of police.officers) {
      offTrams(o, 0.3, open);
      bump(o, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && o.down <= 0) {
          police.knock(o, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
          if (c === inCar) police.crime('hitCop', o.x, o.y);
        }
      });
    }
    for (const m of ambulances.crew) {
      offTrams(m, 0.3, open);
      bump(m, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && m.down <= 0) ambulances.knock(m, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
      });
    }
    for (const f of brigade.crew) {
      offTrams(f, 0.3, open);
      bump(f, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && f.down <= 0) brigade.knock(f, c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
      });
    }
    const ip = inspector.person;
    if (ip) {
      offTrams(ip, 0.3, open);
      bump(ip, 0.3, (c, nx, ny) => {
        if (c.speed > 3 && ip.down <= 0) {
          inspector.knock(c.vx * 0.9 + nx * 2, c.vy * 0.9 + ny * 2);
          if (c === inCar) police.crime('knock', ip.x, ip.y);
        }
      });
    }
    if (!inCar && !inHeli && !ride.on && !getIn.active && !arrest.active) {
      offTrams(walker, 0.35, (x, y) => !walker.blocked(x, y), (vx, vy) => {
        if (walker.down <= 0) { walker.knock(vx, vy); hurt(Math.hypot(vx, vy) * 2.5); shake = 0.8; }
      });
      // Standing on a car that drives off: it carries you round with it, until it's
      // going too fast to keep your feet and throws you off to the side.
      if (onCar && walker.down <= 0 && walker.perch > 0.3) {
        const { c } = onCar, dh = c.h - onCar.h, cs = Math.cos(dh), sn = Math.sin(dh);
        const rx = walker.x - onCar.x, ry = walker.y - onCar.y;
        const x = c.x + rx * cs - ry * sn, y = c.y + rx * sn + ry * cs;
        if (!walker.blocked(x, y)) { walker.x = x; walker.y = y; }
        walker.h += dh;
        if (c.speed > 8) {
          const lx = -Math.sin(c.h), ly = Math.cos(c.h), side = (walker.x - c.x) * lx + (walker.y - c.y) * ly >= 0 ? 1 : -1;
          walker.knock(c.vx * 0.6 + side * lx * 3, c.vy * 0.6 + side * ly * 3);
          shake = 0.6;
        }
      }
      // Jump at a car that's standing still (or step across from one you're already on)
      // and you scramble up onto it, over its bonnet, roof or boot, and drop off the far
      // side. Not bikes and motorbikes, and you can't jump onto one that's moving.
      let top = 0, under: Car | null = null;
      bump(walker, 0.35, (c, nx, ny, d) => {
        if (!c.two && walker.down <= 0 && (c.speed < 2 ? walker.jumping || walker.perch > 0.3 : c === onCar?.c && walker.perch > 0.3)) {
          if (d < c.r) {
            const t = c.topAt(walker.x, walker.y);
            if (t > top) { top = t; under = c; }
          }
          return true;
        }
        if (c.speed > 4 && walker.down <= 0 && !walker.airborne) { walker.knock(c.vx + nx * 2, c.vy + ny * 2); hurt(c.speed * 2.5); shake = 0.6; }
      });
      // Up quickly, down as fast as you'd drop.
      walker.perch = top > walker.perch ? walker.perch + (top - walker.perch) * Math.min(1, dt * 14) : Math.max(top, walker.perch - dt * 5);
      const u = under as Car | null;
      onCar = u && walker.down <= 0 ? { c: u, x: u.x, y: u.y, h: u.h } : null;
      walker.sync();
    } else onCar = null;

    // Cars smoking, burning and blowing up (the ones that could have been hurt this step).
    fires.update(dt, active, { x: camPos.x, y: -camPos.z, r: viewRadius() + 40 });

    // Keep life around the player: traffic and people follow you, far ones are recycled.
    lifeT -= dt;
    if (lifeT < 0) {
      lifeT = 0.5;
      if (pavementDrivers.update(0.5, loose, px(), py(), (x, y) => !offscreen(x, y), (x, y) => grid.at(x, y) !== 0)) restingStale = true;
      // (And cars stuck in a queue that hasn't moved for a while, and buses that have
      // left their line, where nobody sees them go.)
      for (const a of [...traffic.agents]) if (!a.hired && (a.jam > 30 || a.bus?.lost || Math.hypot(a.car.x - px(), a.car.y - py()) > LIFE_RADIUS * 1.3) && offscreen(a.car.x, a.car.y)) traffic.release(a);
      // When the roads empty (evening, time moved on), a few of the surplus cars leave
      // each round, out of sight, so the traffic thins out rather than vanishing.
      let surplus = Math.min(3, traffic.agents.length - trafficWanted(clock.t));
      for (const a of [...traffic.agents]) {
        if (surplus <= 0) break;
        if (a.hired || a.car.type === 'bus' || a.car.type === 'minibus' || a.car.type === 'police' || !offscreen(a.car.x, a.car.y)) continue;
        traffic.release(a);
        surplus--;
      }
      for (let i = loose.length - 1; i >= 0; i--) {
        const c = loose[i];
        const d = Math.hypot(c.x - px(), c.y - py());
        if (!tileCars.has(c) && d > 600) { loose.splice(i, 1); continue; }
        // A wreck, or a car somebody left in the street, is towed once it has stood out of
        // sight for a minute, so it doesn't block the traffic for good.
        if (c.two || c.share || c === inCar || c.speed > 0.5 || !(c.damage > 0 || !tileCars.has(c)) || d < 40 || !offscreen(c.x, c.y)) { standing.delete(c); continue; }
        const waited = (standing.get(c) ?? 0) + 0.5;
        standing.set(c, waited);
        if (waited > TOW_AFTER) { loose.splice(i, 1); tileCars.delete(c); standing.delete(c); restingStale = true; }
      }
      scatterPeople(true);
      parkTwoWheelers(true);
      bikeShare.update(px(), py(), clock.t, bikeWorld);
      bikeShare.charge(clock.t, (n) => wallet.take(n, 'shared bike'));
      for (const { rental, fee } of bikeShare.abandon(px(), py(), clock.t)) {
        showBanner(t('You left the {name} bike outside a station: fee {price}', { name: rental.system.name, price: kc(wallet.take(fee, 'shared bike left outside a station')) }), true);
      }
    }
    // New traffic out of sight, a few times a second rather than every step (finding
    // the streets around you and a spot on them takes a while).
    spawnT -= dt;
    const wanted = trafficWanted(clock.t);
    if (spawnT < 0 && traffic.agents.length < wanted) {
      spawnT = 0.25;
      const edges = edgesNear(px(), py(), LIFE_RADIUS), ok = lifeSpots(px(), py(), 40);
      traffic.buses((x, y) => offscreen(x, y) && ok(x, y), edges, BUSES);
      const sampler = traffic.prepareSpawn(edges);
      for (let n = 0; n < 10 && traffic.agents.length < wanted; n++) if (!traffic.spawn((x, y) => offscreen(x, y) && ok(x, y), edges, null, sampler)) break;
    }
  };

  // Every kind of ground's shader, compiled before the game starts.
  {
    const samples = groundSamples(time);
    // (And the metro's tunnels and train, for the first ride.)
    scene.add(samples.group, metro.under.group);
    // The facade pictures must be in first: on WebGPU a building that doesn't move binds
    // its textures once, so tiles compiled here would keep the black stand-in.
    status('Preparing the view…');
    await loadFacadeAtlas();
    // Keep tree variants prepared while warming the car meshes and scene.
    const releaseTreeReserve = world.trees.prepare([30, 20, 24]);
    try {
      // Give the already-started optional bike feed a short chance to supply its
      // operator colours; a slow or missing feed must never hold the loading screen.
      await Promise.race([bikeShare.ready, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
      carPool.prepare(ordinaryCarBodies(bikeShare.colours()));
      await carPool.warm(() => renderer.compileAsync(scene, camera)).catch((e) => console.warn(e));
      // compileAsync prepares the main view, while tree shadows get their own
      // renderer pass. Draw once behind the loading screen with every retained
      // page visible, then hide the empty reserve again.
      renderer.render(scene, camera);
    } finally { releaseTreeReserve(); }
    scene.remove(samples.group);
    metro.under.hide();
    samples.dispose();
  }
  const loadMs = performance.now(); // the map is ready; what follows waits for the player
  let resumed = false;
  if (start) {
    status('');
    const choice = await start.ready();
    if (choice.resume && saved) {
      resumed = true;
      status('Building the streets…');
      await resume(saved);
      status('');
    } else {
      // "Now" is the time now, not the time the page was opened at.
      if (choice.time === null && !params.has('time') && !params.has('night')) clock.t = new Clock(params).t;
      else if (choice.time !== null) clock.setTime(choice.time);
      world.night = params.has('night') || clock.night;
      season.set(choice.season);
      weather.begin(choice.weather, clock.t, choice.live);
      // Beta mist can only reach this choice through an explicit selection.
      if (choice.weather === 'mist') weather.fixed = true;
    }
    if (sound.on !== choice.sound) sound.toggle();
    playing = true;
    last = performance.now();
  }
  $('loading').classList.add('done');
  // The real weather, when the game began with it: asked for again now and then, and the
  // game's weather follows it over a few minutes, until the player picks one by hand.
  setInterval(() => {
    if (weather.live && !weather.fixed && !document.hidden) void liveWeather().then((k) => { if (k) weather.follow(k); });
  }, LIVE_EVERY * 1000);
  // ?dialog plays a sample conversation, to see how one looks.
  if (params.has('dialog')) void dialog.play([
    { who: 'marek', name: 'Marek', text: 'Come around the back. Don’t use the main entrance. I’ll be waiting by the tram stop.', objective: 'Meet Marek behind the block' },
    { who: 'policewoman', name: 'Officer Nováková', text: 'You there. Seen a man in a green jacket come this way?' },
  ]);

  graphics.started(performance.now());
  // Anonymous statistics (src/telemetry.ts): what the game runs on, then once a frame
  // how long it took and what you're doing, added up there.
  telemetry.begin({
    renderer: gpuBackend ? (gpuBackend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2') : 'WebGL (legacy)',
    graphics: graphics.choice, tier: graphics.tier, lang: getLang(), touch: touch.active, resumed, loadMs,
  });
  telemetry.summary(() => ({ ...stats, money: wallet.balance }));
  wallet.onSpend = telemetry.spent;
  let starsWas = 0;
  const playingAs = (): telemetry.Mode => (ride.on ? 'tram' : taxi.riding ? 'taxi' : inCar ? 'car' : inHeli || boats.me || funicular.me || metro.active ? 'other' : 'foot');

  const grab: ((picture: string | null) => void)[] = [];
  const takePicture = () => {
    try {
      const from = renderer.domElement, scale = Math.min(1, 1280 / from.width);
      const to = document.createElement('canvas');
      to.width = Math.round(from.width * scale);
      to.height = Math.round(from.height * scale);
      const draw = to.getContext('2d')!;
      draw.globalCompositeOperation = 'copy'; // the canvas has an alpha channel that must not show through
      draw.drawImage(from, 0, 0, to.width, to.height);
      return to.toDataURL('image/jpeg', 0.72);
    } catch { return null; }
  };
  setScreenshot(() => new Promise((resolve) => { grab.push(resolve); setTimeout(() => resolve(null), 2000); }));
  renderer.setAnimationLoop((now) => {
    if (benchPause.paused) { last = now; return; } // a benchmark elsewhere on this machine (dev only)
    const dt = settingsPanel.open ? 0 : Math.min(0.05, (now - last) / 1000); // the settings pause the game
    graphics.frame(now - last, now, world.busy);
    telemetry.tick(now - last, dt, playingAs(), px(), py(), graphics.choice, graphics.tier);
    telemetry.most('maxStars', police.stars);
    if (police.stars !== starsWas) { if (police.stars > starsWas) telemetry.did(`wanted: ${police.stars} ${police.stars === 1 ? 'star' : 'stars'}`); starsWas = police.stars; }
    // Things that last, counted each time they begin.
    telemetry.doing('honked', hornHeld);
    telemetry.doing('used lane assist', assisted);
    telemetry.doing('sprayed the water cannon', !!cannon.jet && !!inCar);
    telemetry.doing('took over a tram', ride.driving);
    telemetry.doing('rode in a taxi', taxi.riding);
    telemetry.doing('called a taxi', taxi.state === 'coming');
    telemetry.doing('rode without a ticket', pid.state === 'dodging' || metro.dodging);
    telemetry.doing('sped up a ride or a wait', waitScale > 1.5 || ((ride.on || !!funicular.me || taxi.riding) && (input.run || touch.fast)));
    last = now;
    time.value += dt;
    wallet.update(dt);
    if ((saveT += dt) > 5) { saveT = 0; autosave(); }
    pid.update(dt);
    // The city lives well beyond the screen; only the tiles near it are drawn.
    // (The developer panel's free camera can look far across the city: everything is drawn.)
    // Zooming out, the tiles the view is about to take in are drawn before it gets there.
    world.update(camPos.x, -camPos.z, viewRadius() + 220, testkit?.cam ? Infinity : viewRadius(Math.max(height, heightWanted)) + world.drawBeyond);

    // Player: keyboard and touch controls together. In the car, Shift is lane assist:
    // it steers along your lane, and A/D picks the turn at the next junction instead.
    const ctl = {
      move: touch.move || pad.move || (input.up ? 1 : 0) - (input.down ? 1 : 0),
      turn: touch.turn || pad.turn || (input.left ? 1 : 0) - (input.right ? 1 : 0),
      run: input.run || touch.run,
      brake: input.brake || touch.brake,
      jump: input.jump,
      aim: touch.aim || pad.aim,
    };
    // On a tram, Shift speeds up the ride: the whole world runs faster, in steps short
    // enough for the physics.
    // At a tram stop, hold Space to wait: the same speed-up, until a tram is close.
    board.update(dt, walker.x, walker.y, !ride.on && !inCar && !inHeli);
    // (The same waiting for a taxi on its way.)
    const waiting = (!!board.shown && board.next > 8 || taxi.state === 'coming') && (input.brake || touch.fast);
    waitScale += ((waiting ? FAST * 2 : 1) - waitScale) * Math.min(1, dt * (waiting ? 1.5 : 4));
    if (Math.abs(waitScale - (waiting ? FAST * 2 : 1)) < 0.02) waitScale = waiting ? FAST * 2 : 1;
    taxi.update(dt);
    const scale = ride.on ? ride.speedUp(dt, ctl.run || touch.fast) : funicular.me ? funicular.speedUp(dt, ctl.run || touch.fast) : taxi.riding ? taxi.speedUp(dt, ctl.run || touch.fast) : waitScale;
    // (The developer panel can pause the world or slow it down.)
    const run = testkit?.paused ? 0 : scale * (testkit?.speed ?? 1);
    const steps = metro.active ? 0 : Math.ceil(run - 1e-6); // underground, the street waits
    for (let i = 0; i < steps; i++) simulate((dt * run) / steps, ctl);
    weather.update(dt * run, clock.t, dt);
    input.jump = false;
    // A ticket that runs out while you ride gives you a moment to buy another.
    const ticketNow = wallet.hasTicket(clock.t);
    if (ticketWas && !ticketNow && ((ride.on && !ride.driving) || funicular.me)) pid.board(clock.t);
    ticketWas = ticketNow;
    if (ride.on) ride.watch(dt);
    // Ticket inspections: at a stop you've ridden to (not the one you got on at), and at
    // a funicular station. The tram waits for your answer; the funicular doesn't.
    if (ride.on) {
      const at = ride.atStop();
      if (rideAt !== null && at && !rideAt && pid.check(CHECK_STOP, Math.random())) inspector.start('tram');
      rideAt = at;
      ride.v!.hold = inspector.phase === 'decide' && inspector.where === 'tram';
    } else rideAt = null;
    if (funicular.me) {
      const stop = funicular.me.stop;
      if (funiAt !== undefined && funiAt === null && stop !== null && pid.check(CHECK_STOP, Math.random())) inspector.start('funicular');
      funiAt = stop;
      if (inspector.phase === 'decide' && inspector.where === 'funicular' && stop === null) inspector.pay();
    } else funiAt = undefined;
    if (ride.on && ride.arrived() && inspector.phase !== 'decide') getOff();
    if (police.stars === 0 && inspector.owed) inspector.owed = 0;
    trams.sync(camPos.x, -camPos.z, viewRadius() + 150, ground);
    metro.update(dt);
    metro.sync(camPos.x, -camPos.z, viewRadius() + 60, ground);
    tramStops.sync(camPos.x, -camPos.z, viewRadius() + 60, ground);
    crowd.render(ground, (x, y) => !offscreen(x, y));
    police.render(ground, time.value);
    {
      const chasing = police.lit(inCar), engines = brigade.lit, rescue = ambulances.lit;
      flashing.length = 0;
      for (const car of chasing) flashing.push({ car, reach: 19, rate: 1.4 });
      for (const car of engines) flashing.push({ car, reach: 24, rate: 1.2 });
      for (const car of rescue) flashing.push({ car, reach: 18, rate: 1.6 });
      beacons.draw([...chasing, ...engines, ...rescue], ground, time.value, sky.dark);
    }
    brigade.render();
    ambulances.render();
    inspector.render(ground);
    tracers.update(dt);
    // Only the cars in view (and a little round it, for their shadows) are drawn.
    drawn.length = 0;
    {
      const cx = camPos.x, cy = -camPos.z, r = viewRadius() + 12;
      const see = (c: Car) => {
        if (Math.abs(c.x - cx) < r && Math.abs(c.y - cy) < r) drawn.push(c);
        else c.lastH = undefined; // so a bike coming back into view doesn't lean at once
      };
      if (inCar) drawn.push(inCar);
      loose.forEach(see);
      for (const a of traffic.agents) see(a.car);
      for (const p of police.cars) see(p.car);
      for (const e of brigade.engines) see(e.car);
      for (const r of ambulances.rigs) see(r.car);
    }
    carPool.render(drawn, ground, dt);
    skids.update(dt * scale, drawn, ground);
    steerGuide.update(dt, inCar, inCar && guideOn ? held : null, (x, y) => ground(x, y, inCar), clamp(height / 120, 1, 3));
    spray.update(dt * scale, drawn, ground, renderer.domElement.height);
    water.update(dt * scale, cannon.jet ? [...brigade.jets, cannon.jet] : brigade.jets, renderer.domElement.height);
    for (const c of choppers) c.render(dt);
    surfaceT -= dt;
    if (inCar && surfaceT < 0) { surfaceT = 0.2; surface = surfaceUnder(inCar.x, inCar.y); }
    busyT -= dt;
    if (busyT < 0) { busyT = 0.5; busy = clamp(footfall.around(px(), py(), 150) / 0.2, 0, 1); }
    if (hornHeld && !inCar && !ride.driving) honk(false);
    if (hornHeld && (hornT -= dt) < 0) { hornT = 0.5; scareAhead(); }
    sound.update(dt, { x: px(), y: py(), car: inCar, throttle: ctl.move, surface, trams: trams.list, quiet: metro.active, rain: weather.now.rain, wet: weather.now.wet, snow: weather.now.snow, strikes: weather.now.strikes, busy, hour: (clock.t % 86400) / 3600, season, aloft: inHeli ? clamp((inHeli.air - 5) / 40, 0, 1) : 0, sirens: [
      ...police.chasing.map((p) => ({ key: p, kind: 'police' as const, x: p.car.x, y: p.car.y, vx: p.car.vx, vy: p.car.vy })),
      ...brigade.engines.filter((e) => e.phase === 'go' && !e.wrecked).map((e) => ({ key: e, kind: 'fire' as const, x: e.car.x, y: e.car.y, vx: e.car.vx, vy: e.car.vy })),
      ...ambulances.rigs.filter((r) => r.phase === 'go' && !r.wrecked).map((r) => ({ key: r, kind: 'ambulance' as const, x: r.car.x, y: r.car.y, vx: r.car.vx, vy: r.car.vy })),
    ] });

    // ---- Camera ----------------------------------------------------------
    const vehicle = inCar || inHeli, sp = vehicle ? vehicle.speed : 0;
    // On the metro, over the train as it goes (see Metro.view).
    const underway = metro.view();
    // In the air the camera rises with the helicopter, so it stays well above it.
    const want = (underway ? underway.height : inHeli ? 130 + sp * 2.5 : inCar ? 120 + sp * 3.4 : ride.driving ? 120 + (ride.v?.speed ?? 0) * 3.4 : ride.on ? 125 + (scale - 1) * 12 : 100) * zoom + (inHeli ? inHeli.air : 0);
    heightWanted = want;
    height += (want - height) * Math.min(1, dt * (want > height ? 1.6 : 0.9));
    const lead = underway ? 0.25 : vehicle || ride.driving ? 0.7 : ride.on ? 0.5 : 0.3;
    if (underway) look.set(underway.x + underway.vx * lead, 0, -(underway.y + underway.vy * lead));
    else look.set(px() + (vehicle || walker).vx * lead, 0, -(py() + (vehicle || walker).vy * lead));
    camPos.lerp(look, Math.min(1, dt * 4));
    shake *= Math.exp(-6 * dt);
    const jx = (Math.random() - 0.5) * shake * 2, jz = (Math.random() - 0.5) * shake * 2;
    // Follow the ground under the view, smoothed so the camera doesn't bob over kerbs.
    // In a tunnel, the ground above it: the view looks down into the tunnel through
    // the hole round you (below), deep as it may be.
    // (On the metro, the ground above the train: see Metro.view.)
    const body = inHeli || underway ? null : inCar || walker;
    const deep = !!body && world.track(body) < 0;
    const below = underway ? underway.ground
      : deep ? Math.max(world.terrainAt(px(), py()), body.gz ?? 0) : ground(camPos.x, -camPos.z, body);
    camGround += (below - camGround) * Math.min(1, dt * 3);
    const free = testkit?.cam;
    if (free) {
      // The developer panel's free camera: tilted back from the spot it looks at.
      camPos.set(free.x, 0, -free.y);
      camGround = world.terrainAt(free.x, free.y);
      const hd = ((90 - free.heading) * Math.PI) / 180, back = free.height * Math.tan((free.tilt * Math.PI) / 180);
      camera.position.set(free.x - Math.cos(hd) * back, camGround + free.height, -(free.y - Math.sin(hd) * back));
      camera.lookAt(free.x, camGround, -free.y);
    } else {
      camera.position.set(camPos.x + jx, camGround + height, camPos.z + jz);
      camera.lookAt(camPos.x + jx, camGround, camPos.z + jz);
    }

    // In a passage under a building, open a hole in the floors above so you stay in view.
    // The same under a bridge, and a wider one down into a tunnel.
    const under = !inHeli && (world.passageAt(px(), py()) || (!!body && world.covered(body)));
    // (The deeper the tunnel, the wider: the view is from above the ground.)
    // On the metro, the hole goes with the train, down to its tunnel.
    const hole = underway ? underway.r : deep && body ? tunnelHole(world.terrainAt(px(), py()) - (body.gz ?? 0)) : 9;
    cutR += ((under || underway ? hole : 0) - cutR) * Math.min(1, dt * 6);
    const [hx, hy] = underway ? [underway.x, underway.y] : [px(), py()];
    CUTAWAY.value.set(hx, (underway ? underway.floor : ground(px(), py(), body)) + 2.5, -hy, cutR > 0.3 ? cutR : 0);
    DIG.value.set(hx, -hy, (deep || underway) && cutR > 0.3 ? cutR : 0, 0);

    sun.target.position.set(camPos.x, camGround, camPos.z);
    sky.update(clock.t % 86400, weather.now, height, season.day);
    sun.position.copy(sun.target.position).add(sky.offset);
    fitShadow();
    // Street lamps and headlights, and the rain, snow and mist round the view.
    {
      // Looking straight down, the light map covers what's in view; the free camera sees further.
      const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      lightOpt.box = free ? undefined : [height * tan * camera.aspect + 6, height * tan + 6];
      lightOpt.time = time.value;
      police.helis.night = sky.dark;
      lightOpt.spots = police.helis.lit;
      lightOpt.wet = weather.now.wet;
      lightOpt.murk = sky.murk;
      lamps.update(camPos.x, -camPos.z, viewRadius() + 10, sky.dark, drawn, ground, now, trams.list, lightOpt);
    }
    signals.update(camPos.x, -camPos.z, viewRadius() + 10, now);
    weatherFx.tint.value.copy(sky.tint);
    weatherFx.fog.value.copy(sky.haze);
    weatherFx.update(weather.now, time.value, camPos.x, -camPos.z, camGround, height, viewRadius(), renderer.getPixelRatio(), mistGround, mistWater);

    // ---- HUD -------------------------------------------------------------
    // (On the metro, the street the train is under; on a funicular, its name.)
    const name = underway ? names.at(underway.x, underway.y) : funicular.me ? funicular.me.line.spec.name : names.at(px(), py());
    if (name && name !== street) {
      street = name;
      $('street').textContent = name;
    }
    const carName = inCar ? (inCar.variant ? variantName(inCar.variant) : t(VEHICLE_NAMES[inCar.type] ?? inCar.type)) : '';
    if (carName !== carShown) {
      carShown = carName;
      const box = $('vehicle');
      box.textContent = carName;
      box.hidden = !carName;
    }
    bannerT -= dt;
    show('banner', clamp(bannerT, 0, 1), 'opacity');
    if (underway) districts.hide();
    else districts.update(dt, px(), py(), bannerT > 0);
    show('speed', String(inCar ? Math.round(Math.abs(inCar.forwardSpeed) * 3.6) : inHeli ? Math.round(inHeli.speed * 3.6)
      : ride.on ? Math.round((ride.v?.speed ?? 0) * 3.6) : funicular.me ? Math.round(Math.hypot(funicular.me.vx, funicular.me.vy) * 3.6) : taxi.riding ? Math.round((taxi.agent?.speed ?? 0) * 3.6) : '–'));
    if (sound.radio) {
      const near = !inCar && !inHeli && !ride.on && [...carsNear(walker.x, walker.y, 25)].some((c) => !c.two && !c.burnt && c.gap(walker.x, walker.y) < 20);
      const lc = sound.radio.lingering as Car | null;
      sound.radio.warm(near, dt, !!lc && lc.gap(walker.x, walker.y) < 30);
    }
    const radio = inCar && !inCar.two ? sound.radio : null;
    const radioText = radio ? radio.station?.name ?? t('Radio off') : '';
    if (radioText !== radioShown) {
      radioShown = radioText;
      const box = $('radio');
      box.hidden = !radio;
      const name = box.querySelector('select')!;
      name.value = String(radio?.station ? STATIONS.indexOf(radio.station) : -1);
      name.classList.toggle('off', !radio?.station);
    }
    if (clock.label() !== clockShown) $('clock').textContent = clockShown = clock.label();
    // On a touch screen the buttons say what they do, so the hint only reports lane assist.
    const canBoard = !inCar && !inHeli && !ride.on && !metro.active && ride.boardable(walker.x, walker.y);
    const station = !inCar && !inHeli && !ride.on && !metro.active ? metro.near(walker.x, walker.y) : null;
    const gap = (c: Car) => c.gap(walker.x, walker.y);
    const enterable = !inCar && !inHeli && !ride.on
      ? [...carsNear(walker.x, walker.y, 5)].filter((c) => gap(c) < 1.8 && !c.burnt && !apartOnFoot(c)).sort((a, b) => gap(a) - gap(b))[0]
      : undefined;
    const boat = !inCar && !inHeli && !ride.on && !boats.me ? boats.near(walker.x, walker.y, world.groundFor(walker, walker.x, walker.y) + walker.z + walker.perch) : null;
    const onFoot = !inCar && !inHeli && !ride.on && !metro.active && !boats.me && !taxi.riding;
    const cabin = onFoot ? funicular.near(walker.x, walker.y) : null;
    const shut = onFoot && !cabin ? funicular.near(walker.x, walker.y, true) : null;
    const canEnter = !inCar && !inHeli && !ride.on && !metro.active && (!!enterable || !!boat || choppers.some((c) => c.landed && Math.hypot(c.x - walker.x, c.y - walker.y) < 4));
    const getIn = t(enterable?.two ? '<b>E</b> get on' : !enterable && boat ? (boat.kind === 'swan' ? '<b>E</b> get in the swan' : '<b>E</b> get in the pedal boat') : '<b>E</b> get in');
    const ticketHint = () => pid.state === 'grace'
      ? `${touch.active ? t('Buy a ticket ({price})', { price: kc(TICKET.price) }) : usingPad() ? `<b>B</b> ${t('Buy a ticket ({price})', { price: kc(TICKET.price) })}` : TICKETS.map((k, i) => `<b>${i + 1}</b> ${validity(k.minutes)} ${kc(k.price)}`).join(' · ')} · ${t('{secs} s left', { secs: Math.ceil(pid.left) })}`
      : pid.state === 'dodging' ? t('No ticket') : '';
    let hint = '';
    if (metro.active) hint = '';
    else if (inHeli) {
      const up = t('{n} m up', { n: Math.round(inHeli.air) });
      if (touch.active) hint = inHeli.landed ? '' : up;
      else hint = inHeli.landed ? t('<b>Space</b> take off · <b>E</b> get out') : `${up} · ${t('<b>Space</b> climb · <b>Shift</b> down · land to get out')}`;
    } else if (inCar) {
      if (!assisted) hint = touch.active ? '' : inCar.type === 'fire' ? t('<b>E</b> get out · <b>F</b> water cannon · <b>Shift</b> lane assist') : t(inCar.two ? '<b>E</b> get off · <b>Shift</b> lane assist' : '<b>E</b> get out · <b>Shift</b> lane assist');
      // While the assist is on, the panel stays empty so it doesn't grow.
    }
    else if (boats.me) hint = touch.active ? '' : t('<b>W</b>/<b>S</b> pedal · <b>A</b>/<b>D</b> turn · <b>E</b> get out by the bank');
    else if (funicular.me) hint = [funicular.hint(touch.active, scale), ticketHint()].filter(Boolean).join(' · ');
    else if (ride.driving) {
      const d = ride.drive!, parts: string[] = [];
      if (touch.active) { if (d.junction < 400 && d.options.length > 1) parts.push(t('Junction in {m} m', { m: Math.max(0, Math.round(d.junction / 10) * 10) })); }
      else {
        parts.push(t('<b>W</b> drive · <b>S</b> brake · <b>Q</b> bell'));
        if (ride.atName) parts.push(ride.passengers?.doors ? t('<b>X</b> close the doors') : t('<b>X</b> open the doors'));
        if (d.junction < 400 && d.options.length > 1) parts.push(t('<b>A</b>/<b>D</b> pick the way at the junction'));
        parts.push(ride.canLeave() ? t('<b>E</b> get off') : t('stop to get off'));
      }
      hint = parts.join(' · ');
    } else if (ride.on) {
      const halts = ride.v!.line.halts, dest = ride.dest !== null ? halts[ride.dest].name : null;
      const next = ride.dest !== null && ride.dest === ride.upcoming()[0];
      const parts = [];
      if (ride.waiting) parts.push(t('The streets ahead are still loading'));
      else if (scale > 1.5) parts.push(t('{n}× speed', { n: Math.round(scale) }));
      if (dest) parts.push(t(next ? 'Getting off at {name}' : 'Riding to {name}', { name: dest }));
      if (!touch.active) {
        if (ride.atStop()) parts.push(t('<b>E</b> get off'));
        else if (ride.stuck) parts.push(t('<b>E</b> get off here'));
        else if (!next) parts.push(t('<b>E</b> get off at the next stop'));
        if (!dest) parts.push(t('<b>W</b>/<b>S</b> pick a stop'), t('hold <b>Shift</b> to speed up'));
        parts.push(t('<b>F</b> take over the tram'));
      }
      parts.push(ticketHint());
      hint = parts.filter(Boolean).join(' · ');
    } else if (canBoard && !touch.active) hint = t('<b>E</b> get on the {line} to {name}', { line: canBoard.line.ref, name: ride.headsign(canBoard) });
    else if (station && !touch.active) hint = t('<b>E</b> take the metro from {name}', { name: station.name });
    else if ((cabin && !touch.active) || shut) hint = funicular.offer((cabin || shut)!);
    else if (board.shown) {
      const wait = waitScale > 1.5 ? t('Waiting for a tram · {n}× speed', { n: Math.round(waitScale) }) : touch.active ? '' : t('Hold <b>Space</b> to wait for a tram');
      hint = [canEnter && !touch.active ? getIn : '', wait].filter(Boolean).join(' · ');
    } else if (canEnter && !touch.active) hint = getIn;
    if (onFoot && !cabin && !shut && !board.shown && !touch.active) {
      const lying = !bags.carried && bags.near(walker.x, walker.y);
      if (lying && (!enterable || lying.d <= gap(enterable))) hint = t('<b>E</b> pick up the bag');
      else if (bags.carried && !canEnter) hint = t('<b>E</b> put the bag down');
    }
    hint = (!inCar && !inHeli && !ride.on && !funicular.me && taxi.hint(touch.active, usingPad())) || hint;
    const bikeRental = (c: Car) => {
      const rental = bikeShare.rental(c);
      return rental && { name: rental.system.name, minutes: String(Math.max(1, Math.round((((clock.t - rental.since) % 604800) + 604800) % 604800 / 60))), price: kc(rental.paid) };
    };
    if (inCar && !inHeli) {
      const b = bikeRental(inCar);
      if (b && !assisted) hint = [t('{name} bike: {minutes} min, {price} so far', b), hint].filter(Boolean).join(' · ');
    } else if (!inHeli && !ride.on && !funicular.me && !taxi.riding) {
      for (const c of loose) {
        const b = c.share && bikeRental(c);
        if (b) { hint = [t('Your {name} bike is still rented: {minutes} min, {price} so far', b), hint].filter(Boolean).join(' · '); break; }
      }
    }
    if (inspector.phase === 'decide') hint = touch.active ? t('Ticket inspection! Pay the fine ({fine}) or get off and run · {secs} s', { fine: kc(FINE), secs: Math.ceil(inspector.left) }) : t('Ticket inspection! <b>B</b> pay the fine ({fine}) · <b>E</b> get off and run · {secs} s', { fine: kc(FINE), secs: Math.ceil(inspector.left) });
    taxi.render(touch.active, usingPad());
    show('hint', padLabels(hint), 'html');
    $('help').dataset.mode = inHeli ? 'heli' : inCar ? 'car' : ride.driving ? 'drive' : ride.on ? 'tram' : funicular.me ? 'funicular' : 'foot';
    $('help-pad').dataset.mode = $('help').dataset.mode;
    ride.render();
    const label = ride.driving ? (ride.canLeave() ? 'Get off' : null) : ride.on ? (ride.atStop() ? 'Get off' : ride.stuck ? 'Get off here' : ride.dest === ride.upcoming()[0] ? 'Stop requested' : 'Request stop') : funicular.me ? (funicular.me.stop !== null ? 'Get off' : null) : canBoard || cabin || enterable?.two ? 'Get on' : inCar?.two ? 'Get off' : null;
    const cab = taxi.riding ? 'Get out' : taxi.near() ? 'Get in' : null;
    const ticketBtn = inspector.phase === 'decide' ? 2 : pid.state === 'grace' ? 1 : 0;
    if (shown.ticketBtn !== ticketBtn) {
      shown.ticketBtn = ticketBtn;
      $('t-ticket').hidden = !ticketBtn;
      $('t-ticket').textContent = t(ticketBtn === 2 ? 'Pay the fine' : 'Buy a ticket');
    }
    touch.update({ car: inCar || inHeli, engine: inCar?.type === 'fire', driving: ride.driving, tram: (ride.on && !ride.driving) || taxi.riding || !!funicular.me, wait: !!board.shown || taxi.state === 'coming', label: cab || label || (station ? 'Metro' : null), canEnter: !!cab || canEnter || !!canBoard || !!station || !!cabin || funicular.me?.stop != null, limit: assisted ? assist.limit : null });
    show('tally', `${tn(stats.wrecked, '{n} car wrecked|{n} cars wrecked')} · ${tn(stats.knocked, '{n} person knocked over|{n} people knocked over')}${stats.busted ? ` · ${t('busted {n}×', { n: stats.busted })}` : ''}${stats.wasted ? ` · ${t('wasted {n}×', { n: stats.wasted })}` : ''}`);
    // Wanted stars: they blink while the police have lost sight of you.
    const stars = police.stars, wanted = $('wanted');
    const face = `${getLang()}|${stars}|${stars && !police.seen}`;
    if (wanted.dataset.face !== face) {
      wanted.dataset.face = face;
      wanted.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span${i <= stars ? ' class="on"' : ''}>★</span>`).join('');
      wanted.classList.toggle('hidden', stars === 0);
      wanted.classList.toggle('blink', stars > 0 && !police.seen);
      wanted.setAttribute('aria-label', stars ? t('Wanted: {stars} of 5 stars', { stars }) : t('Not wanted'));
    }
    const money = kc(wallet.balance), paid = wallet.paidT > 0 ? wallet.paid : 0;
    const left = wallet.ticketLeft(clock.t), validFor = left > 0 ? (left < 5400 ? t('{n} min', { n: Math.ceil(left / 60) }) : t('{n} h', { n: Math.ceil(left / 3600) })) : '';
    show('money', `${money}${paid ? ` <span class="paid">−${kc(paid)}</span>` : ''}${validFor ? ` <span class="valid">${t('ticket: {left}', { left: validFor })}</span>` : ''}`, 'html');
    if (shown.moneyLabel !== money) { shown.moneyLabel = money; $('money').setAttribute('aria-label', t('Money: {money}', { money })); }
    // Health: a bar once you're hurt, and red at the edges of the screen as you're hit.
    const hp = Math.ceil(health.value);
    show('health', hp < MAX_HEALTH ? `<span role="img" aria-label="${t('Health: {n}%', { n: hp })}" style="width:${hp}%"${hp <= 30 ? ' class="low"' : ''}></span>` : '', 'html');
    show('hurt', Math.round(health.flash * 50) / 50, 'opacity');
    // The water left in an engine's tank, while it's being used or isn't full.
    const water_ = Math.ceil((cannon.tank / TANK) * 100);
    show('tank', inCar?.type === 'fire' && water_ < 100 ? `<span role="img" aria-label="${t('Water: {n}%', { n: water_ })}" style="width:${water_}%"></span>` : '', 'html');

    dev.update();
    renderer.render(scene, camera);
    // A picture of the frame just drawn, asked for by the feedback form: the canvas can only
    // be read in the task that drew it.
    if (grab.length) { const picture = takePicture(); for (const done of grab.splice(0)) done(picture); }
  });

  window.__drive = {
    scene, camera, traffic, crowd, loose, restingByCar, restingIndex, get resting() { return resting; }, boats, drive, walk, grid, walker, stats, world, renderer, police, brigade, health, fires, trams, ride, taxi, clock, board, metro, funicular, graphics, sound, weather, lamps, sky, skids, bikeShare, carPool, spawnWork, bags,
    get car() { return inCar; },
    get heli() { return inHeli; },
    choppers, addChopper,
    teleport: (x: number, y: number) => { (inCar || inHeli || walker).x = x; (inCar || inHeli || walker).y = y; camPos.set(x, 0, -y); },
    enterOrExit, teleportTo, dev, touch, dialog,
    // One step of the world with these controls (for tests, and while the tab is hidden).
    simulate: (dt: number, ctl: Partial<Controls> = {}) => simulate(dt, { move: 0, turn: 0, run: false, brake: false, jump: false, aim: null, ...ctl }),
    view: (z: number) => { zoom = z; height = (inCar ? 120 : 100) * z; },
  };
  testkit = setupTestkit({
    toLocal: dev.toLocal, toLonLat: dev.toLonLat, teleport: teleportTo,
    me: () => inCar || inHeli || walker, car: () => inCar, heli: () => inHeli,
    mode: () => (inCar ? 'car' : inHeli ? 'helicopter' : ride.on ? 'tram' : taxi.riding ? 'taxi' : boats.me ? 'boat' : funicular.me ? 'funicular' : metro.active ? 'metro' : 'foot'),
    street: () => street, enterOrExit, interact, arrest,
    addCar: (c) => { loose.push(c); restingStale = true; },
    loose,
    simulate: (dt, ctl = {}) => simulate(dt, { move: 0, turn: 0, run: false, brake: false, jump: false, aim: null, ...ctl }),
    view: (z) => { zoom = z; height = (inCar ? 120 : 100) * z; },
    loaded: (x, y) => world.loadNow(x, y, 300, testkit?.cam ? Infinity : viewRadius() + world.drawBeyond),
    grid, boats, wallet, police, health, clock, fires, brigade, ambulances, hurtNearest, traffic, crowd, rng: seeded, bags,
    carsNear: (x, y, r) => [...carsNear(x, y, r)],
    tramsNear: (x, y, r) => trams.bodies(x, y, r),
    view0: () => ({ x: camPos.x, y: -camPos.z, height }),
    viewRadius, offscreen,
    canvas: renderer.domElement, fov: camera.fov,
    weather: { set: (k) => { if (k === 'auto') weather.fixed = false; else weather.set(k, true); }, kind: () => weather.kind },
    season: { set: (when) => { const day = parseDay(when); if (!day) throw new Error(`A season's name, MM-DD or a day of the year, not ${when}`); season.set(day); }, date: () => season.date },
  });
  window.__test = testkit;
  dev.attach(testkit);
}

// The stick in a car steers towards the heading it points at (see aimSteer).
const stickTurn = { off: 0 };
const steerToward = (car: Car, h: number, throttle: number) => aimSteer(car.h, car.forwardSpeed, h, throttle, stickTurn);

function touching(ca: Point2[], cb: Point2[], rr: number) {
  for (const p of ca) for (const q of cb) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < rr) return true;
  return false;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const pair = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');

function parseTramLines(value: unknown): { lines: RawTramLine[] } {
  if (!record(value) || !Array.isArray(value.lines) || !value.lines.every((line: unknown) =>
    record(line) && typeof line.ref === 'string' && (typeof line.colour === 'string' || line.colour === null)
    && typeof line.from === 'string' && typeof line.to === 'string' && typeof line.night === 'boolean'
    && Array.isArray(line.pts) && line.pts.every(pair) && pair(line.ends)
    && Array.isArray(line.stops) && Array.isArray(line.turns) && Array.isArray(line.speed))) {
    throw new Error('The tram line data has invalid fields');
  }
  return value as unknown as { lines: RawTramLine[] };
}

function parseMetroLines(value: unknown): { lines: MetroLine[] } {
  if (!record(value) || !Array.isArray(value.lines) || !value.lines.every((line: unknown) =>
    record(line) && typeof line.ref === 'string' && typeof line.colour === 'string'
    && record(line.perHour) && Array.isArray(line.stations)
    && line.stations.every((station: unknown) => record(station)
      && typeof station.name === 'string' && typeof station.t === 'number'
      && (station.d === undefined || typeof station.d === 'number')
      && pair(station.at) && Array.isArray(station.entrances) && station.entrances.every(pair))
    && (line.path === undefined || (Array.isArray(line.path) && line.path.every(pair))))) {
    throw new Error('The metro line data has invalid fields');
  }
  return value as unknown as { lines: MetroLine[] };
}

main().catch((e) => {
  console.error(e);
  if (reloading) return;
  telemetry.error('startup', e);
  status(outdated ? 'The game was just updated. Reload the page to continue.'
    : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
});
