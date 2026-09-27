// Builds a tile's buildings (walls and straight-skeleton roofs) off the main thread.
// Straight skeletons are by far the slowest part of a tile, up to a second or so.
import { initRoofs, buildBuildings } from '../buildings.js';

const ready = initRoofs();

self.onmessage = async (e) => {
  const { id, data } = e.data;
  try {
    await ready;
    // One building at a time, each lifted onto its own ground height (`base`).
    const parts = { position: [], normal: [], color: [], drapeUv: [] };
    for (const b of data.buildings) {
      const g = buildBuildings({ ...data, buildings: [b] }).mesh.geometry;
      const pos = g.attributes.position.array;
      for (let i = 1; i < pos.length; i += 3) pos[i] += b.base || 0;
      for (const k in parts) parts[k].push(g.attributes[k].array);
    }
    const arrays = {};
    for (const k in parts) {
      const n = parts[k].reduce((a, x) => a + x.length, 0);
      arrays[k] = new Float32Array(n);
      let o = 0;
      for (const x of parts[k]) { arrays[k].set(x, o); o += x.length; }
    }
    self.postMessage({ id, arrays }, Object.values(arrays).map((a) => a.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
