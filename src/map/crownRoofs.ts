// The level top of a pitched roof: the flat crown of a tenement's or a mansard's roof,
// where the slopes rise to it from every side. IPR has it as a flat roof, and the photo
// mesh (pipeline/mesh_colours.py) calls a level grey face a membrane, gravel or bitumen
// by its lightness, but in Prague these crowns are sheet metal nearly always, like the
// shallow slopes the pipeline already makes metal (NOT_SHALLOW in
// pipeline/ipr_buildings.py). Drawn as a membrane they came out as bare grey plates
// (náměstí Jiřího z Poděbrad, 50.0775, 14.4484). Flat roofs that slopes don't rise to
// (a modern block's, a terrace beside a pitched roof) keep what the pipeline said.
//
// Done here rather than in the pipeline so the buildings needn't be built again.

const LEVEL = Math.cos((3 * Math.PI) / 180); // as the pipeline's LEVEL: under 3° is level
const ROOF_UP = 0.5; // steeper faces are walls or a mansard's lower slope
const METAL = 3;
const WINDOW = 10;
// Flat roofs read off the photos that may be a crown's sheet metal: not known, bitumen,
// membrane, gravel. Planted and paved roofs are terraces.
const MAYBE_METAL = new Set([0, 5, 6, 7]);
// How far the crown's normal leans towards the slopes' fall, so that the shader lays the
// standing seams down the slopes as on them (sheetRoof runs pans down a face's slope, and
// a level face has none). Under 2°: no change in the light that shows from above.
const LEAN = 0.03;

// `pos`: positions, 9 a triangle (three.js axes, y up); `facade`: 12 a triangle, the
// material in w; `normal`: 9 a triangle; `count`: the triangles to look at. Changes the
// crowns' material to sheet metal and leans their normals; returns them.
export function crownRoofs(pos: Float32Array, facade: Float32Array, normal: Float32Array, count: number): Set<number> {
  const key = (i: number) => `${Math.round(pos[i] * 100)},${Math.round(pos[i + 1] * 100)},${Math.round(pos[i + 2] * 100)}`;
  const ny = (t: number) => normal[t * 9 + 1];
  const mat = (t: number) => facade[t * 12 + 3];
  // The top corners of the pitched faces, each with the way its biggest face falls.
  const tops = new Map<string, { x: number; z: number; area: number }>();
  // Level faces that may be a crown, by corner.
  const level = new Map<string, number[]>();
  for (let t = 0; t < count; t++) {
    const up = ny(t), m = mat(t), i = t * 9;
    if (up >= LEVEL) {
      if (!MAYBE_METAL.has(m)) continue;
      for (let v = 0; v < 3; v++) {
        const k = key(i + v * 3), list = level.get(k);
        if (list) list.push(t); else level.set(k, [t]);
      }
    } else if (up >= ROOF_UP && m !== WINDOW) {
      const top = Math.max(pos[i + 1], pos[i + 4], pos[i + 7]);
      const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
      const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) / 2;
      const hx = normal[t * 9], hz = normal[t * 9 + 2], hl = Math.hypot(hx, hz) || 1;
      for (let v = 0; v < 3; v++) {
        if (pos[i + v * 3 + 1] < top - 0.02) continue;
        const k = key(i + v * 3), was = tops.get(k);
        if (!was || was.area < area) tops.set(k, { x: hx / hl, z: hz / hl, area });
      }
    }
  }
  // Level faces with a corner at the top of a slope, and the level faces joined to them.
  const fall = new Map<number, { x: number; z: number }>();
  const queue: number[] = [];
  for (const [k, list] of level) {
    const top = tops.get(k);
    if (top) for (const t of list) if (!fall.has(t)) { fall.set(t, top); queue.push(t); }
  }
  while (queue.length) {
    const t = queue.pop()!, d = fall.get(t)!, i = t * 9;
    for (let v = 0; v < 3; v++) for (const u of level.get(key(i + v * 3))!) {
      if (!fall.has(u)) { fall.set(u, d); queue.push(u); }
    }
  }
  const lean = 1 / Math.hypot(1, LEAN);
  for (const [t, d] of fall) {
    for (let v = 0; v < 3; v++) {
      facade[(t * 3 + v) * 4 + 3] = METAL;
      normal[t * 9 + v * 3] = d.x * LEAN * lean;
      normal[t * 9 + v * 3 + 1] = lean;
      normal[t * 9 + v * 3 + 2] = d.z * LEAN * lean;
    }
  }
  return new Set(fall.keys());
}
