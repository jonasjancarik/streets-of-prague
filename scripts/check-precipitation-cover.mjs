// Check that a partially sampled block or an old block after a teleport cannot
// expose rain below a roof. Coordinates are in the renderer's x/z system.
import assert from 'node:assert/strict';
import { PrecipitationCover } from '../src/precipitationCover.ts';

const cover = new PrecipitationCover();
let probes = 0;
const top = (x, z) => { probes++; return x >= 10 && z < 4 ? 17.5 : -2.25; };
const sample = (x, z) => {
  const { x: ox, y: oz, z: span } = cover.box.value;
  const { width, data } = cover.texture.image;
  const i = 4 * (Math.floor((z - oz) * width / span) * width + Math.floor((x - ox) * width / span));
  return (data[i] * 256 + data[i + 1]) / 16 - 1024;
};
const fill = (x, z, rev) => { for (let i = 0; i < 9; i++) cover.update(x, z, rev, top); };
cover.update(0, 0, 0, top);
assert.equal(cover.box.value.w, 0, 'a partial coat of samples stays private');
fill(0, 0, 0);
assert.equal(cover.box.value.w, 1);
assert.equal(sample(12, 0), 17.5, 'roof in the shelter map');
assert.equal(sample(0, 0), -2.25, 'open street keeps its lower ground height');
assert(cover.sheltered(12, 0, 1.75) && !cover.sheltered(12, 0, 19.25), 'umbrellas close below the roof and open above it');
assert(!cover.sheltered(0, 0, 1.75) && !cover.sheltered(1000, 1000, 1.75), 'open and unsampled streets keep their umbrellas');
const before = probes;
cover.update(1, 0, 0, top);
assert.equal(probes, before, 'standing in the same cell does not sample roofs again');
const old = cover.box.value.clone();
cover.update(9, 0, 0, top);
assert(cover.box.value.equals(old), 'walking keeps the last complete block');
cover.update(200, 10, 1, top);
assert.equal(cover.box.value.w, 0, 'teleport discards distant cover at once');
fill(200, 10, 1);
assert.equal(sample(200, 0), 17.5);
console.log('Verified street precipitation heights, incremental publication, stationary reuse and teleport cleanup.');
