import { rng } from './geo.ts';
import type { Geo, Grid } from './geo.ts';

// The made-up trees of woods, young woods, parks and surveyed groves (the rest of a tile's
// trees are in vegetation.ts). Every spot comes from a lattice fixed to the map with a
// seed of its own, so a place has the same tree whichever tile works it out, and each
// tile also works out the crowns MARGIN metres past its edge (taking the wood to go on
// there). Without that the first row of a tile was half as dense, and the gaps were filled
// without knowing the neighbour's crowns: a line of extra small trees along tile borders.

// Classes of the tile's land-use raster (vegetation.ts paints it) that this file reads.
export const WOOD = 200, PARK = 120, GROVE = 180;
export const SHRUB = 3, CONIFER = 4;
// [x, y, radius, kind, height (1 for the usual), a neighbouring tile's (not drawn here),
// its top in metres when measured (pipeline/tree_sizes.py), its crown's colour in the photo
// (red, green, blue, 0 to 255)]
export type Tree = [number, number, number, number, number?, boolean?, number?, number[]?];
// Of the trees we make up, how many are conifers: pines and spruces in the woods, a
// few in the streets, parks and gardens. Chosen by where the tree stands.
export const CONIFERS = [0.3, 0.08];
export const MARGIN = 8;

// A smooth random field on a lattice fixed to the map (so every tile agrees at its
// edges), 0 to 1, features about `cell` metres across.
export function valueNoise(x: number, y: number, cell: number, salt: number) {
  const gx = x / cell, gy = y / cell, i = Math.floor(gx), j = Math.floor(gy);
  const fx = gx - i, fy = gy - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number) => {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + salt | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const top = h(i, j) + (h(i + 1, j) - h(i, j)) * sx, bottom = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * sx;
  return top + (bottom - top) * sy;
}

// How far inside a wood a spot is, in metres up to `max`: the shortest way out along
// eight directions. Past the edge of the tile the wood is taken to go on.
function woodDepth(grid: Grid, x: number, y: number, max: number) {
  let depth = max;
  for (let k = 0; k < 8; k++) {
    const c = Math.cos(k * Math.PI / 4), s = Math.sin(k * Math.PI / 4);
    for (let d = 2; d < depth; d += 2) {
      const v = grid.at(x + c * d, y + s * d);
      if (v !== WOOD && v !== 255) { depth = d; break; }
    }
  }
  return depth;
}

// Whether the tree we make up at (x, y) is a conifer (`share` of them are), by where it
// stands so the same place always has the same tree.
export function conifer(x: number, y: number, share: number) {
  return rng(Math.imul(Math.floor(x * 8), 19349663) ^ Math.imul(Math.floor(y * 8), 83492791))() < share;
}

// Adds the trees to `trees` (which holds the surveyed ones already) and returns the index
// of crowns it kept, for the passes that follow. `isYoung`: a young wood (young_woods.py);
// `surveyed`: a surveyed tree stands within reach.
export function scatterWoods(geo: Geo, grid: Grid, isYoung: (x: number, y: number) => boolean,
  surveyed: (x: number, y: number) => boolean, trees: Tree[]) {
  const own = (x: number, y: number) => x >= geo.minX && x < geo.maxX && y >= geo.minY && y < geo.maxY;
  // Past the edge: what the tile has at its nearest point.
  const nearX = (x: number) => Math.min(geo.maxX - 0.5, Math.max(geo.minX + 0.5, x));
  const nearY = (y: number) => Math.min(geo.maxY - 0.5, Math.max(geo.minY + 0.5, y));
  const at = (x: number, y: number) => grid.at(nearX(x), nearY(y));
  const young = (x: number, y: number) => isYoung(nearX(x), nearY(y));
  // One spot in every cell of a lattice of `step` metres, over the tile and its margin, each
  // with its own random numbers `g`.
  const spots = (step: number, salt: number, place: (x: number, y: number, g: () => number, mine: boolean) => void) => {
    for (let j = Math.floor((geo.minY - MARGIN) / step); j * step < geo.maxY + MARGIN; j++) {
      for (let i = Math.floor((geo.minX - MARGIN) / step); i * step < geo.maxX + MARGIN; i++) {
        const g = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ salt);
        const x = (i + g()) * step, y = (j + g()) * step;
        place(x, y, g, own(x, y));
      }
    }
  };

  // Woods. The trees come from a jittered grid, as in a park, but the wood itself has a
  // character: stands of conifers and of broadleaves (slow noise, not a coin toss per
  // tree), stands of taller and of lower trees with the odd one standing out, a
  // thinner, lower fringe within 8 m of the outline, and then the gaps between the
  // crowns filled with small trees below.
  const standOf = (x: number, y: number): Tree => {
    const stand = valueNoise(x, y, 40, 0x6a1f);
    const pine = Math.min(0.92, Math.max(0.04, CONIFERS[0] + (stand - 0.5) * 2.4));
    const one = rng(Math.imul(Math.floor(x * 8), 19349663) ^ Math.imul(Math.floor(y * 8), 83492791))();
    const tall = 0.86 + 0.5 * valueNoise(x, y, 55, 0x2d7b) + (one > 0.96 ? 0.35 : 0);
    return [x, y, 0, one < pine ? CONIFER : 0, tall];
  };
  const addWood = (x: number, y: number, rad: number, edge: number, mine: boolean) => {
    const t = standOf(x, y);
    // Near the outline: lower and smaller, the crowns of young trees.
    t[2] = t[3] === CONIFER ? rad * 0.8 : rad;
    t[4] = t[4]! * (0.6 + 0.4 * edge);
    if (!mine) t[5] = true;
    trees.push(t);
  };
  spots(4.5, 0x5d2a, (x, y, g, mine) => {
    const size = g(), pick = g(), v = at(x, y);
    if (v === WOOD && !young(x, y)) {
      const edge = woodDepth(grid, x, y, 8) / 8;
      const rad = (3 + size * 3.2) * (0.55 + 0.45 * edge);
      // Thinner towards the outline, and in patches inside (clearings and denser stands).
      const keep = 0.62 * (0.25 + 0.75 * edge) * (0.8 + 0.4 * valueNoise(x, y, 30, 0x31c5));
      if (pick < keep && !surveyed(x, y)) addWood(x, y, rad, edge, mine);
    } else if (mine && ((v === PARK && pick < 0.09) || (v === GROVE && pick < 0.45))) {
      const rad = 2.8 + size * 2.8;
      if (!surveyed(x, y)) trees.push(conifer(x, y, CONIFERS[1]) ? [x, y, rad * 0.8, CONIFER] : [x, y, rad, 1]);
    }
  });
  // Young woods: small, dense and low, a thicket of saplings and young trees (a plantation, or
  // a field gone wild), thinner towards the outline.
  spots(3.4, 0x77e1, (x, y, g, mine) => {
    const size = g(), pick = g(), tall = g();
    if (at(x, y) !== WOOD || !young(x, y) || surveyed(x, y)) return;
    const edge = woodDepth(grid, x, y, 8) / 8;
    if (pick > 0.8 * (0.4 + 0.6 * edge) * (0.8 + 0.4 * valueNoise(x, y, 20, 0x77e1))) return;
    const t = standOf(x, y);
    t[2] = (1.3 + size * 1.3) * (t[3] === CONIFER ? 0.8 : 1);
    t[4] = 0.55 + 0.25 * tall;
    if (!mine) t[5] = true;
    trees.push(t);
  });
  // Gaps: where no crown covers a spot, a smaller tree (a young one or one that grew
  // up in the shade), as long as the wood is not at its outline.
  const CELL = 8, byCell = new Map<number, number[]>();
  const cellKey = (i: number, j: number) => i * 65536 + j;
  const index = (t: number) => {
    const k = cellKey(Math.floor(trees[t][0] / CELL), Math.floor(trees[t][1] / CELL));
    const list = byCell.get(k);
    if (list) list.push(t); else byCell.set(k, [t]);
  };
  for (let t = 0; t < trees.length; t++) index(t);
  // Whether a tree's crown (its middle `margin` of it) is over the spot.
  const covered = (x: number, y: number, margin: number) => {
    const i0 = Math.floor(x / CELL), j0 = Math.floor(y / CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (const t of byCell.get(cellKey(i, j)) || []) if (Math.hypot(trees[t][0] - x, trees[t][1] - y) < trees[t][2] * margin) return true;
      }
    }
    return false;
  };
  spots(3.4, 0x1b83, (x, y, g, mine) => {
    const size = g();
    if (at(x, y) !== WOOD || young(x, y) || surveyed(x, y) || covered(x, y, 1.25)) return;
    const edge = woodDepth(grid, x, y, 8) / 8;
    if (edge < 0.4) return;
    addWood(x, y, (2.4 + size * 1.6) * (0.7 + 0.3 * edge), edge, mine);
    index(trees.length - 1);
  });
  return { covered, index };
}

// The ragged edge of a wood: shrubs and a few young trees just outside its outline, on the
// ground classes `beside` (grass, a field, a garden, a clearing). The spots are on the map's
// lattice with their own seeds, like the wood's, so the fringe has no seam of its own at a
// tile border. (A tile still cannot see a wood that lies wholly in the next tile: the strip
// within 5 m of such a wood, on this side of the border, gets no shrubs.)
export function edgeShrubs(geo: Geo, grid: Grid, beside: number[], surveyed: (x: number, y: number) => boolean,
  trees: Tree[], covered: (x: number, y: number, margin: number) => boolean, index: (t: number) => void) {
  const near = (x: number, y: number) => {
    for (let k = 0; k < 8; k++) {
      const c = Math.cos(k * Math.PI / 4), s = Math.sin(k * Math.PI / 4);
      for (const d of [2.5, 5]) if (grid.at(x + c * d, y + s * d) === WOOD) return d;
    }
    return 0;
  };
  // The shrubs placed so far, in cells, to keep them from standing in each other.
  const CELL = 4, placed = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor(x / CELL) * 65536 + Math.floor(y / CELL);
  const crowded = (x: number, y: number, rad: number) => {
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const b of placed.get(key(x + i * CELL, y + j * CELL)) || []) if (Math.hypot(trees[b][0] - x, trees[b][1] - y) < (trees[b][2] + rad) * 0.7) return true;
      }
    }
    return false;
  };
  const STEP = 2.6;
  for (let j = Math.floor(geo.minY / STEP); j * STEP < geo.maxY; j++) {
    for (let i = Math.floor(geo.minX / STEP); i * STEP < geo.maxX; i++) {
      const g = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ 0x4b9d);
      const x = (i + g()) * STEP, y = (j + g()) * STEP, pick = g(), size = g();
      if (x < geo.minX || x >= geo.maxX || y < geo.minY || y >= geo.maxY || !beside.includes(grid.at(x, y))) continue;
      const d = near(x, y);
      if (!d || surveyed(x, y)) continue;
      const fade = d < 3 ? 1 : 0.55, patchy = 0.4 + 1.2 * valueNoise(x, y, 18, 0x4b9d);
      if (pick < 0.3 * fade * patchy) {
        const rad = 0.9 + size * 0.8;
        if (crowded(x, y, rad)) continue;
        const k = key(x, y), list = placed.get(k);
        if (list) list.push(trees.length); else placed.set(k, [trees.length]);
        trees.push([x, y, rad, SHRUB]);
      } else if (pick > 1 - 0.05 * fade * patchy) {
        if (!covered(x, y, 1)) { trees.push([x, y, 1.7 + size * 1.1, conifer(x, y, CONIFERS[0]) ? CONIFER : 1, 0.8]); index(trees.length - 1); }
      }
    }
  }
}
