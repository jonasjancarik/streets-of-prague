import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groundLayers, COLORS } from '../src/ground.ts';
import { readRoadProfile, withRoadProfile } from '../src/roadProfiles.ts';

const roadProfile = {
  from: [2, 5.2], to: [30, 7.2], half: 2.5, shoulder: 2, taper: 4,
  elevation: [100, -1.6, 0.2, -0.8], cross: -0.02,
};
const plain = (x, y, side) => 100.2 - 0.08 * x + 0.03 * y + (side ? 5 : 0);

test('optional profile matches its map and only changes at-grade points within its support', () => {
  const file = { version: 1, area: 'praha', built: 'build', tiles: ['1_2'], profile: roadProfile };
  assert.equal(readRoadProfile(file, 'praha', 'build'), file);
  for (const change of [{ built: 'old' }, { area: 'ujezd' }, { tiles: [null] }, { profile: { ...roadProfile, taper: 20 } }]) {
    assert.equal(readRoadProfile({ ...file, ...change }, 'praha', 'build'), null);
  }
  assert.equal(withRoadProfile(plain, undefined, 0), plain);
  const at = withRoadProfile(plain, roadProfile, 0);
  assert.equal(at(16, 6.2), 99.15);
  assert.equal(at(16, 6.2, 0), 99.15);
  for (const side of [true, 2, 3]) assert.equal(at(16, 6.2, side), plain(16, 6.2, side));
  for (const [x, y] of [[1, 5.2], [30, 12], [16, 12], [16, 0]]) assert.equal(at(x, y), plain(x, y));
  assert.ok(Math.abs(at(2.001, 5.2) - plain(2.001, 5.2)) < 1e-6);
});

const polygon = ([x0, y0, x1, y1]) => [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
function build(box, at) {
  const [x0, , x1] = box;
  const roads = { road: polygon([x0, 4.3, x1, 8.1]) };
  return groundLayers({ roads, areas: {}, rails: [] }, { box, height: at, roadProfile })
    .layers.find((l) => l.color === COLORS.asphalt).geometry;
}

// Heights read from the actual uploaded road mesh edges along a shared tile edge.
function seamHeight({ position: p, index: idx }, x, y) {
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k] * 3, b = idx[t + (k + 1) % 3] * 3;
      if (p[a] !== Math.fround(x) || p[b] !== Math.fround(x)) continue;
      const ya = -p[a + 2], yb = -p[b + 2];
      if (ya === yb || y < Math.min(ya, yb) || y > Math.max(ya, yb)) continue;
      return p[a + 1] + (p[b + 1] - p[a + 1]) * (y - ya) / (yb - ya);
    }
  }
  assert.fail(`No shared mesh edge at ${x},${y}`);
}

test('two independently built road tiles agree at the seam and track vehicle height', () => {
  const at = withRoadProfile(plain, roadProfile, 0), x = 16.37;
  const left = build([0, 0.37, x, 12.37], at), right = build([x, 0.37, 32, 12.37], at);
  for (let y = 4.33; y < 8.09; y += 0.031) {
    const a = seamHeight(left, x, y), b = seamHeight(right, x, y);
    assert.ok(Math.abs(a - b) < 1e-5, `mesh seam at ${x},${y}`);
    assert.ok(Math.abs(a - at(x, y)) < 0.01, `vehicle differs from seam at ${x},${y}`);
  }
});
