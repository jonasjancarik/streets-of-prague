#!/usr/bin/env node
// The same wall projected into 3D, with a real two-metre passage through it.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildStreetWall, packStreetWalls, streetModule } from '../src/map/streetFacade.ts';
import { FACADE_ON, F_SURFACE, F_BAY, F_STOREY, F_STREET_WIDTH, LOOK, finishWalls, facadeCoords, baysOf } from '../src/facades.ts';
import apertures from '../src/map/facadeOpenings.json' with { type: 'json' };
import { StreetFacades } from '../src/streetFacades.ts';
import { STREET_QUALITY, STREET_TIERS } from '../src/streetQuality.ts';
import { rainpipe } from '../src/map/rainpipe.ts';

const pipe = rainpipe(.3, 15, 4);
assert(pipe.some(f => f.finish === 'inside'), 'the outlet is hollow');
assert(pipe.filter(f => f.finish === 'strap').length > 8, 'a tall pipe has clamped joints');
assert(pipe.every(f => f.points.every(([x,y,z]) => Math.abs(x-.3) < .10 && y > 0 && y < 15 && z > 0)),
  'pipe stays in its clear strip above the paving and in front of the wall');

const p = [], f = [], colors = [], labels = [];
function wall(x0, y0, x1, y1) {
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) {
    p.push(x, y, 0); f.push(x, y, 12, .5 / 32768); colors.push(.5, .42, .32); labels.push(.8);
  }
}
wall(0, 0, 5, 13); wall(5, 3, 7, 13); wall(7, 0, 12, 13);
const buffers = { position: Float32Array.from(p), color: Float32Array.from(colors), facade: Float32Array.from(f) };
const tris = Uint32Array.from({ length: p.length / 9 }, (_, i) => i), sky = Float32Array.from(labels);
const groups = packStreetWalls(buffers.facade, [{ tris: [...tris] }]);
const result = buildStreetWall(buffers, sky, tris);
assert.ok(result);
const count = result.position.length / 3;
for (const [key, size] of Object.entries({ normal: 3, color: 3, facade: 4, detail: 4, sky: 1 })) {
  assert.equal(result[key].length, count * size, key); assert.ok(result[key].every(Number.isFinite), key);
}
let front = 0, deep = 0, sill = 0, glass = 0, jambs = 0;
for (let i = 0; i < count; i += 3) {
  let x = 0, y = 0;
  for (let k = i; k < i + 3; k++) {
    const z = result.position[k * 3 + 2];
    if (z < -.15) deep++; if (z > .10) sill++; if (result.detail[k * 4 + 2] === 1) glass++;
    x += result.position[k * 3] / 3; y += result.position[k * 3 + 1] / 3;
    assert.ok(Math.abs(Math.hypot(...result.normal.subarray(k * 3, k * 3 + 3)) - 1) < 1e-5, 'unit surface normal');
  }
  assert.ok(!(x > 5.001 && x < 6.999 && y < 2.999), 'no face closes the existing passage');
  if (result.detail[i * 4 + 2] === F_SURFACE.reveal) {
    const depths = [0, 1, 2].map(j => result.position[(i + j) * 3 + 2]);
    const heights = [0, 1, 2].map(j => result.position[(i + j) * 3 + 1]);
    if (Math.min(...depths) < -.08 && Math.max(...heights) - Math.min(...heights) > .45) {
      jambs++;
      assert.ok(Math.max(...depths) <= .0471, 'a tall jamb never projects out to sill depth');
    }
  }
  if (result.position[i * 3 + 2] === 0 && result.normal[i * 3 + 2] > .99) front++;
}
assert.ok(front && deep && sill && glass && jambs, 'front planes, actual recesses, projecting stone, straight jambs and panes');
// The steps up to the raised doorways: each flight's foot on the pavement along the wall
// (z 0), reaching out in front of it as far as the stone drawn there.
assert.ok(result.steps.length > 0 && result.steps.length % 8 === 0, 'the test wall has steps up to a door');
for (let i = 0; i < result.steps.length; i += 8) {
  const [ax, az, bx, bz, ox, oz, low, top] = result.steps.subarray(i, i + 8);
  assert.ok(az === 0 && bz === 0 && bx > ax && ox === 0 && oz > .1 && oz < 1 && low === 0 && top > low, 'a flight stands on the pavement in front of the wall');
  let reach = 0;
  for (let k = 0; k < count; k++) {
    const x = result.position[k * 3], y = result.position[k * 3 + 1], z = result.position[k * 3 + 2];
    if (result.detail[k * 4 + 2] === F_SURFACE.dressedStone && x > ax - .001 && x < bx + .001 && y < top) reach = Math.max(reach, z);
  }
  assert.ok(Math.abs(reach - oz) < .02, `a flight's footprint reaches as far as its bottom step (${reach.toFixed(3)} against ${oz.toFixed(3)})`);
}
const blank = buffers.facade.slice(); for (let i = 3; i < blank.length; i += 4)blank[i] += 5;
assert.equal(packStreetWalls(blank, [{ tris: [...tris] }]).length, 0, 'party walls excluded');
assert.equal(streetModule(1 + .5 / 32768, 0, 0, 1) === 19, false, 'an inferred entrance never masquerades as an open tunnel');

// A worker response arriving after returning overhead must not hide a wall.
const scene = new THREE.Scene(), geom = new THREE.BufferGeometry();
for (const [name, array, size] of [['position', buffers.position, 3], ['color', buffers.color, 3], ['facade', buffers.facade, 4], ['sky', sky, 1]])
  geom.setAttribute(name, new THREE.BufferAttribute(array, size));
geom.computeVertexNormals();
const base = new THREE.Mesh(geom); scene.add(base);
let ready, cancelled = 0, jobs = 0;
const workers = { submit: () => { jobs++; return { promise: new Promise(resolve => ready = resolve), cancel: () => cancelled++ }; } };
const manager = new StreetFacades(scene, workers);
manager.register(base, groups, [-10, -10, 30, 30]); FACADE_ON.value = 1;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
manager.update(false, 4, 1, 4); assert.equal(jobs, 0);
const previousBudget = { ...STREET_QUALITY };
Object.assign(STREET_QUALITY, STREET_TIERS.lowest);
manager.update(true, 4, 1, 4); assert.equal(jobs, 0);
Object.assign(STREET_QUALITY, previousBudget);
manager.update(true, 4, 1, 4); assert.equal(jobs, 1); assert.equal(geom.index, null);
manager.update(false, 4, 1, 4); assert.equal(cancelled, 1);
ready(result); await tick(); assert.equal(scene.children.length, 1); assert.equal(geom.index, null);
manager.update(true, 4, 1, 4); ready(result); await tick();
assert.equal(scene.children.length, 2); assert.equal(geom.index.array[1], 0);
// Cars run into the steps while the wall is drawn close up (game y is three.js -z).
const flight = result.steps.subarray(0, 8), onStep = [(flight[0] + flight[2]) / 2, -flight[5] / 2];
assert.ok(manager.stepAt(...onStep) && !manager.stepAt(onStep[0], -flight[5] - .2), 'the steps are solid, the paving in front of them is not');
const fitted = scene.children.find(o => o.name === 'Street façade');
let disposedObject = false;
fitted.addEventListener('dispose', () => { disposedObject = true; });
manager.update(false, 4, 1, 4); assert.equal(scene.children.length, 1);
assert.ok(disposedObject, 'retiring the fitted wall releases its renderer object as well as its vertex buffers');
for (let i = 0; i < geom.index.count; i++)assert.equal(geom.index.array[i], i, 'original triangle restored');
assert.ok(!manager.stepAt(...onStep), 'the steps go with the close-up wall');
manager.update(true, 4, 1, 4); manager.drop(base); ready(result); await tick(); assert.equal(scene.children.length, 1);
console.log('Verified recessed geometry, stone profiles, passage clipping, camera swaps and late worker results.', count / 3, 'triangles in the test wall.');

// A wall measured on the ground of another tile, which stops at that tile's edge: its foot
// stood 0.6 m above the pavement. Measured again on the world's ground before it is drawn
// close up, its building's model and the close-up one both start at the pavement.
{
  const lifted = buffers.facade.slice(); for (let i = 1; i < lifted.length; i += 4) lifted[i] -= .6;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buffers.position.slice(), 3));
  g.setAttribute('facade', new THREE.BufferAttribute(lifted, 4));
  g.setAttribute('color', new THREE.BufferAttribute(buffers.color.slice(), 3));
  g.setAttribute('sky', new THREE.BufferAttribute(sky.slice(), 1));
  g.computeVertexNormals();
  let sent = null;
  const ground = new StreetFacades(new THREE.Scene(), { submit: (_, data) => { sent = data; return { promise: new Promise(() => {}), cancel: () => {} }; } }, undefined, () => 0);
  ground.register(new THREE.Mesh(g), groups, [-10, -10, 30, 30]);
  ground.update(true, 4, 1, 4);
  assert.ok(sent, 'the wall is sent to be built');
  for (let v = 0; v < buffers.position.length / 3; v++) {
    assert.ok(Math.abs(sent.facade[v * 4 + 1] - buffers.position[v * 3 + 1]) < 1e-5, 'the close-up wall stands on the world\'s ground');
    assert.ok(Math.abs(lifted[v * 4 + 1] - buffers.position[v * 3 + 1]) < 1e-5, 'the building\'s own model moves with it');
  }
  console.log('Verified walls measured again on the ground round them, and the steps cars run into.');
}

// An Art Nouveau shopfront has glass above its sill and solid joinery round
// the panes. The display finish cannot leak into the doors or the flats above.
const shopFacade = buffers.facade.slice();
for (let i = 3; i < shopFacade.length; i += 4) shopFacade[i] = (53 + .25) / 32768;
const shopWall = buildStreetWall({ ...buffers, facade: shopFacade }, sky, tris);
const shopPanes = [];
for (let i = 0; i < shopWall.detail.length; i += 4) {
  if (shopWall.detail[i + 2] === F_SURFACE.display) shopPanes.push([shopWall.facade[i + 1], shopWall.detail[i]]);
}
assert(shopPanes.length > 0 && shopPanes.every(([h, layer]) => h < 4.4 && (layer === 66 || layer === 71)));
console.log('Ground-floor display panes stay within the authored shop windows.');

// A mapped café (mappedFrontages.ts: u, stock, word): its bay becomes a shopfront with
// the bakery stock and KAVÁRNA (SIGN_WORDS[4]) on the fascia; a shop the game has no
// word for gets a plain fascia, and the other bay of its room carries no made-up sign.
const mappedWall = (stock, word) => buildStreetWall({ ...buffers, shops: Float32Array.of(2.5, stock, word) }, sky, tris);
const cafe = mappedWall(1, 4), words = new Set(), stocks = new Set();
for (let i = 0; i < cafe.detail.length; i += 4) {
  if (cafe.facade[i] > 5) continue;
  if (cafe.detail[i + 2] === F_SURFACE.shopSign) words.add(Math.floor(cafe.detail[i + 3]));
  if (cafe.detail[i + 2] === F_SURFACE.display) stocks.add(Math.floor(cafe.detail[i + 3]));
}
assert.deepEqual([...words], [4], 'the mapped café names itself, and only itself: ' + [...words]);
assert.deepEqual([...stocks], [2], 'its window holds the bakery stock: ' + [...stocks]);
const plain = mappedWall(-1, -1);
let plainSigns = 0, plainDisplays = 0;
for (let i = 0; i < plain.detail.length; i += 4) {
  if (plain.facade[i] > 5) continue;
  if (plain.detail[i + 2] === F_SURFACE.shopSign) plainSigns++;
  if (plain.detail[i + 2] === F_SURFACE.display) plainDisplays++;
}
assert.ok(plainDisplays > 0 && plainSigns === 0, 'a mapped shop without a word is still a shopfront, with a plain fascia');
console.log('Verified mapped shops: their own word and stock, and no clashing sign beside them.');

// Buildings with equal period and composition can have different wall seeds
// and storey fits around a corner. Their principal floors still belong together.
const packed = (look, composition, wall = 0, fit = 0) =>
  Math.fround((wall * 1024 + fit * 32 + look + (composition + .5) / 8) / 32768);
const upper = (w, row, bays = 7) => Array.from({ length: bays }, (_, bay) => streetModule(w, bay, row, bays));
for (const bays of [1, 2, 5, 6, 11]) for (let composition = 0; composition < 8; composition++) {
  const w = packed(0, composition), first = upper(w, 1, bays);
  assert.deepEqual(first, upper(packed(0, composition, 31, 17), 1, bays));
  assert.deepEqual(first, first.toReversed(), 'balanced window hoods on even and odd fronts');
  assert.equal(new Set(first).size, bays < 3 ? 1 : 2);
  assert.equal(new Set(upper(w, 3, bays)).size, 1, 'a simpler upper storey');
}
for (const look of [3, 8, 10]) {
  const w = packed(look, 1, 14);
  assert.deepEqual(upper(w, 1), upper(w, 3), 'stacked modern windows and loggias');
}
const residential = Array.from({ length: 8 }, (_, bay) => streetModule(packed(1, 6), bay, 0, 8));
assert.equal(residential.filter(layer => layer === 18).length, 1, 'a single residential entrance');
assert.ok(residential.includes(21) && residential.includes(23) && residential.every(layer => [18, 21, 23].includes(layer)),
  'an Old Town residential front has a barred window and sheltered plaster beside its portal');
// The house door gets a bell panel beside it and a place for its number plates on the
// other side (houseNumbers.ts), clear of the portal; a shop door gets neither.
const frontOf = (w, width) => {
  const at = [[0, 0], [width, 0], [width, 13], [0, 0], [width, 13], [0, 13]];
  return buildStreetWall({ position: Float32Array.from(at.flatMap(([x, y]) => [x, y, 0])), color: new Float32Array(18).fill(.5),
    facade: Float32Array.from(at.flatMap(([x, y]) => [x, y, width, w])) }, new Float32Array(6).fill(.8), Uint32Array.of(0, 1));
};
const house = frontOf(packed(1, 6), 16);
assert.equal(house.doorPlates.length, 3, 'one house door, one set of number plates: ' + house.doorPlates.length / 3);
const [plateX, plateY] = house.doorPlates;
assert.ok(plateY > 2.1 && plateY < 2.4 && plateX > .2 && plateX < 15.8, `the plates hang at head height on the wall: ${plateX}, ${plateY}`);
let panel = 0, overlap = 0;
for (let i = 0; i < house.detail.length; i += 4) {
  const [x, y, z] = [house.position[i / 4 * 3], house.position[i / 4 * 3 + 1], house.position[i / 4 * 3 + 2]];
  if (house.detail[i + 2] === F_SURFACE.metalFrame && y > 1.1 && y < 1.6 && z > .001) panel++;
  if (Math.abs(x - plateX) < .12 && y > 2.08 && y < 2.44 && z > .03) overlap++;
}
assert.ok(panel >= 6, 'a steel bell panel stands proud of the plaster beside the door: ' + panel);
assert.equal(overlap, 0, 'nothing of the portal stands where the plates hang');
console.log('Verified house doors: a bell panel and a clear place for the number plates.');

const awningWall = buildStreetWall({ ...buffers, facade: Float32Array.from(shopFacade, (v, i) =>
  i % 4 === 3 ? (101 + .25) / 32768 : v) }, sky, tris);
let canvas = 0, frame = 0, signs = 0;
for (let i = 0; i < awningWall.detail.length; i += 4) {
  const kind = awningWall.detail[i + 2], height = awningWall.facade[i + 1];
  if (kind === F_SURFACE.shopPaint) frame++;
  if (kind === F_SURFACE.shopSign) {
    signs++;
    assert.ok(awningWall.detail[i + 3] >= 0 && awningWall.detail[i + 3] < 4 && height < 4.4, 'a shop sign selects a display from the atlas');
  }
  if (kind !== F_SURFACE.canvas) continue;
  canvas++;
  assert.ok(height >= 2.24 && height < 4.4, 'fabric clears the pavement and the upper storeys');
  assert.ok(awningWall.position[i / 4 * 3 + 2] <= .95, 'awning stays close to its shop');
}
assert.ok(canvas && frame && signs, 'a rectangular display receives a lettered fascia and awning');
console.log('Verified window composition, vertically stacked bays and shop awning clearance.');

// The atlas rectangle is the physical opening, including the sash. A normal
// estate window admits daylight over about half the storey. Cellar lights
// below it remain small, and a tenement has a taller opening than a panel flat.
const metric = (layer, style) => {
  const [l, t, r, b] = apertures[layer][0];
  return [(r-l) / 256 * Math.min(F_BAY[style], F_STREET_WIDTH[layer]), (b-t) / 512 * F_STOREY[style]];
};
const [width, height] = metric(120, 3);
assert.ok(width > 2.5 && height > 1.4 && height < 1.65);
assert.ok(metric(49, 0)[1] > 1.9 && metric(108, 1)[1] > 1.4 && metric(127, 3)[1] < .7);

const access = 3 + packed(10, 1, 3, 14), sunny = 3 + packed(10, 1, 19, 14);
assert.equal(streetModule(access, 0, 0, 6), 126);
assert.equal(streetModule(access, 0, 4, 6), 124, 'stair lights stand over the common entrance');
const balconies = new Set([122, 123, 125]), guards = new Set();
for (let row = 1; row <= 10; row++) {
  const elevation = upper(sunny, row, 6);
  assert.deepEqual(elevation.map(layer => balconies.has(layer)), [false,true,true,false,true,true]);
  for (const part of elevation) if (balconies.has(part)) guards.add(part);
}
assert.equal(guards.size, 3, 'open rails, solid guards and glazed-in balconies share the same stack');
assert.ok(upper(sunny, 1, 2).every(layer => layer === 120), 'a short return is windowed');

const slabWidth = F_BAY[3] * 6, slabTop = 24;
const corners = [[0,0], [slabWidth,0], [slabWidth,slabTop], [0,0], [slabWidth,slabTop], [0,slabTop]];
const slab = buildStreetWall({
  position: Float32Array.from(corners.flatMap(([x,y]) => [x,y,0])),
  facade: Float32Array.from(corners.flatMap(([x,y]) => [x,y,slabWidth,sunny])),
  color: new Float32Array(18).fill(.6),
}, new Float32Array(6).fill(1), Uint32Array.of(0,1));
const highPanes = [];
for (let i = 0; i < slab.detail.length; i += 4) {
  if (slab.detail[i+2] === F_SURFACE.balconyGlass && slab.facade[i+1] > 16) highPanes.push(slab.detail[i+3]);
}
assert.ok(highPanes.length && highPanes.every(z => z < -.85), 'upper-floor balcony doors sit behind the front guard');
console.log('Verified apartment window dimensions, panel entrance sections and deep loggia stacks.');

// An interwar frontage and its eave. The roof has to rise behind the wall;
// a neighbour's roof touching the same edge must not change the house.
function interwarWall(rise, roofZ) {
  const p = Float32Array.of(0,0,0, 16,0,0, 16,13,0, 0,0,0, 16,13,0, 0,13,0,
    16,13,0, 0,13,0, 8,13+rise,roofZ);
  const lines = [], f = facadeCoords(p, () => 0, () => 2, lines);
  finishWalls(p, f, lines, () => [183,178,166], () => 3);
  return f[3];
}
const pitched = interwarWall(3,-5);
assert.equal(Math.floor(pitched * 32768) % 16, LOOK.interwarFlats);
assert.equal(Math.floor(interwarWall(0,-5) * 32768) % 16, LOOK.functionalist);
assert.equal(Math.floor(interwarWall(3,5) * 32768) % 16, LOOK.functionalist);
const countFlats = baysOf(pitched,16);
assert.equal(countFlats,4);
for (const floor of [1,2,4]) assert.deepEqual(upper(pitched,floor,countFlats),[113,77,77,113]);
const [l,t,r,b] = apertures[25][0];
assert.ok((r-l)/256 > .9 && (b-t)/512 > .49, 'ribbon lights fill the bay and reach about half a storey');
assert.deepEqual(apertures[41], apertures[113], 'the pictured balcony and its physical door coincide');
// Upper storeys now and then carry an air conditioner under a window or a dish beside one,
// more on modern fronts than old ones; they are painted kit (shopPaint) off the plaster.
{
  const count = (look, style) => {
    let kit = 0;
    for (let wall = 0; wall < 24; wall++) {
      const front = frontOf(style + packed(look, wall % 8, wall), 24);
      if (!front) continue;
      for (let i = 0; i < front.detail.length; i += 4) {
        const y = front.position[i / 4 * 3 + 1], z = front.position[i / 4 * 3 + 2];
        // The conditioner's face, off the wall at 33 cm (airConditioner), not a window box's.
        if (front.detail[i + 2] === F_SURFACE.shopPaint && y > 4.5 && Math.abs(z - .33) < .001) kit++;
      }
    }
    return kit;
  };
  const modern = count(LOOK.functionalist, 2), old = count(LOOK.neoRenaissance, 0);
  assert.ok(modern > 0, 'some modern upper storeys have air conditioners: ' + modern);
  assert.ok(modern > old, `more on modern fronts than old ones: ${modern} against ${old}`);
  console.log('Verified air conditioners and dishes on upper storeys.');
}
