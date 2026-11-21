// Check the same topmost ground cover the walker sees, once per foot contact.
// The bounding boxes are built on the first footstep in this tile.
import { onPolygons, type Polygons } from './geo.ts';
import { PITCH_LOOKS } from './pitches.ts';

export type Footing = 'hard' | 'grass' | 'gravel' | 'snow';
type Areas = Record<string, Polygons | undefined>;
export function footSurfaces(areas: Areas, roads: Areas) {
  const groups: { on: ReturnType<typeof onPolygons>; sound: Footing }[] = [];
  function add(source: Areas, keys: string, sound: Footing) {
    const polys = keys.split(' ').flatMap((k) => source[k] ?? []);
    if (polys.length) groups.push({ on: onPolygons(polys), sound });
  }
  // Surface paint order, from the exposed top down. A paved path through a
  // park still sounds paved; the park may in turn lie over older aerial imagery.
  add(roads, 'trambed', 'gravel');
  add(roads, 'road sett pavement pavement_asphalt path', 'hard');
  add(roads, 'dirt', 'gravel');
  add(areas, 'parking', 'hard');
  add(areas, 'square_loose', 'gravel');
  add(areas, 'square square_setts square_asphalt pool', 'hard');
  add(areas, 'pitch', 'grass');
  for (let i = PITCH_LOOKS.length - 1; i >= 0; i--) {
    const [key, , pattern] = PITCH_LOOKS[i];
    add(areas, key, pattern === 'concrete' ? 'hard' : pattern === 'dirt' ? 'gravel' : 'grass');
  }
  add(areas, 'orchard wood wood_clearing', 'grass');
  add(areas, 'worn_edge worn ipr_bed', 'gravel');
  add(areas, 'meadow park lawn garden ipr_lawn ipr_grove ipr_meadow ipr_shrubs', 'grass');
  add(areas, 'cover_asphalt cover_paving cover_concrete', 'hard');
  add(areas, 'cover_gravel cover_dirt', 'gravel');
  add(areas, 'cover_grass cover_wood verge dtm_green dtm_garden dtm_wood dtm_pitch field', 'grass');
  add(areas, 'ballast bare', 'gravel');
  return (x: number, y: number): Footing => {
    for (const group of groups) if (group.on(x, y)) return group.sound;
    return 'hard';
  };
}

export function snowFooting(surface: Footing, cover: number, cleared: number): Footing {
  // Footpaths and carriageways are cleared as the day goes on. Snow stays on
  // a lawn or an unpaved track until it melts.
  return cover * (surface === 'hard' ? 1 - .9 * cleared : 1) > .48 ? 'snow' : surface;
}
