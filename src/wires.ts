import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';

// The trams' overhead wires, built with each tile from its tram tracks and buildings.
// A contact wire runs over every track at WIRE above the rails (where the trams'
// pantographs reach, assets/trams/build.py). Every SPAN metres or so a span wire
// crosses the street over the tracks there.
// Each end of it is held as in Prague: anchored to the front of a building when there
// is one close enough (in the old town's narrow streets most are), otherwise on a
// steel pole beside the outermost track.

const WIRE = 5.6; // m above the rails
const SPAN = 30; // m between supports along a track
const ACROSS = 8; // m either side of a track to look for the tracks beside it
const REACH = 11; // m from the outermost track to a building front it may be anchored to
const POLE_OUT = 3.3, POLE_H = 8.2; // a pole: how far out from the outermost track, how tall
const ANCHOR_H = 7; // m up a building front
const SAG = 0.35; // m the span wire sags in the middle
// How wide a wire is drawn: a little wider than it is, or from up where the camera is it
// would thin out to nothing between the pixels.
const THICK = 0.06;

type HeightAt = (x: number, y: number) => number;
interface Seg { ax: number; ay: number; bx: number; by: number }

// Where the ray from (px, py) along (dx, dy) first crosses a segment, as the distance
// along it (Infinity if it doesn't within `max`).
function cast(segs: Seg[], px: number, py: number, dx: number, dy: number, max: number) {
  let best = Infinity;
  for (const s of segs) {
    const ex = s.bx - s.ax, ey = s.by - s.ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const qx = s.ax - px, qy = s.ay - py;
    const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
    if (t > 0 && t < max && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

function segments(lines: Point2[][]): Seg[] {
  const out: Seg[] = [];
  for (const pts of lines) for (let i = 0; i < pts.length - 1; i++) out.push({ ax: pts[i][0], ay: pts[i][1], bx: pts[i + 1][0], by: pts[i + 1][1] });
  return out;
}

// `rails`: the tile's tram tracks; `buildings`: the outer rings of the buildings in and
// round it; `ground`: the height a track is at (on a bridge deck where there is one),
// `terrain`: the ground's own height.
export function overheadWires(rails: Point2[][], buildings: Point2[][], ground: HeightAt, terrain: HeightAt) {
  // Each wire a flat ribbon facing up, THICK wide.
  const lines: number[] = [];
  const poles: THREE.BufferGeometry[] = [];
  const line = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-3) return;
    const ox = (-(by - ay) / l) * THICK / 2, oy = ((bx - ax) / l) * THICK / 2;
    lines.push(ax + ox, az, -(ay + oy), ax - ox, az, -(ay - oy), bx + ox, bz, -(by + oy));
    lines.push(bx + ox, bz, -(by + oy), ax - ox, az, -(ay - oy), bx - ox, bz, -(by - oy));
  };

  // The contact wires, a point every 10 m or less so they follow the ground.
  for (const pts of rails) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 10));
      for (let k = 0; k < n; k++) {
        const x0 = ax + ((bx - ax) * k) / n, y0 = ay + ((by - ay) * k) / n;
        const x1 = ax + ((bx - ax) * (k + 1)) / n, y1 = ay + ((by - ay) * (k + 1)) / n;
        line(x0, y0, ground(x0, y0) + WIRE, x1, y1, ground(x1, y1) + WIRE);
      }
    }
  }

  const tracks = segments(rails);
  const walls = segments(buildings);
  const placed: Point2[] = [];
  const pole = (x: number, y: number) => {
    const z = terrain(x, y);
    const g = new THREE.CylinderGeometry(0.12, 0.18, POLE_H, 8).translate(x, z + POLE_H / 2, -y);
    const cap = new THREE.SphereGeometry(0.18, 8, 4).translate(x, z + POLE_H, -y);
    poles.push(g.toNonIndexed(), cap.toNonIndexed());
  };
  const rosette = (x: number, y: number, z: number) => {
    poles.push(new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(x, z, -y).toNonIndexed());
  };

  for (const pts of rails) {
    let next = SPAN / 2;
    let along = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
      while (next <= along + len) {
        const f = next - along, px = ax + dx * f, py = ay + dy * f;
        next += SPAN;
        // One span wire for the tracks side by side: not again for the track beside.
        if (placed.some(([qx, qy]) => Math.hypot(qx - px, qy - py) < SPAN * 0.45)) continue;
        placed.push([px, py]);
        // The tracks this span crosses, as distances along the normal.
        const at = [0];
        for (const s of [1, -1]) {
          let from = 0;
          for (;;) {
            const t = cast(tracks, px + nx * s * (from + 0.5), py + ny * s * (from + 0.5), nx * s, ny * s, ACROSS - from);
            if (!Number.isFinite(t)) break;
            from += 0.5 + t;
            at.push(s * from);
          }
        }
        const lo = Math.min(...at), hi = Math.max(...at), z = ground(px, py);
        // Each end: a building front within reach, or a pole.
        const ends = [-1, 1].map((s) => {
          const edge = s > 0 ? hi : lo, ox = px + nx * edge, oy = py + ny * edge;
          const wall = cast(walls, ox, oy, nx * s, ny * s, REACH);
          if (Number.isFinite(wall)) {
            const x = ox + nx * s * wall, y = oy + ny * s * wall, h = Math.max(terrain(x, y) + ANCHOR_H, z + WIRE + 0.8);
            rosette(x, y, h);
            return { x, y, z: h };
          }
          const x = ox + nx * s * POLE_OUT, y = oy + ny * s * POLE_OUT;
          pole(x, y);
          return { x, y, z: Math.max(terrain(x, y) + POLE_H - 0.6, z + WIRE + 0.6) };
        });
        // The span wire, sagging a little.
        const [a, b] = ends, n = 6, pt = (k: number) => {
          const u = k / n;
          return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u - SAG * 4 * u * (1 - u)];
        };
        for (let k = 0; k < n; k++) {
          const [x0, y0, z0] = pt(k), [x1, y1, z1] = pt(k + 1);
          line(x0, y0, z0, x1, y1, z1);
        }
      }
      along += len;
    }
  }

  const out: THREE.Mesh[] = [];
  if (lines.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#202223', side: THREE.DoubleSide }));
    mesh.castShadow = true;
    out.push(mesh);
  }
  if (poles.length) {
    const mesh = new THREE.Mesh(mergeGeometries(poles), new THREE.MeshLambertMaterial({ color: '#4a524d' }));
    mesh.castShadow = true;
    out.push(mesh);
  }
  return out;
}
