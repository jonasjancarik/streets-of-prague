#!/usr/bin/env node
// The traffic signs' posts and their file (src/map/signs.ts: signPosts, loadTrafficSigns),
// without the game: off the carriageway, in to the kerb, on the wall where there is no
// pavement, a few to a post in order with each plate under its sign, and the geometry.
// The pipeline's inference has its own tests (pipeline/test_traffic_signs.py).
import assert from 'node:assert/strict';
import { signPosts, signGeometry, signStyle, atlasCols, loadTrafficSigns, KERB_SET, BOTTOM } from '../src/map/signs.ts';

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
  assert.equal(ok.cols, 2);
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
