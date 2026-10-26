import * as THREE from 'three';
import { Grid, fillPolys, strokeLines, rng } from './geo.ts';
import { cutAway, NOISE, NOISE_GLSL, LEAVES, SNOW, WET, BARE, SEASON } from '../shading.ts';
import { PITCH_KINDS } from './pitches.ts';
import { scatterWoods, edgeShrubs, conifer, toBand, WOOD, PARK, GROVE, SHRUB, CONIFER, CONIFERS } from './woodScatter.ts';
import type { Tree, Standing } from './woodScatter.ts';
import type { Geo, GeoData, Point2, Polygons } from './geo.ts';

// Experiment: the same crowns, with fewer rim vertices used only for their shadows.
// Opt-in: fixed-view phone gains repeat, but general driving gains are unresolved.
export const SIMPLE_TREE_SHADOWS = { value: new URLSearchParams(globalThis.location?.search ?? '').get('treeShadows') === 'simple' };

export interface TreeTileData extends GeoData {
  areas: Record<string, Polygons | undefined>;
  roads: Record<string, Polygons | undefined>;
  buildings: { rings: Point2[][] }[];
  walls: { kind: string; pts: Point2[] }[];
  trees: TreeSpot[];
  shrubs?: Point2[];
  canopy?: CanopyCells;
}

// What grows in the tile (pipeline/tree_sizes.py, canopy_cells): a grid of CANOPY_CELL metres
// from the tile's south-west corner, row by row from the south, as runs of three characters
// (the value, then the run's length in base 36): 0 nothing with leaves, 1 leaves no higher than
// 2.5 m, 2 to 4 canopy in the low, middle and tall bands.
export interface CanopyCells { w: number; h: number; runs: string }
const CANOPY_CELL = 2;

// A tree's place in metres, and what kind it is when the map knows: 1 a conifer, 2 a fruit
// tree (0 not known). Then, when the surface models show it, its top and its crown's
// radius in metres (pipeline/tree_sizes.py) and its outline (how far it reaches in OUTLINE
// directions, from the east anticlockwise, in hundredths of the radius); and when the summer
// photo shows it, its crown's colour there (red, green, blue, 0 to 255).
export type TreeSpot = [number, number, number?, number?, number?, ...number[]];
export const OUTLINE = 8;

// The instances run broadleaf, then `big` broadleaf (BIG_CROWN), then `shrubs`, then
// `conifers`: one page kind each.
// `yearly`: how each goes through the year: 1 an evergreen, which doesn't change; below
// 1 a tree that turns and sheds, and 2 and more a fruit tree, which also flowers. The
// fraction is the tree's own timing (early or late) and picks its autumn colour.
// `outlines`: OUTLINE numbers each, how far the crown reaches (1 its radius) in each
// direction of its own frame (turned with the instance), for the shader (outlineAt).
export interface TreeInstances { matrices: Float32Array; colours: Float32Array; yearly: Float32Array; outlines: Float32Array; count: number; big: number; shrubs: number; conifers: number }
// A broadleaf crown this wide (radius, m) and more is drawn with more, smaller tufts
// (bigCrownGeometry): a big old tree's crown is many clumps, not a small one's few blown up.
export const BIG_CROWN = 5;

// Land-use classes rasterised at 1 px/m, used to scatter trees. Walls are marked
// apart from buildings and paving: a garden tree may lean over a fence, not a roof.
// A courtyard, and ground nothing is mapped on (OPEN; often a courtyard too), get no trees
// made up but those the canopy shows (canopyTrees). 0 is built, paved or water.
const CLEARING = 100, GARDEN = 90, ORCHARD = 60, FIELD = 40, YARD = 5, OPEN = 2, FENCE = 1;
// Surveyed greenery (pipeline/ipr_greenery.py): grass where no tree is made up (the
// survey has the real ones), and groups of shrubs, which are filled with shrubs.
// A surveyed group of trees is planted like a park, only closer (GROVE, in woodScatter.ts).
const SURVEYED = 150, SHRUBBERY = 170, VERGE = 140;
// Of each kind of tree (below), how many are evergreen and keep their leaves in
// winter: yews and hedges among the shrubs. (Conifers have a shape of their own.)
const EVERGREEN = [0, 0, 0, 0.4];
// The usual crown's colour in IPR's summer photo, its haze taken off (red, green, blue: the
// median over the measured trees, pipeline/tree_sizes.py). A crown lighter or darker than
// that is a little lighter or darker in the game (by the share LIGHT; much of it is shade
// in the photo). Its hue moves the game's by how far its share of red, green and blue
// differs from the usual crown's, CHROMA times over (the photo's hues are pale). The
// palette has little blue, so this is added, not multiplied: a purple beech comes out
// purple. More blue counts only together with more red, fully from 2 points more (purple):
// blue with less red is mostly haze left over or shade, and would make the crown teal.
const PHOTO_CROWN = [46, 47, 34], LIGHT = 0.5, CHROMA = 2.5;
const PHOTO_SUM = PHOTO_CROWN[0] + PHOTO_CROWN[1] + PHOTO_CROWN[2];

// The game's crown colour `c` changed as the crown `seen` in the photo differs from the usual one.
function photoTint(c: THREE.Color, seen: number[]) {
  const sum = Math.max(1, seen[0] + seen[1] + seen[2]), light = (sum / PHOTO_SUM) ** LIGHT;
  const d = seen.map((v, k) => v / sum - PHOTO_CROWN[k] / PHOTO_SUM);
  if (d[2] > 0) d[2] *= Math.min(1, Math.max(0, d[0] / 0.02));
  d[0] = Math.max(d[0], -0.03); // (much less red is mostly shade too)
  d[1] -= d[0] + d[1] + d[2]; // (what the blue doesn't take goes to green)
  const most = Math.max(...d.map(Math.abs)); // (a few pixels can be far off: no more than 8 points)
  if (most > 0.08) d.forEach((v, k) => { d[k] = v * 0.08 / most; });
  const own = c.r + c.g + c.b;
  const share = [c.r, c.g, c.b].map((v, k) => Math.max(0.04, v / own + CHROMA * d[k]));
  const total = share[0] + share[1] + share[2];
  c.setRGB(...share.map((v) => v / total * own * Math.min(1.5, Math.max(0.55, light))) as [number, number, number]);
}

// Where a tile's trees stand, and how big and what colour they are: their instance
// matrices (standing on the terrain, `height(x, y)`) and colours, for treeMesh. Under
// a bridge a tree grows no higher than `room(x, y)` metres leaves it, or not at all.
// Runs in the tile workers.
export function treeInstances(geo: Geo<TreeTileData>, height: (x: number, y: number) => number = () => 0,
  room: (x: number, y: number) => number = () => Infinity): TreeInstances {
  const d = geo.data;
  const grid = new Grid(geo, 1, (ctx, s) => {
    ctx.fillStyle = `rgb(${OPEN},0,0)`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    const fill = (polys: Polygons | undefined, v: number) => {
      if (!polys) return;
      ctx.fillStyle = `rgb(${v},0,0)`;
      fillPolys(ctx, geo, polys, s);
    };
    fill(d.areas.field, FIELD);
    fill(d.areas.dtm_yard, YARD);
    fill(d.areas.dtm_green, PARK);
    fill(d.areas.dtm_garden, GARDEN);
    fill(d.areas.dtm_wood, WOOD);
    fill(d.areas.dtm_pitch, 0);
    fill(d.areas.cover_grass, GARDEN);
    fill(d.areas.garden, GARDEN);
    fill(d.areas.lawn, GARDEN);
    fill(d.areas.park, PARK);
    fill(d.areas.meadow, PARK);
    fill(d.areas.verge, VERGE); // grass with no trees made up on it: a verge is mown flat or left to weeds
    fill(d.areas.ipr_lawn, SURVEYED);
    fill(d.areas.ipr_meadow, SURVEYED);
    fill(d.areas.ipr_bed, SURVEYED);
    fill(d.areas.ipr_shrubs, SHRUBBERY);
    fill(d.areas.ipr_grove, GROVE);
    fill(d.areas.orchard, ORCHARD);
    fill(d.areas.wood, WOOD);
    // A clearing inside a wood (pipeline/young_woods.py): open grass, with only the shrubs
    // and odd young trees of a wood's edge round its rim.
    fill(d.areas.wood_clearing, CLEARING);
    // Keep trees off everything built or paved.
    fill(d.areas.worn, 0);
    fill(d.areas.square, 0);
    fill(d.areas.square_setts, 0);
    fill(d.areas.square_asphalt, 0);
    fill(d.areas.square_loose, 0);
    for (const k of PITCH_KINDS) fill(d.areas[k], 0);
    fill(d.areas.parking, 0);
    fill(d.areas.water, 0);
    fill(d.areas.pool, 0);
    fill(d.areas.bridge, 0);
    for (const k of Object.keys(d.roads)) fill(d.roads[k], 0);
    ctx.fillStyle = '#000';
    fillPolys(ctx, geo, d.buildings.map((b) => b.rings), s);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#000';
    ctx.stroke();
    ctx.strokeStyle = `rgb(${FENCE},0,0)`;
    strokeLines(ctx, geo, d.walls.map((w) => w.pts), s);
  });

  // Where the surface model says a mapped wood is still low (pipeline/young_woods.py): the
  // wood there is planted with small trees close together, not full-grown ones.
  const young = d.areas.young_wood?.length ? new Grid(geo, 1, (ctx, s) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = 'rgb(255,0,0)';
    fillPolys(ctx, geo, d.areas.young_wood!, s);
  }) : null;
  const isYoung = (x: number, y: number) => young !== null && young.at(x, y) > 127;
  // What grows where, and how high (pipeline/tree_sizes.py: the surface models and the summer
  // photo): no trees are made up where the photo shows no leaves; where it shows a canopy the
  // models measured, they're as high as its band; where it shows leaves the models don't
  // see high, they're made up as they always were, as in a tile made without it (Standing).
  const canopy = typeof d.canopy?.runs === 'string' ? canopyCells(d.canopy) : null;
  const standing: Standing = (x, y) => {
    if (!canopy) return -1;
    const i = Math.min(d.canopy!.w - 1, Math.max(0, Math.floor((x - geo.minX) / CANOPY_CELL)));
    const j = Math.min(d.canopy!.h - 1, Math.max(0, Math.floor((y - geo.minY) / CANOPY_CELL)));
    const v = canopy[j * d.canopy!.w + i];
    return v === 1 ? -1 : v === 0 ? 0 : v - 1;
  };

  const trees: Tree[] = []; // [x, y, radius, kind, height (1 for the usual)]
  const r = rng(42);
  // The surveyed trees (IPR's and OSM's), with which kind they are when it's known.
  const real = new Map<number, number[]>(); // (indices into `trees`, by REAL_CELL)
  const REAL_CELL = 16;
  for (const [x, y, k, top, radius, ...rest] of d.trees) {
    const kind = k === 1 ? CONIFER : k === 2 ? 2 : 1;
    if (top !== undefined && radius !== undefined && radius > 0) {
      trees.push([x, y, Math.min(Math.max(radius, 1.5), kind === 1 ? 9 : 5), kind, 1, false, top,
        rest.length === OUTLINE + 3 ? rest.slice(OUTLINE) : undefined, rest.length >= OUTLINE ? rest.slice(0, OUTLINE) : undefined]);
    } else if (top !== undefined && radius === 0) {
      // Lower than the surface models see a crown (tree_sizes.py gives it no radius): a
      // young tree, planted a few years ago, with a small crown on a thin stem.
      trees.push([x, y, (kind === CONIFER ? 1 : 1.2) + r() * 0.6, kind, 1, false, 4 + r() * 1.5]);
    } else if (k === 1) trees.push([x, y, 2.6 + r() * 1.8, CONIFER]);
    else if (k === 2) trees.push([x, y, 1.7 + r() * 0.9, 2]);
    else trees.push([x, y, 3 + r() * 2.5, 1]);
    const cell = Math.floor(x / REAL_CELL) * 65536 + Math.floor(y / REAL_CELL);
    const list = real.get(cell);
    if (list) list.push(trees.length - 1); else real.set(cell, [trees.length - 1]);
  }
  // Whether a surveyed tree stands within 3.5 m, or its crown covers the spot (the inner 85 %
  // of it where it was measured, by its outline): the trees we make up leave room for them.
  const surveyed = (x: number, y: number) => {
    const i0 = Math.floor(x / REAL_CELL), j0 = Math.floor(y / REAL_CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (const n of real.get(i * 65536 + j) ?? []) {
          const [tx, ty, rad, , , , top, , outline] = trees[n], d = Math.hypot(tx - x, ty - y);
          if (d < 3.5) return true;
          if (top === undefined) continue;
          const t = ((Math.atan2(y - ty, x - tx) / (2 * Math.PI) * OUTLINE) % OUTLINE + OUTLINE) % OUTLINE, k = Math.floor(t);
          const reach = outline ? (outline[k] * (k + 1 - t) + outline[(k + 1) % OUTLINE] * (t - k)) / 100 : 1;
          if (d < 0.85 * rad * reach) return true;
        }
      }
    }
    return false;
  };

  // Woods, young woods, the gaps between their crowns, and the loose trees of parks and
  // surveyed groves (woodScatter.ts). The crowns just past the tile's edge are worked out
  // too, so that the gaps are filled the same way on both sides; they are dropped below.
  const { covered, index } = scatterWoods(geo, grid, isYoung, surveyed, trees, standing);
  // The ragged edge: shrubs and a few young trees just outside the outline, where the
  // neighbour is grass, a field or a garden (never paving, a road or water).
  edgeShrubs(geo, grid, [GARDEN, PARK, FIELD, CLEARING, VERGE], surveyed, trees, covered, index, standing);
  // Orchards: loose rows, like the Petřín fruit gardens in the 1945 photo.
  for (let y = geo.minY; y < geo.maxY; y += 6) {
    for (let x = geo.minX; x < geo.maxX; x += 6) {
      if (grid.at(x, y) === ORCHARD && r() < 0.85 && standing(x, y) !== 0) trees.push([x + (r() - 0.5), y + (r() - 0.5), 1.7 + r() * 0.8, 2]);
    }
  }
  // (The neighbours' crowns have done their work: the gardens and the rest see only the tile's own.)
  trees.splice(0, trees.length, ...trees.filter((t) => !t[5]));
  gardenTrees(geo, grid, trees, standing);
  if (canopy) canopyTrees(geo, grid, trees, standing);
  // Surveyed groups of shrubs, filled from a lattice fixed to the map, and the single ones.
  // A tile with very large shrubberies gets fewer, larger shrubs: never more than MAX_BUSHES.
  const BUSH = 2.2, MAX_BUSHES = 500, found: [number, number, number, number][] = [];
  for (let j = Math.ceil(geo.minY / BUSH); j * BUSH < geo.maxY; j++) {
    for (let i = Math.ceil(geo.minX / BUSH); i * BUSH < geo.maxX; i++) {
      const g = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ 0x3e71);
      const x = (i + 0.2 + g() * 0.6) * BUSH, y = (j + 0.2 + g() * 0.6) * BUSH;
      if (grid.at(x, y) === SHRUBBERY) found.push([x, y, 1.1 + g() * 0.6, g()]);
    }
  }
  const keep = Math.min(1, MAX_BUSHES / Math.max(1, found.length)), grow = Math.min(1.8, 1 / Math.sqrt(keep));
  for (const [x, y, rad, pick] of found) if (pick < keep) trees.push([x, y, rad * grow, SHRUB]);
  for (const [x, y] of d.shrubs ?? []) trees.push([x, y, 0.9 + r() * 0.7, SHRUB]);

  // The big crowns, the shrubs, then the conifers, last: each has its own mesh.
  const isBig = (t: Tree) => t[3] === 1 && t[2] >= BIG_CROWN;
  const bushes = trees.filter((t) => t[3] === SHRUB), pines = trees.filter((t) => t[3] === CONIFER), bigs = trees.filter(isBig);
  trees.splice(0, trees.length, ...trees.filter((t) => t[3] !== SHRUB && t[3] !== CONIFER && !isBig(t)), ...bigs, ...bushes, ...pines);
  const big = bigs.length, shrubs = bushes.length, conifers = pines.length;
  const matrices = new Float32Array(trees.length * 16), colours = new Float32Array(trees.length * 3);
  const yearly = new Float32Array(trees.length), outlines = new Float32Array(trees.length * OUTLINE);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const colors = [
    [new THREE.Color('#5a7c38'), new THREE.Color('#4a6a30'), new THREE.Color('#6a8c40')],
    [new THREE.Color('#6f9440'), new THREE.Color('#7f9c45'), new THREE.Color('#5f8638')],
    [new THREE.Color('#7f9a52'), new THREE.Color('#8ea85c'), new THREE.Color('#74924a')], // fruit trees (in flower in spring: leafy)
    [new THREE.Color('#5a7a38'), new THREE.Color('#68883e'), new THREE.Color('#779646'), new THREE.Color('#4e6c3a')], // shrubs, hedges, yews
    [new THREE.Color('#3f5e3a'), new THREE.Color('#34523a'), new THREE.Color('#4a6842')], // conifers
  ];
  const c = new THREE.Color();
  trees.forEach(([x, y, rad, kind, tall = 1, , measured, seen, outline], i) => {
    // A shrub's crown sits on the ground, a little flattened.
    let h = kind === SHRUB ? rad * (0.42 + r() * 0.12) : rad * (1.6 + r() * 0.6) * tall;
    let deep = kind === SHRUB ? 0.65 + r() * 0.2 : (0.85 + r() * 0.3) * tall; // the crown's height to its width
    // The crown's top is 0.75 of its height above its centre (a conifer's, 1.4).
    const above = kind === CONIFER ? 1.4 : 0.75;
    if (measured !== undefined) {
      // A measured tree: its top where the surface models have it, and a tall tree's crown
      // deeper than wide, about half its height (a conifer's, more).
      deep = Math.min(1.8, Math.max(deep, measured * (kind === CONIFER ? 0.35 : 0.27) / (above * rad)));
      h = Math.max(measured - above * deep * rad, 0.5 * rad);
    }
    const top = h + rad * deep * above, fit = Math.min(1, (room(x, y) - 0.5) / top);
    if (fit < 1) {
      rad *= fit < 0.35 ? 0 : fit;
      h *= fit < 0.35 ? 0 : fit;
    }
    p.set(x, h, -y);
    const turn = r() * Math.PI;
    q.setFromEuler(new THREE.Euler(0, turn, 0));
    // The outline in the crown's own frame: what lies at `a` in it lies at a + turn on the map.
    // A crown that wasn't measured is a little uneven all the same.
    const wobble = outline ? null : Array.from({ length: OUTLINE }, () => 0.9 + r() * 0.2);
    for (let j = 0; j < OUTLINE; j++) {
      if (!outline) { outlines[i * OUTLINE + j] = wobble![j]; continue; }
      const t = ((j + turn / (2 * Math.PI) * OUTLINE) % OUTLINE + OUTLINE) % OUTLINE, k = Math.floor(t), f = t - k;
      outlines[i * OUTLINE + j] = (outline[k] * (1 - f) + outline[(k + 1) % OUTLINE] * f) / 100;
    }
    const w = rad * (0.9 + r() * 0.2);
    sc.set(w, rad * deep, rad * (0.9 + r() * 0.2));
    m.compose(p, q, sc);
    m.elements[13] += height(x, y);
    m.toArray(matrices, i * 16);
    const pal = colors[kind];
    c.copy(pal[Math.floor(r() * pal.length)]).offsetHSL(0, 0, (r() - 0.5) * 0.05);
    // A crown seen in the photo differs from the usual one as it does there: the photo's own
    // cast (a bluish haze) is the same on both and drops out.
    if (seen) photoTint(c, seen);
    c.toArray(colours, i * 3);
    // (By where it stands, so the other trees' looks don't change.)
    const own = rng(Math.imul(Math.floor(x * 8), 73856093) ^ Math.imul(Math.floor(y * 8), 19349663));
    yearly[i] = kind === CONIFER || own() < EVERGREEN[kind] ? 1 : (kind === 2 ? 2 : 0) + own() * 0.98;
  });
  return { matrices, colours, yearly, outlines, count: trees.length, big, shrubs, conifers };
}


// Gardens round houses and in courtyards: a few trees and shrubs scattered over the
// grass, clear of the houses, streets and paths (a crown may lean over a fence) and of
// the trees already there, fewer than in a park. Each spot's own random numbers come
// from where it is, so a garden looks the same every time it loads, whatever else
// the tile has.
function gardenTrees(geo: Geo, grid: Grid, trees: Tree[], standing: Standing) {
  // The trees already placed, in 8 m cells, to keep new ones apart from them.
  const CELL = 8, near = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 65536 + j;
  const index = (t: number) => {
    const k = key(Math.floor(trees[t][0] / CELL), Math.floor(trees[t][1] / CELL));
    const list = near.get(k);
    if (list) list.push(t); else near.set(k, [t]);
  };
  for (let t = 0; t < trees.length; t++) index(t);
  const crowded = (x: number, y: number, rad: number, apart: number) => {
    const i0 = Math.floor(x / CELL), j0 = Math.floor(y / CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        for (const t of near.get(key(i, j)) || []) {
          const [tx, ty, tr] = trees[t];
          if (Math.hypot(tx - x, ty - y) < (tr + rad) * apart) return true;
        }
      }
    }
    return false;
  };
  // Grass under the middle, and nothing built or paved under the inner part of the crown
  // (a ring of eight points at `inside` of its radius; the outer part may lean over a
  // fence, a path or a house's eaves, as big crowns do in a real garden).
  const clear = (x: number, y: number, rad: number, inside = 0.5) => {
    if (grid.at(x, y) !== GARDEN) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      if (grid.at(x + c * rad * inside, y + s * rad * inside) === 0) return false;
    }
    return true;
  };
  // Candidates on a lattice fixed to the map, not the tile, each with its own seed.
  const scatter = (step: number, salt: number, place: (x: number, y: number, g: () => number) => void) => {
    for (let j = Math.ceil(geo.minY / step); j * step < geo.maxY; j++) {
      for (let i = Math.ceil(geo.minX / step); i * step < geo.maxX; i++) {
        const g = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ salt);
        place((i + 0.15 + g() * 0.7) * step, (j + 0.15 + g() * 0.7) * step, g);
      }
    }
  };
  // Trees first: small ones (fruit trees, birches, a lilac grown tall) and, in four
  // of ten, a big old crown. From above, crowns cover a good part of a villa garden,
  // so there are only a few more trees than before; the big ones make up the rest.
  scatter(8, 0x51f3, (x, y, g) => {
    if (g() > 0.3) return;
    const rad = g() < 0.4 ? 3.8 + g() * 2.2 : 1.8 + g() * 1.4, band = standing(x, y);
    if (band === 0 || !clear(x, y, rad, 0.6) || crowded(x, y, rad, 0.7)) return;
    trees.push(toBand(conifer(x, y, CONIFERS[1]) ? [x, y, rad * 0.8, CONIFER] : [x, y, rad, g() < 0.15 ? 2 : 1], band, g()));
    index(trees.length - 1);
  });
  // Then shrubs, along the edges as much as in the open.
  scatter(5.5, 0x2c9e, (x, y, g) => {
    if (g() > 0.1) return;
    const rad = 0.8 + g() * 0.9;
    if (!clear(x, y, rad + 0.3, 1) || crowded(x, y, rad, 0.7)) return;
    trees.push([x, y, rad, SHRUB]);
    index(trees.length - 1);
  });
}

// The cells of a tile's canopy layer (CanopyCells), row by row from the south.
function canopyCells({ w, h, runs }: CanopyCells) {
  const cells = new Uint8Array(w * h);
  for (let k = 0, at = 0; k + 2 < runs.length && at < cells.length; k += 3) {
    const n = parseInt(runs.slice(k + 1, k + 3), 36);
    cells.fill(+runs[k], at, Math.min(cells.length, at + n));
    at += n;
  }
  return cells;
}

// The canopy that no crown covers yet (in courtyards and private gardens, where no tree is
// mapped, or where a wood's are fewer than its canopy): trees on a lattice fixed to the map,
// sized for the band they stand in, never on a road, a building or paving (the land class 0).
function canopyTrees(geo: Geo, grid: Grid, trees: Tree[], standing: Standing) {
  const CELL = 8, near = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 65536 + j;
  const index = (t: number) => {
    if (trees[t][3] === SHRUB) return;
    const k = key(Math.floor(trees[t][0] / CELL), Math.floor(trees[t][1] / CELL));
    const list = near.get(k);
    if (list) list.push(t); else near.set(k, [t]);
  };
  for (let t = 0; t < trees.length; t++) index(t);
  const covered = (x: number, y: number) => {
    const i0 = Math.floor(x / CELL), j0 = Math.floor(y / CELL);
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      for (let j = j0 - 2; j <= j0 + 2; j++) {
        for (const t of near.get(key(i, j)) || []) if (Math.hypot(trees[t][0] - x, trees[t][1] - y) < trees[t][2] * 0.9) return true;
      }
    }
    return false;
  };
  // The trunk's ground and a little round it: the land raster's edges are blended, so a
  // spot just inside a road's or a building's outline can still read as something else.
  const open = (x: number, y: number) => grid.at(x, y) !== 0 && [0, 1, 2, 3, 4, 5, 6, 7].every((k) =>
    grid.at(x + Math.cos(k * Math.PI / 4) * 1.2, y + Math.sin(k * Math.PI / 4) * 1.2) > FENCE);
  const STEP = 3.5, SIZE = [0, 1.6, 2.8, 3.6], MORE = [0, 1, 1.4, 1.6]; // (each band's smallest crown, and how much larger one can be)
  for (let j = Math.ceil(geo.minY / STEP); j * STEP < geo.maxY; j++) {
    for (let i = Math.ceil(geo.minX / STEP); i * STEP < geo.maxX; i++) {
      const g = rng(Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ 0x6c3a);
      const x = (i + 0.15 + g() * 0.7) * STEP, y = (j + 0.15 + g() * 0.7) * STEP, band = standing(x, y);
      if (band < 1 || !open(x, y) || covered(x, y)) continue;
      const rad = (SIZE[band] + g() * MORE[band]) / (band === 1 ? 0.65 : band === 3 ? 1.2 : 1); // (toBand scales it back)
      trees.push(toBand(conifer(x, y, CONIFERS[1]) ? [x, y, rad * 0.8, CONIFER] : [x, y, rad, 1], band, g()));
      index(trees.length - 1);
    }
  }
}

// A crown: tufts of leaves in tiers, like shingles, round a dark core that fills the
// gaps between them. Each tuft is a low dome with a ragged outline of five lobes,
// tilted outwards the further down the crown it sits, with normals that bulge so
// every tuft has its own lit edge and shaded underside; the upper tufts shade the ones
// below. Lower tiers are darker (vertex colours, multiplied by each tree's own
// colour). The tufts are real geometry rather than shapes cut out of cards, so they're
// opaque: what's hidden needn't be shaded, the edges are antialiased like any mesh's
// and the shadows need no material of their own. Top tier first, so what it covers is
// skipped. About 340 triangles, shared by every tree of a tile.
// `tuft`: where on the tuft a vertex is (-1…1 across) and the tuft's seed.
// [tufts, distance from the middle, height, tilt, half size]
type Tier = [number, number, number, number, number];
const CROWN_TIERS: Tier[] = [[7, 0.64, -0.08, 62, 0.48], [5, 0.4, 0.2, 40, 0.46], [3, 0.18, 0.4, 20, 0.4], [1, 0, 0.5, 0, 0.36]];
// A shrub is the same in the same frame: nine larger tufts with an eight-point outline
// round a lighter core (about 90 triangles). The first version, seven small tufts
// round a dark core, showed gaps and a spiky outline from above; these overlap.
const SHRUB_TIERS: Tier[] = [[5, 0.6, -0.05, 56, 0.6], [3, 0.3, 0.24, 30, 0.6], [1, 0, 0.44, 0, 0.55]];
// A big crown: the same frame with five tiers of 34 smaller tufts (about 720 triangles).
// (Its tufts overlap more and its core is lighter: through the gaps between small tufts,
// a dark core made the whole crown darker than a small one.)
const BIG_TIERS: Tier[] = [[12, 0.68, -0.1, 64, 0.38], [10, 0.5, 0.12, 48, 0.37], [7, 0.3, 0.3, 32, 0.35], [4, 0.14, 0.44, 16, 0.33], [1, 0, 0.52, 0, 0.3]];
const crownGeometry = () => crownShape(7, 20, CROWN_TIERS);
const bigCrownGeometry = () => crownShape(11, 16, BIG_TIERS, 0.6, 0.45);
const shrubGeometry = () => crownShape(13, 8, SHRUB_TIERS, 0.55, 0.45);
function crownShape(seed0: number, RIM: number, tiers: Tier[], coreSize = 0.56, coreShade = 0.32) {
  const r = rng(seed0);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], tuft: number[] = [], idx: number[] = [];
  const shadowIdx: number[] = [];
  const across: number[] = [], along: number[] = []; // each tuft's card, for its leaves
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);
  const t = new THREE.Vector3(), b = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
  const bulge = new THREE.Vector3(), round = new THREE.Vector3();
  const card = (c: THREE.Vector3, normal: THREE.Vector3, size: number, shade: number) => {
    t.crossVectors(Math.abs(normal.y) > 0.99 ? side : up, normal).normalize();
    b.crossVectors(normal, t);
    const spin = r() * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
    const tx = t.clone().multiplyScalar(cs).addScaledVector(b, sn), bx = b.clone().multiplyScalar(cs).addScaledVector(t, -sn);
    const seed = r(), base = pos.length / 3, sa = seed * Math.PI * 2;
    // A low dome: the middle raised a little, and round it the outline, four points
    // to a lobe (the leaf shader lays its leaves out by the same lobes).
    const ring: [number, number, number][] = [[0, 0, 0.35]];
    for (let j = 0; j < RIM; j++) {
      const th = (j / RIM) * Math.PI * 2 - sa;
      const e = 0.8 + 0.13 * Math.cos(5 * (th + sa)) + 0.05 * Math.cos(11 * th + sa * 3);
      ring.push([Math.cos(th) * e, Math.sin(th) * e, 0]);
    }
    for (const [u, v, h] of ring) {
      p.copy(c).addScaledVector(tx, u * size).addScaledVector(bx, v * size).addScaledVector(normal, h * size);
      bulge.copy(normal).addScaledVector(tx, u).addScaledVector(bx, v).normalize();
      round.copy(p).normalize();
      n.copy(bulge).addScaledVector(round, 0.7).normalize();
      pos.push(p.x, p.y, p.z);
      nor.push(n.x, n.y, n.z);
      col.push(shade, shade, shade);
      tuft.push(u, v, seed);
      across.push(tx.x, tx.y, tx.z);
      along.push(bx.x, bx.y, bx.z);
    }
    for (let j = 0; j < RIM; j++) idx.push(base, base + 1 + j, base + 1 + ((j + 1) % RIM));
    // Keep the tuft's centre, seed and coordinate frame (including winter's twig
    // mask). Only its rim is coarser; the visible crown still uses every vertex.
    const rim = Math.min(8, RIM);
    for (let j = 0; j < rim; j++) shadowIdx.push(base, base + 1 + Math.floor(j * RIM / rim), base + 1 + Math.floor(((j + 1) % rim) * RIM / rim));
  };
  const c = new THREE.Vector3(), normal = new THREE.Vector3();
  tiers.map((t, tier) => [t, tier] as const).reverse().forEach(([[count, dist, y, tilt, size], tier]) => {
    const phase = r() * Math.PI * 2, lift = tier / (tiers.length - 1);
    for (let i = 0; i < count; i++) {
      const a = phase + (i / count) * Math.PI * 2 + (r() - 0.5) * 0.4;
      const d = dist * (0.9 + r() * 0.2), tl = THREE.MathUtils.degToRad(tilt * (0.85 + r() * 0.3));
      c.set(Math.cos(a) * d, y + (r() - 0.5) * 0.08, Math.sin(a) * d);
      normal.set(Math.cos(a) * Math.sin(tl), Math.cos(tl), Math.sin(a) * Math.sin(tl));
      card(c, normal, size * (0.9 + r() * 0.2), (0.7 + 0.3 * lift) * (0.9 + r() * 0.2));
    }
  });
  // The core, round and dark, behind the tufts.
  const core = new THREE.IcosahedronGeometry(coreSize, 0);
  const cp = core.attributes.position.array;
  for (let i = 0; i < cp.length; i += 3) {
    p.set(cp[i], cp[i + 1] * 0.7, cp[i + 2]);
    n.set(cp[i], cp[i + 1], cp[i + 2]).normalize();
    idx.push(pos.length / 3);
    shadowIdx.push(pos.length / 3);
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
    col.push(coreShade, coreShade, coreShade);
    tuft.push(0, 0, -1); // (no leaves)
    across.push(1, 0, 0);
    along.push(0, 0, 1);
  }
  core.dispose();
  const geom = crownBuffers({ pos, nor, col, tuft, across, along, idx: RIM > 8 ? [...idx, ...shadowIdx] : idx });
  geom.setDrawRange(0, idx.length);
  if (RIM > 8) geom.userData.simpleShadowRange = { start: idx.length, count: shadowIdx.length };
  return geom;
}

interface CrownArrays { pos: number[]; nor: number[]; col: number[]; tuft: number[]; across: number[]; along: number[]; idx: number[] }

function crownBuffers({ pos, nor, col, tuft, across, along, idx }: CrownArrays) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // One vertex buffer for the three (WebGPU allows eight, and the instances need theirs).
  const leaf = new Float32Array(tuft.length * 3);
  for (let i = 0; i < tuft.length / 3; i++) { leaf.set(tuft.slice(i * 3, i * 3 + 3), i * 9); leaf.set(across.slice(i * 3, i * 3 + 3), i * 9 + 3); leaf.set(along.slice(i * 3, i * 3 + 3), i * 9 + 6); }
  const leaves = new THREE.InterleavedBuffer(leaf, 9);
  geom.setAttribute('tuft', new THREE.InterleavedBufferAttribute(leaves, 3, 0));
  geom.setAttribute('across', new THREE.InterleavedBufferAttribute(leaves, 3, 3));
  geom.setAttribute('along', new THREE.InterleavedBufferAttribute(leaves, 3, 6));
  geom.setIndex(idx);
  // Every tile's trees use these buffers: the WebGPU renderer must keep them when one tile goes.
  for (const a of [geom.index, ...Object.values(geom.attributes)]) if (a) (a as { shared?: boolean }).shared = true;
  return geom;
}
let crown: THREE.BufferGeometry | null = null, shrub: THREE.BufferGeometry | null = null, bigCrown: THREE.BufferGeometry | null = null;
let treeFactories = 0;

// A conifer: tiers of spiky skirts, one on top of the next and narrowing to a tip,
// round a bare trunk. Its local frame is the broadleaf crown's (scaled the same way
// by each tree's matrix), but it runs from -1.5 to 1.4, low enough to stand near the
// ground. No tufts, so no leaves: the shader takes its `tuft.z < 0` for a plain
// surface, and the tiers are shaded by their vertex colours, the underside darkest.
function pineGeometry() {
  const r = rng(11);
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, shade: number) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    pos.push(x, y, z);
    nor.push(nx / l, ny / l, nz / l);
    col.push(shade, shade, shade);
    return pos.length / 3 - 1;
  };
  const TIERS = 6, SIDES = 14;
  for (let i = 0; i < TIERS; i++) {
    const t = i / (TIERS - 1);
    const yb = -1.5 + i * 0.42, ya = Math.min(1.4, yb + 1.0), rb = 0.8 * (1 - t * 0.78);
    const shade = 0.6 + 0.3 * t;
    const apex = vertex(0, ya, 0, 0, 1, 0, Math.min(1, shade + 0.15));
    const under = vertex(0, yb + 0.16, 0, 0, -1, 0, 0.3);
    const spin = r() * Math.PI * 2;
    const rim: number[] = [], low: number[] = [];
    for (let j = 0; j < SIDES; j++) {
      const a = spin + (j / SIDES) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const spike = j % 2 ? 1 : 0.8 + r() * 0.1;
      const rad = rb * spike, y = yb - (j % 2 ? 0.07 : 0);
      rim.push(vertex(c * rad, y, sn * rad, c * 0.8, 0.55, sn * 0.8, shade * (0.85 + r() * 0.1)));
      low.push(vertex(c * rad, y, sn * rad, 0, -1, 0, 0.32));
    }
    for (let j = 0; j < SIDES; j++) {
      const k = (j + 1) % SIDES;
      idx.push(apex, rim[k], rim[j], under, low[j], low[k]);
    }
  }
  // The trunk, from below the ground to the lowest tier.
  const base = pos.length / 3, N = 6;
  for (let j = 0; j < N; j++) {
    const a = (j / N) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    vertex(c * 0.06, -2.7, sn * 0.06, c, 0, sn, 0.3);
    vertex(c * 0.05, -0.9, sn * 0.05, c, 0, sn, 0.3);
  }
  for (let j = 0; j < N; j++) {
    const a = base + j * 2, b = base + ((j + 1) % N) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const n = pos.length / 3;
  const tuft: number[] = [], across: number[] = [], along: number[] = [];
  for (let i = 0; i < n; i++) { tuft.push(0, 0, -1); across.push(1, 0, 0); along.push(0, 0, 1); }
  return crownBuffers({ pos, nor, col, tuft, across, along, idx });
}
let pine: THREE.BufferGeometry | null = null;

// TUFT_RIM: how dark a tuft's rim is (the same in webgpu/trees.ts).
const TUFT_GLSL = 'varying vec3 vTuft;\nconst float TUFT_RIM = .5;';
// Cells for the small leaves: x = gap to the next leaf, y = random, zw = from the
// leaf's middle. Only the four nearest cells are searched (their points kept near the
// middle of each cell so that's enough).
const SMALL_LEAVES_GLSL = /* glsl */ `
vec4 smallLeaves(vec2 p) {
  vec2 i = floor(p - .5), f = p - i;
  float d1 = 8., d2 = 8.;
  vec2 o1 = vec2(0.), c1 = vec2(0.);
  for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {
    vec2 g = vec2(x, y), r = g + vec2(hash12(i + g), hash12(i + g + 17.3)) * .75 + .125 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; o1 = r; c1 = i + g; } else if (d < d2) d2 = d;
  }
  return vec4(sqrt(d2) - sqrt(d1), hash12(c1 + 5.1), -o1);
}
`;
// Bare in winter (BARE), each tree but the evergreens, the early ones first: of every tuft only twigs are
// left, where the small leaves' cells meet, and a few boughs out from its middle;
// the rest falls cell by cell as it grows. The core shrinks to the thicker branches.
// -1 where there's nothing, else how much of a twig it is.
const BARE_GLSL = /* glsl */ `
float bareTwig(vec3 t, float bare) {
  if (bare <= 0.) return 0.;
  if (t.z < 0.) return bare;
  float r = length(t.xy), s = t.z * 6.2832;
  // Boughs out from the middle, wavering, thinner outwards, forking halfway.
  float a = atan(t.y, t.x) + .25 * sin(r * 9. + s);
  float bough = abs(fract(a * 7. / 6.2832 + t.z * 3.) - .5) * r * 6.2832 / 7.;
  float fork = abs(fract(a * 14. / 6.2832 + t.z * 5.) - .5) * r * 6.2832 / 14.;
  float twig = max(step(bough, .045 - .025 * r), step(fork, .025 - .012 * r) * step(.45, r));
  // Twigs at the ends: bits of the small leaves' cell edges, not all of them.
  vec4 c = smallLeaves(t.xy * 5. + t.z * 31.);
  twig = max(twig, step(c.x, .06) * step(.5, r) * step(.4, hash12(floor(t.xy * 9. + t.z * 17.))));
  if (twig < .5 && c.y < bare) return -1.;
  return twig * bare;
}
`;
// How far the crown reaches (1 its radius) towards `p`, in its own frame: between the
// OUTLINE directions of its outline (TreeInstances.outlines), from the east anticlockwise
// (the map's y is the scene's -z).
const OUTLINE_GLSL = `attribute vec4 outlineA;
attribute vec4 outlineB;
float outlineAt(vec3 p) {
  float t = atan(-p.z, p.x) / .7853982, s = 0.;
  for (int k = 0; k < 4; k++) {
    s += max(0., 1. - abs(mod(t - float(k) + 4., 8.) - 4.)) * outlineA[k];
    s += max(0., 1. - abs(mod(t - float(k + 4) + 4., 8.) - 4.)) * outlineB[k];
  }
  return s;
}`;
const TUFT_VERTEX = ['#include <common>', `#include <common>\nattribute vec3 tuft;\nattribute float yearly;\nuniform float uBare;\nvarying vec3 vTuft;\nvarying float vBare;\n${OUTLINE_GLSL}`] as const;
const TUFT_BEGIN = ['#include <begin_vertex>', `#include <begin_vertex>
  vTuft = tuft;
  vBare = clamp(uBare * 1.6 - fract(yearly) * .6, 0., 1.) * (1. - step(.995, yearly) * step(yearly, 1.5));
  if (tuft.z < 0.) transformed *= 1. - .5 * vBare;
  transformed.xz *= outlineAt(transformed);`] as const;

// The leaves' colour through the year (SEASON), worked out for each corner of a tuft:
// new leaves a light yellow-green; in autumn each tree turns in its own time, tuft by
// tuft, to its own yellow, ochre, rust or (a few) red; fruit trees white or pale pink
// while they flower. As bright as the green it replaces was shaded.
const YEAR_VERTEX = ['#include <color_vertex>', `#include <color_vertex>
  {
    float own = fract(yearly), changes = 1. - step(.995, yearly) * step(yearly, 1.5);
    float pick = fract(own * 7.31 + .13);
    float shade = min(dot(vColor.rgb, vec3(.3, .59, .11)) / .15, 1.6);
    vColor.rgb *= mix(vec3(1.), vec3(1.3, 1.25, .7), uSeason.z * changes);
    vec3 autumn = mix(vec3(.58, .39, .03), vec3(.32, .1, .02), smoothstep(.25, .85, pick));
    autumn = mix(autumn, vec3(.27, .03, .014), step(.9, pick));
    float turn = clamp(uSeason.x * 1.7 - clamp(own + (tuft.z - .5) * .3, 0., 1.) * .7, 0., 1.) * changes;
    vColor.rgb = mix(vColor.rgb, autumn * shade * .7, turn);
    vec3 flower = mix(vec3(.8, .78, .72), vec3(.8, .6, .62), step(.6, pick));
    vColor.rgb = mix(vColor.rgb, flower * shade * .7, uSeason.y * step(1.5, yearly) * step(0., tuft.z) * .85);
  }`] as const;

// Leaves: every tuft is five big leaves with five smaller ones on top, set between
// them. Each leaf is flat and tilted its own way, outwards (the top ones less), so
// the light changes leaf by leaf, with hard edges and a thin dark crease where two
// meet, not in one smooth gradient over the tuft. Leaves in the light go a little
// yellow, as sunlight through leaves does, and the shade a little blue-green.
function leafy(material: THREE.MeshLambertMaterial) {
  const before = material.onBeforeCompile; // (the tunnel's hole, see treeMesh)
  material.onBeforeCompile = (sh, renderer) => {
    before.call(material, sh, renderer);
    sh.uniforms.uLeaves = LEAVES;
    sh.uniforms.uSnow = SNOW;
    sh.uniforms.uWet = WET;
    sh.uniforms.uBare = BARE;
    sh.uniforms.uSeason = SEASON;
    sh.vertexShader = sh.vertexShader.replace(...TUFT_VERTEX).replace(...TUFT_BEGIN).replace(...YEAR_VERTEX)
      .replace('#include <common>', '#include <common>\nuniform vec4 uSeason;')
      .replace('#include <common>', '#include <common>\nattribute vec3 across;\nattribute vec3 along;\nvarying vec3 vAcross;\nvarying vec3 vAlong;')
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
  vAcross = normalMatrix * mat3(instanceMatrix) * across;
  vAlong = normalMatrix * mat3(instanceMatrix) * along;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${TUFT_GLSL}\n${NOISE_GLSL}\n${SMALL_LEAVES_GLSL}\n${BARE_GLSL}\nvarying float vBare;\nfloat twigAmt = 0.;\nuniform float uLeaves;\nuniform float uSnow;\nuniform float uWet;\nvarying vec3 vAcross;\nvarying vec3 vAlong;\nfloat leafCrease = 1.;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  // (Derivatives first, outside the branches. A tuft only a few pixels across gets
  // no leaves at all.)
  float tw = fwidth(length(vTuft.xy));
  float sd = detail(vTuft.xy * 8., 1.5);
  twigAmt = bareTwig(vTuft, vBare);
  if (twigAmt < 0.) discard;
  if (uLeaves > .5 && vTuft.z >= 0. && tw < .3) {
    float r = length(vTuft.xy), s = vTuft.z * 6.2832, k = 6.2832 / 5.;
    float a0 = atan(vTuft.y, vTuft.x);
    // The top leaves have lobed edges of their own; the edges between leaves curve a
    // little, as where leaves overlap.
    float topEdge = .44 + .1 * cos(5. * (a0 + s) + 3.1416);
    float top = step(r, topEdge);
    float a = a0 + s + top * k * .5 + .7 * r;
    float f = a / k + .5, leaf = floor(f);
    float mid = leaf * k - s - top * k * .5;                        // the leaf's middle
    vec3 T = normalize(vAcross), B = normalize(vAlong), N = normalize(cross(T, B));
    if (dot(N, normal) < 0.) N = -N;
    float rnd = fract(sin(leaf * 12.9 + s * 7.) * 43758.5);
    float tilt = mix(.95, .45, top) * (.6 + .8 * rnd) * smoothstep(.08, .22, r);
    vec3 ln = normalize(N + (T * cos(mid + rnd - .5) + B * sin(mid + rnd - .5)) * tilt);
    normal = normalize(mix(normal, ln, .6));
    float gap = min(fract(f), 1. - fract(f)) * k * r;                // to the next leaf
    float w = tw + .008;
    leafCrease = mix(.78, 1., smoothstep(0., w * 1.5, gap) + (1. - smoothstep(.1, .2, r)))
      * mix(.75, 1., smoothstep(0., w * 1.5, abs(r - topEdge)));
    // Small leaves all over: each a little dome of its own, turned and lit a little
    // differently, which breaks the light up into a fine grain.
    // (Only where they're big enough to see: most of a wood seen from high up is
    // too far for them, and they're the costliest part of a tree.)
    if (sd > .01) {
      vec4 sl = smallLeaves(vTuft.xy * 8.);
      vec2 jit = vec2(hash12(sl.yy * 91.), hash12(sl.yy * 37. + 3.)) - .5;
      normal = normalize(normal + (T * (sl.z * 1.3 + jit.x * .7) + B * (sl.w * 1.3 + jit.y * .7)) * sd);
      leafCrease *= mix(1., (.78 + .38 * sl.y) * mix(.7, 1., smoothstep(0., .12, sl.x)), sd);
    }
  }
  // Each tuft darker towards its rim, where the next one overlaps it and shades it: from
  // above, the crown shows its clumps with shadow in the gaps between them. (Its middle is
  // a little lighter, so the crown as a whole is about as light as it was.)
  if (vTuft.z >= 0.) leafCrease *= mix(TUFT_RIM, 1.1, 1. - smoothstep(.35, .85, length(vTuft.xy)));`)
      .replace('#include <lights_lambert_fragment>', `diffuseColor.rgb *= leafCrease * (1. - .18 * uWet);
  // Twigs and branches: grey-brown bark.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.3, .27, .24), twigAmt);
  // Snow on the tops of the crowns (weather.ts); wet leaves a little darker.
  if (uSnow > .01) {
    float up = dot(normal, (viewMatrix * vec4(0., 1., 0., 0.)).xyz);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.78, .8, .84), smoothstep(.35, .8, up) * smoothstep(.2, .8, uSnow) * (.75 - .45 * twigAmt));
  }
#include <lights_lambert_fragment>`)
      .replace('#include <opaque_fragment>', `outgoingLight *= mix(vec3(.88, 1., 1.06), vec3(1.14, 1.06, .7), smoothstep(.04, .3, dot(outgoingLight, vec3(.3, .59, .11))));
  #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'tufts-cut';
  return material;
}

// The renderer owns these shapes and this material for the whole forest's lifetime.
// Tile workers import this module too, so create them only when the renderer asks.
export function treePageFactory() {
  crown ??= crownGeometry();
  shrub ??= shrubGeometry();
  pine ??= pineGeometry();
  bigCrown ??= bigCrownGeometry();
  const shapes = [crown, shrub, pine, bigCrown]; // (by TreeKind)
  treeFactories++;
  // Opened round you, like the buildings, when you're in a tunnel under a park.
  const material = leafy(cutAway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'trees'));
  const create = (kind: number, capacity: number) => {
    const geom = new THREE.BufferGeometry();
    const shape = shapes[kind];
    geom.setIndex(shape.index);
    geom.setDrawRange(shape.drawRange.start, shape.drawRange.count);
    for (const [name, attr] of Object.entries(shape.attributes)) geom.setAttribute(name, attr);
    geom.setAttribute('yearly', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1));
    // The outline (TreeInstances.outlines), four directions in each.
    geom.setAttribute('outlineA', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(1), 4));
    geom.setAttribute('outlineB', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4).fill(1), 4));
    const mesh = new THREE.InstancedMesh(geom, material, capacity);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = 0;
    mesh.visible = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // WebGL's depth pass needs its own variant when switching between trees and buildings.
    mesh.customDepthMaterial = treeDepth;
    const simple = shape.userData.simpleShadowRange as { start: number; count: number } | undefined;
    if (simple) {
      const full = { ...shape.drawRange };
      let shadowCamera: THREE.Camera | null = null;
      const restore = () => geom.setDrawRange(full.start, full.count);
      mesh.onBeforeShadow = (_renderer, _object, _camera, camera) => {
        shadowCamera = camera;
        const range = SIMPLE_TREE_SHADOWS.value ? simple : full;
        geom.setDrawRange(range.start, range.count);
      };
      mesh.onAfterShadow = () => { restore(); shadowCamera = null; };
      // Also recover the visible range if a shadow render threw before its after hook.
      mesh.onBeforeRender = (_renderer, _scene, camera) => { if (camera !== shadowCamera) restore(); };
      geom.userData.simpleShadowRange = simple;
    }
    return mesh;
  };
  return { create, dispose: () => {
    material.dispose();
    if (--treeFactories === 0) {
      // Shared attributes survive individual page disposal. The last forest owner
      // releases them explicitly, after every page has gone.
      for (const shape of shapes) {
        for (const a of [shape.index, ...Object.values(shape.attributes)]) if (a) (a as { shared?: boolean }).shared = false;
        shape.dispose();
      }
      crown = shrub = pine = bigCrown = null;
    }
  } };
}
// (Bare trees throw the shadows of their twigs.)
const treeDepth = new THREE.MeshDepthMaterial();
treeDepth.onBeforeCompile = (sh) => {
  sh.uniforms.uBare = BARE;
  sh.uniforms.uNoise = NOISE;
  sh.vertexShader = sh.vertexShader.replace(...TUFT_VERTEX).replace(...TUFT_BEGIN);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${TUFT_GLSL}\nvarying float vBare;\n${NOISE_GLSL}\n${SMALL_LEAVES_GLSL}\n${BARE_GLSL}`)
    .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (bareTwig(vTuft, vBare) < 0.) discard;');
};
treeDepth.customProgramCacheKey = () => 'tree-depth';
