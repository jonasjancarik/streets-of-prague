// Builds a tile's buildings (walls and straight-skeleton roofs) off the main thread.
// Straight skeletons are by far the slowest part of a tile, up to a second or so.
import { initRoofs, buildBuildings } from '../buildings.js';

const ready = initRoofs();

self.onmessage = async (e) => {
  const { id, data } = e.data;
  try {
    await ready;
    const g = buildBuildings(data).mesh.geometry;
    const arrays = {};
    for (const k of ['position', 'normal', 'color', 'drapeUv']) arrays[k] = g.attributes[k].array;
    self.postMessage({ id, arrays }, Object.values(arrays).map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
