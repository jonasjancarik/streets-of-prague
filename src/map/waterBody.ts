import { signedArea, type Bounds, type Polygons } from './geo.ts';

// Only classify complete, small water bodies. A cropped piece of the river may
// be small, but every such piece touches its tile's edge.
export function splitQuietWater(water: Polygons, [x0, y0, x1, y1]: Bounds) {
  const open: Polygons = [], quiet: Polygons = [];
  const limit = 3000, inset = 0.04;
  for (const rings of water) {
    const outer = rings[0];
    const complete = outer.every(([x, y]) => x > x0 + inset && x < x1 - inset && y > y0 + inset && y < y1 - inset);
    const area = Math.abs(signedArea(outer)) - rings.slice(1).reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0);
    (complete && area > 0 && area <= limit ? quiet : open).push(rings);
  }
  return { open, quiet };
}
