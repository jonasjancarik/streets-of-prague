// Where a roof's faces end: for every roof triangle, which of its three edges lie on the
// outline of its face, what meets the face there, and how far each of its corners is from
// that edge. The shader (roofLines in webgpu/buildings.ts) draws ridge and hip tiles,
// valleys, gutters along the eaves, verges, and the kerb round a flat roof from it.
// Nothing here is made up: the edges are those of IPR's model, told apart by what the
// neighbouring triangle is.
//
// Written into the facade attribute's x, y and z, which roofs don't use (a mansard's steep
// face does, and is left alone; so is a roof window): one number per edge, opposite the
// corner of the same index, the corner's distance from the edge in metres plus EDGE_STEP
// times the kind of edge. The kind is the same at all three corners, so the number
// interpolated across the triangle is still the distance plus the kind. Zero (nothing
// written) reads as "no edge".
export const EDGE_STEP = 100;
export const EDGE = { none: 0, ridge: 1, valley: 2, eave: 3, verge: 4, wall: 5 } as const;
const FAR = EDGE_STEP - 1; // an edge inside a face: no line, however near
const ROOF_UP = 0.5; // (MANSARD_UP in facades.ts: steeper faces are a mansard's)

// `p`: triangle soup positions (three.js axes, y up), 9 numbers a triangle; `out`: the
// facade attribute, 12 numbers a triangle; `count`: how many triangles from the start to
// look at; `skip(t)`: triangles to leave alone (roof windows).
export function roofEdges(p: Float32Array, out: Float32Array, count: number, skip?: (t: number) => boolean) {
  const nrm = new Float32Array(count * 3);
  // Corners by their place to the centimetre (IPR's positions are whole centimetres).
  const ids = new Map<string, number>(), corner = new Int32Array(count * 3);
  const idOf = (v: number) => {
    const k = `${Math.round(p[v] * 100)},${Math.round(p[v + 1] * 100)},${Math.round(p[v + 2] * 100)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, l = Math.hypot(nx, ny, nz);
    if (l > 0) { nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l; }
    for (let v = 0; v < 3; v++) corner[t * 3 + v] = idOf(i + v * 3);
  }
  // Every edge's triangles (edge e of triangle t runs from corner e + 1 to corner e + 2,
  // opposite corner e).
  const edges = new Map<number, number[]>(), n = ids.size + 1;
  const edgeKey = (t: number, e: number) => {
    const a = corner[t * 3 + (e + 1) % 3], b = corner[t * 3 + (e + 2) % 3];
    return a < b ? a * n + b : b * n + a;
  };
  for (let t = 0; t < count; t++) {
    if (!(nrm[t * 3] || nrm[t * 3 + 1] || nrm[t * 3 + 2])) continue;
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(t, e), list = edges.get(k);
      if (list) list.push(t * 3 + e); else edges.set(k, [t * 3 + e]);
    }
  }
  for (let t = 0; t < count; t++) {
    const ny = nrm[t * 3 + 1];
    if (ny < ROOF_UP || skip?.(t)) continue;
    const nx = nrm[t * 3], nz = nrm[t * 3 + 2], flat = ny > 0.97;
    for (let e = 0; e < 3; e++) {
      const o = t * 9 + e * 3, a = t * 9 + ((e + 1) % 3) * 3, b = t * 9 + ((e + 2) % 3) * 3;
      const ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2], len = Math.hypot(ex, ey, ez);
      if (!(len > 0)) continue;
      // What else has this edge.
      let kind: number = EDGE.none, inside = false, roof = 0, wallAbove = false, wallBelow = false;
      for (const other of edges.get(edgeKey(t, e))!) {
        const u = (other / 3) | 0;
        if (u === t) continue;
        const ux = nrm[u * 3], uy = nrm[u * 3 + 1], uz = nrm[u * 3 + 2];
        const q = u * 9 + (other % 3) * 3; // the neighbour's corner off the edge
        if (uy >= 0.15) {
          if (nx * ux + ny * uy + nz * uz > 0.995) { inside = true; break; }
          // Which side of this face the neighbour lies on: below it, the two make a ridge.
          const side = nx * (p[q] - p[a]) + ny * (p[q + 1] - p[a + 1]) + nz * (p[q + 2] - p[a + 2]);
          roof = side < 0 ? EDGE.ridge : EDGE.valley;
        } else if (p[q + 1] > Math.max(p[a + 1], p[b + 1]) + 0.3) wallAbove = true;
        else wallBelow = true;
      }
      if (inside) kind = EDGE.none;
      else if (roof) kind = roof;
      else if (wallAbove) kind = EDGE.wall;
      else {
        // The face's own outline: an eave where it is the face's lower, level edge (or
        // any edge of a flat roof), a verge where it runs up the slope.
        const level = Math.abs(ey) < 0.12 * len, lower = p[o + 1] > (p[a + 1] + p[b + 1]) / 2 + 0.02;
        kind = flat || (level && lower) ? EDGE.eave : level && !wallBelow ? EDGE.ridge : EDGE.verge;
      }
      // The corner's distance from the edge: the triangle's height over it.
      const px = p[o] - p[a], py = p[o + 1] - p[a + 1], pz = p[o + 2] - p[a + 2];
      const along = (px * ex + py * ey + pz * ez) / len;
      const far = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - along * along));
      for (let v = 0; v < 3; v++) {
        const f = (t * 3 + v) * 4 + e;
        out[f] = kind === EDGE.none ? FAR : kind * EDGE_STEP + (v === e ? Math.min(far, FAR - 1) : 0);
      }
    }
  }
}
