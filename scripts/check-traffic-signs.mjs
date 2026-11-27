#!/usr/bin/env node
// The traffic signs' posts and their file (src/map/signs.ts: signPosts, loadTrafficSigns),
// without the game: off the carriageway, in to the kerb, on the wall where there is no
// pavement, a few to a post in order with each plate under its sign, and the geometry.
// The pipeline's inference has its own tests (pipeline/test_traffic_signs.py).
import assert from 'node:assert/strict';
import { signPosts, signGeometry, signStyle, signIndex, atlasCols, loadTrafficSigns, KERB_SET, BOTTOM, SPARE_CELLS } from '../src/map/signs.ts';

// A street along y=0, its carriageway |y| < 4; houses from y = -7 down, and from y = 4.2 up
// beyond x = 50 (no pavement there on the north side).
const onRoad = (x, y) => Math.abs(y) < 4;
const inside = (x, y) => y < -7 || (x > 50 && y > 4.2);
const height = () => 10;
const names = ['give way', 'crossing', 'no lorries', 'except access', 'speed 30', 'one way'];
const at = (sign, x, y, angle) => [names.indexOf(sign), x, y, angle];
// Facing traffic driving east: on its right (south), its local x pointing south (angle -π/2).
const south = -Math.PI / 2;

{
  // On the road: out to the kerb and KERB_SET past it. Out in the pavement: in to the kerb.
  const [a] = signPosts(new Float32Array(at('crossing', 10, -2, south)), names, onRoad, inside, height);
  assert(a.y < -4 && a.y > -4 - KERB_SET - .3 && !a.wall, 'pushed off the carriageway: ' + JSON.stringify(a));
  const [b] = signPosts(new Float32Array(at('crossing', 10, -6.5, south)), names, onRoad, inside, height);
  assert(b.y < -4 && b.y > -4 - KERB_SET - .3, 'pulled in to the kerb: ' + JSON.stringify(b));
  assert.equal(b.z, 10);
  // North side past x = 50 the house front is the kerb: on the wall. (Facing west-bound traffic.)
  const [c] = signPosts(new Float32Array(at('crossing', 60, 5, Math.PI / 2)), names, onRoad, inside, height);
  assert(c.wall && c.y >= 4 && c.y <= 4.3, 'on the wall: ' + JSON.stringify(c));
  console.log('Signs stand by the kerb, or on the wall where there is no pavement');
}

{
  // Four signs and a plate for the same traffic at one spot: two to a post, the plate under its sign.
  const pts = [...at('one way', 20, -5, south), ...at('except access', 20.2, -5, south), ...at('no lorries', 20.2, -5, south),
    ...at('give way', 20.4, -5, south), ...at('speed 30', 20.6, -5, south)];
  const posts = signPosts(new Float32Array(pts), names, onRoad, inside, height);
  const signs = posts.map(p => p.signs.map(s => names[s]));
  assert.deepEqual(signs, [['give way', 'no lorries', 'except access'], ['speed 30', 'one way']], JSON.stringify(signs));
  // For the traffic the other way, across the street: a post of its own.
  const both = signPosts(new Float32Array([...at('crossing', 30, -5, south), ...at('crossing', 30.5, 5, south + Math.PI)]), names, onRoad, inside, height);
  assert.equal(both.length, 2);
  console.log('Two signs to a post, the more important on top, each plate under its sign');
}

{
  const posts = signPosts(new Float32Array([...at('give way', 20, -5, south), ...at('crossing', 20.2, -5, south), ...at('crossing', 60, 5, Math.PI / 2)]), names, onRoad, inside, height);
  const g = signGeometry(posts, names, atlasCols(names.length));
  assert(g && g.position.length / 9 === g.uv.length / 6 && g.color.length === g.position.length, 'one triangle list');
  assert(g.uv.every(v => v >= 0 && v <= 1), 'atlas coordinates');
  let top = -Infinity, low = Infinity;
  for (let i = 1; i < g.position.length; i += 3) { top = Math.max(top, g.position[i]); low = Math.min(low, g.position[i]); }
  // The post from the pavement (10, less 2 cm) up past the two signs: a triangle over a 0.6 m square.
  assert(low < 10 && low > 9.9 && top > 10 + BOTTOM + signStyle('give way').h + signStyle('crossing').h, `post and signs ${low}…${top}`);
  assert.equal(Array.from(g.posts).filter((_, i) => i % 4 === 2).join(), '0,1', 'one free-standing post and one on the wall');
  assert(g.position.length / 9 < 600, 'triangles: ' + g.position.length / 9);
  console.log(`Sign geometry: ${g.position.length / 9} triangles for three signs on two posts`);
}

{
  const file = { signs: ['crossing', 'give way'], points: [[1, 2, 1, 90], [3, 4, 7, 0]], turns: [['55', 180, 'left|through']] };
  const ok = await loadTrafficSigns('x', 1000, async () => new Response(JSON.stringify(file)));
  assert.deepEqual(Array.from(ok.points), [1, 1, 2, Math.fround(Math.PI / 2)], 'an unknown sign index is left out');
  assert.equal(ok.cols, atlasCols(2 + SPARE_CELLS), 'room for the signs the game adds');
  assert.deepEqual(ok.turns.get('55'), [[Math.PI, 'left|through']]);
  assert.equal(await loadTrafficSigns('x', 1000, async () => new Response('', { status: 404 })), null);
  const late = await loadTrafficSigns('x', 50, (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  assert.equal(late, null, 'past the deadline');
  console.log('The signs file: read, missing and late');
}

{
  // Direction plates: one per branch (two places to a plate), straight on square, left and right
  // pointed; laid out on the tile's canvas, a post with the plates or a board on two.
  const { signFaces, directionLayout, directionGeometry, readDirections, PLATE_BOTTOM, WIDTH } = await import('../src/map/directions.ts');
  const signs = readDirections([
    [10, -5, 270, 'plates', [[0, 'Brno;Benešov;Kolín', 'D1', '', 'green'], [90, 'Vinohrady', '', '', 'white'], [-88, 'Kbely', '', '', 'blue']]],
    [30, 5, 90, 'board', [[0, 'Brno', 'D1', '', 'green'], [90, 'Vinohrady', '', '', 'white']]],
    [1, 2, 0, 'nonsense', []],
  ]);
  assert.equal(signs.length, 2, 'a row that is not a sign is left out');
  const faces = signFaces(signs[0]);
  assert.deepEqual(faces.map(f => [f.point, f.places.join(';'), f.refs.join()]), [[0, 'Brno;Benešov', 'D1'], [0, 'Kolín', ''], [-1, 'Vinohrady', ''], [1, 'Kbely', '']]);
  assert(faces.every(f => f.w >= .9 && f.w <= 2.2) && faces[0].h > faces[1].h, 'plate sizes: ' + faces.map(f => [f.w, f.h]));
  const { rects, width, height: tall } = directionLayout(signs);
  assert(rects.length === 5 && width === WIDTH && rects.every(r => r.x >= 0 && r.y >= 0 && r.x + r.w <= width && r.y + r.h <= tall), 'on the canvas');
  for (let i = 0; i < rects.length; i++) for (let j = 0; j < i; j++) {
    const a = rects[i], b = rects[j];
    assert(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h, 'faces do not overlap');
  }
  const g = directionGeometry(signs, onRoad, inside, height);
  assert(g && g.uv.every(v => v >= 0 && v <= 1), 'canvas coordinates');
  // The plates' post, then the board's two posts, all free-standing.
  assert.deepEqual(Array.from(g.posts).filter((_, i) => i % 4 === 2), [0, 0, 0]);
  let top = -Infinity;
  for (let i = 1; i < g.position.length; i += 3) top = Math.max(top, g.position[i]);
  assert(top > 10 + PLATE_BOTTOM + faces.reduce((h, f) => h + f.h, 0), 'four plates stacked: ' + top);
  // A board with a house where it would stand is left out.
  const none = directionGeometry([signs[1]], onRoad, (x, y) => inside(x, y) || y > 6, height);
  assert.equal(none, null);
  console.log(`Direction signs: ${faces.length} plates on a post and a board, ${g.position.length / 9} triangles`);
}

{
  // A gantry over the three lanes of a carriageway along y=0 (|y| < 5.5 here), facing the
  // east-bound traffic: two posts past its edges, the panels 5.3 m up; an arm from the right
  // where only the right lane has a panel.
  const { readDirections, directionGeometry, GANTRY_CLEAR } = await import('../src/map/directions.ts');
  const wide = (x, y) => Math.abs(y) < 5.5;
  const row = panels => [0, 0, 270, 'gantry', panels, 3, 1, 5.4];
  const [full, armed] = readDirections([row([[0, 1, 'centrum', '', '', 'white', 'through|through'], [2, 2, 'Brno', 'D1', '', 'green', 'slight_right']]),
    row([[2, 2, 'Brno', 'D1', '', 'green', 'slight_right']])]);
  assert(full.gantry.panels.length === 2 && armed.gantry.panels.length === 1, 'gantries read');
  // (The edges found in quarter metres: 5.25 m out, the posts a metre past them.)
  const posts = s => Array.from(directionGeometry([s], wide, () => false, () => 0).posts).filter((_, i) => i % 4 === 1).map(y => Math.round(y * 4) / 4);
  assert.deepEqual(posts(full), [6.25, -6.25], 'a post past each edge: ' + posts(full));
  assert.deepEqual(posts(armed), [-6.25], 'an arm from the right (south) edge');
  const g = directionGeometry([full], wide, () => false, () => 0);
  let low = Infinity;
  for (let i = 0; i < g.position.length; i += 3) if (Math.abs(g.position[i + 2]) < 5.4 && g.position[i + 1] > 1) low = Math.min(low, g.position[i + 1]);
  assert(low > GANTRY_CLEAR - .1, 'clear of the traffic: ' + low);
  console.log(`Gantries: over the lanes, ${g.position.length / 9} triangles`);
}

{
  // Paid parking: IP 12 and its plate join the names in the spare cells, each zone's area once;
  // a sign at the start of each section along the kerb on the traffic's right, then every 70 m.
  // (parking.ts brings in the game's modules, which need TypeScript's own transpiling.)
  const { registerHooks } = await import('node:module'), { readFileSync } = await import('node:fs'), ts = (await import('typescript')).default;
  registerHooks({ load(url, context, next) {
    if (url.endsWith('.json') && url.includes('/src/')) return { format: 'json', shortCircuit: true, source: readFileSync(new URL(url), 'utf8') };
    if (!url.endsWith('.ts')) return next(url, context);
    const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({})');
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText };
  } });
  globalThis.location ??= { search: '' }; globalThis.self ??= globalThis;
  const { parkingArea, parkingSigns, Zones } = await import('../src/parking.ts?game');
  assert.equal(parkingArea('P5-1403'), '51'); assert.equal(parkingArea('P1-0102'), '1'); assert.equal(parkingArea('X'), null);
  const signs = { names: ['give way'], cols: atlasCols(1 + SPARE_CELLS) };
  const index = name => signIndex(signs, name);
  assert.equal(index('give way'), 0); assert.equal(index('nonsense'), -1, 'not a sign');
  const square = (x0, x1) => [[[x0, -10], [x1, -10], [x1, 10], [x0, 10], [x0, -10]]];
  const zones = new Zones({ sections: [
    { code: 'P5-1403', category: 'MIX', spaces: 20, inside: 1, polys: [square(-1, 150)] },
    { code: 'P5-1404', category: 'VIS', spaces: 5, inside: 1, polys: [square(150, 300)] },
  ] });
  const pts = [[0, 0], [300, 0]];
  const edge = { pts, path: { length: 300 }, oneway: false, hw: 'residential', width: 12, laneOffset: 1.5, kerb: [6, 6] };
  const out = parkingSigns([edge], zones, [-50, -50, 400, 50], [], index);
  const placed = [];
  for (let i = 0; i < out.length; i += 4) placed.push([signs.names[out[i]], Math.round(out[i + 1]), Math.round(out[i + 2])]);
  const ip12 = placed.filter(p => !p[0].includes('plate'));
  assert(ip12.every(p => p[2] < 0), 'on the right of traffic going east: ' + JSON.stringify(ip12));
  assert.deepEqual(ip12.map(p => p[0]), ['parking MIX', 'parking MIX', 'parking VIS', 'parking VIS'], JSON.stringify(placed));
  assert.deepEqual(ip12.map(p => p[1]), [10, 80, 150, 220], 'section starts, then every 70 m');
  assert(placed.some(p => p[0] === 'parking plate MIX 51') && placed.some(p => p[0] === 'parking plate VIS'), 'their plates');
  assert(signs.names.length === 5 && signs.names.every(n => signStyle(n)), signs.names.join());
  const g = signPosts(new Float32Array(out), signs.names, (x, y) => Math.abs(y) < 4, () => false, () => 0);
  assert(g.length === 4 && g.every(p => p.signs.length === 2 && signStyle(signs.names[p.signs[1]]).rank === 9), 'each sign on a post, its plate under it');
  console.log(`Paid parking: ${ip12.length} signs with their plates`);
}

{
  // A wall sign moves onto the house front as drawn: here 0.5 m behind the footprint it was
  // hung on, then (drawn again) it stays put.
  globalThis.document ??= { createElement: () => ({ getContext: () => null }) };
  const THREE = await import('three');
  const { mountOnWalls } = await import('../src/signs.ts?game');
  const north = Math.PI / 2; // its local x (towards the wall) pointing north
  const posts = signPosts(new Float32Array(at('one way', 60, 3, north)), names, onRoad, inside, height);
  assert(posts.length === 1 && posts[0].wall, 'on the wall');
  const g = signGeometry(posts, names, atlasCols(names.length));
  assert.equal(g.mounts.length, 6, 'one mount');
  assert(Math.abs(g.mounts[1] - 4.2) < .02, 'at the footprint within a centimetre: ' + g.mounts[1]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  const mesh = new THREE.Mesh(geometry); mesh.userData.mounts = g.mounts;
  // The drawn wall: y = 4.7 in the map (z = -4.7 in the scene), facing south (+z), 0–20 m up.
  const quad = [[40, 0], [80, 0], [80, 20], [40, 0], [80, 20], [40, 20]].flatMap(([x, h]) => [x, h, -4.7]);
  const wall = { position: new Float32Array(quad), normal: new Float32Array(quad.length).map((_, i) => i % 3 === 2 ? 1 : 0) };
  const before = Float32Array.from(g.position);
  assert.equal(mountOnWalls(mesh, [wall]), 1);
  const shift = (i) => -(geometry.attributes.position.array[i * 3 + 2] - before[i * 3 + 2]);
  assert(Math.abs(shift(0) - .5) < .02, 'moved onto the drawn wall: ' + shift(0));
  assert.equal(mountOnWalls(mesh, [wall]), 0, 'and only once');
  console.log('Wall signs: on the wall as drawn');
}
