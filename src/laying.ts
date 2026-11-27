// Which way a paved surface is laid. Setts, pavement mosaic, slabs and concrete panels
// run with the edges of what they cover (the kerb, the wall, the quay), not with the
// map's north. Each joined piece of a layer's mesh gets one direction, from its outline:
// the long sides weigh most, and a square grid fits both arms of an L-shaped pavement
// round a corner. Where two pieces meet at an angle their joints meet at a seam, as on
// the street.
//
// The angle goes to the shader per vertex (the `lay` attribute, radians from the world's
// x axis towards its y = north): the same over a piece, so the pattern is turned about
// the world's origin and stays put however the piece is cut into triangles.

export const LAID_PATTERNS = new Set(['setts', 'mosaic', 'pavement', 'slabs', 'concrete']);

// Pieces of the same pavement in two tiles may come out a hair apart; rounded to a
// degree they agree, and their joints run on across the tile's edge.
const STEP = Math.PI / 180;

// `box`: the tile [x0, y0, x1, y1]. Its edges cut the pieces and say nothing of how they
// are laid, so outline along them is left out.
export function layingAngles(position: Float32Array, index: Uint32Array, box?: readonly number[]): Float32Array {
  const n = position.length / 3, out = new Float32Array(n);
  if (!index.length) return out;
  // Vertices at one place are one corner (a mesh refined over the terrain can repeat them).
  // (Keys: centimetres, offset to be positive, packed into one number below 2^53.)
  const where = new Map<number, number>(), at = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const key = (Math.round(position[i * 3] * 100) + 2 ** 25) * 2 ** 26 + Math.round(position[i * 3 + 2] * 100) + 2 ** 25;
    let k = where.get(key);
    if (k === undefined) where.set(key, (k = where.size));
    at[i] = k;
  }
  const parent = new Int32Array(where.size).map((_, i) => i);
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  // An edge of only one triangle is on the outline.
  const uses = new Map<number, [number, number, number]>();
  for (let t = 0; t < index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = index[t + e], b = index[t + ((e + 1) % 3)], ka = at[a], kb = at[b];
      if (ka === kb) continue;
      const ra = root(ka), rb = root(kb);
      if (ra !== rb) parent[ra] = rb;
      const key = ka < kb ? ka * 2 ** 26 + kb : kb * 2 ** 26 + ka;
      const seen = uses.get(key);
      if (seen) seen[2]++; else uses.set(key, [a, b, 1]);
    }
  }
  // Per piece: the outline's directions, summed as a square grid (4θ) and as an axis (2θ).
  const sums = new Map<number, number[]>();
  const [x0, y0, x1, y1] = box ?? [NaN, NaN, NaN, NaN];
  const onBox = (x: number, y: number, u: number, v: number) =>
    (Math.abs(x - x0) < .05 && Math.abs(u - x0) < .05) || (Math.abs(x - x1) < .05 && Math.abs(u - x1) < .05)
    || (Math.abs(y - y0) < .05 && Math.abs(v - y0) < .05) || (Math.abs(y - y1) < .05 && Math.abs(v - y1) < .05);
  for (const [a, b, count] of uses.values()) {
    if (count !== 1) continue;
    const ax = position[a * 3], ay = -position[a * 3 + 2], bx = position[b * 3], by = -position[b * 3 + 2];
    if (onBox(ax, ay, bx, by)) continue;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;
    const u = dx / len, v = dy / len, c2 = u * u - v * v, s2 = 2 * u * v;
    const r = root(at[a]);
    let s = sums.get(r);
    if (!s) sums.set(r, (s = [0, 0, 0, 0]));
    s[0] += len * (c2 * c2 - s2 * s2); s[1] += len * 2 * c2 * s2; s[2] += len * c2; s[3] += len * s2;
  }
  const angle = new Map<number, number>();
  for (const [r, [c4, s4, c2, s2]] of sums) {
    // The grid, then which of its two ways the stones run along: the longer sides'.
    let phi = Math.atan2(s4, c4) / 4;
    if (c2 * Math.cos(2 * phi) + s2 * Math.sin(2 * phi) < 0) phi += Math.PI / 2;
    angle.set(r, Math.round(phi / STEP) * STEP);
  }
  for (let i = 0; i < n; i++) out[i] = angle.get(root(at[i])) ?? 0;
  return out;
}
