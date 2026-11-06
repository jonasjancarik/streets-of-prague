import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeSurfaceBuffers, bridgeSurfaceTile, readBridgeSurfacePreview } from '../src/bridgeSurfacePreview.ts';

test('a surveyed approach replaces its artificial pad and hands off the edge at the new station', () => {
  const preview = readBridgeSurfacePreview({
    version: 1, area: 'praha', built: 'map', decks: {}, tracks: {},
    approaches: { '0_0': { pads: [6], ground: [[4, 196]], decks: { '1': [[4, 200.55]] } } },
    spans: { link: [[0, 0], [8, 1]] },
  }, 'praha', 'map');
  const tile = bridgeSurfaceTile({ terraces: [{ label: 2 }, { label: 6 }], structures: [{ level: 1 }],
    drive: [{ id: 'link', bridge: false }, { id: 'other' }] }, '0_0', preview);
  assert.deepEqual(tile.terraces, [{ label: 2 }]);
  assert.deepEqual(tile.drive[0], { id: 'link', bridge: true, level: 0, levels: [[0, 0], [8, 1]] });
  assert.deepEqual(tile.drive[1], { id: 'other' });
  const height = new ArrayBuffer(27), levels = new ArrayBuffer(18);
  new Uint16Array(height, 0, 9)[4] = 998;
  new Uint8Array(height, 18)[4] = 6;
  const result = bridgeSurfaceBuffers(tile, '0_0', 3, height, levels, preview);
  assert.equal(new Uint16Array(result.height, 0, 9)[4], 960);
  assert.equal(new Uint8Array(result.height, 18)[4], 0);
  assert.equal(new Uint16Array(result.levels)[4], 10055);
  assert.equal(new Uint8Array(height, 18)[4], 6);
});
