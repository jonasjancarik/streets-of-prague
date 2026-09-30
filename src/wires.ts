import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';
import { fall, type Post } from './posts.ts';

// The trams' overhead wires, built with each tile from its tram tracks and buildings.
// A contact wire runs over every track at WIRE above the rails (where the trams'
// pantographs reach, assets/trams/build.py). Every SPAN metres or so a span wire
// crosses the street over the tracks there.
// Each end of it is held as in Prague: anchored to the front of a building when there
// is one close enough (in the old town's narrow streets most are), otherwise on a
// steel pole beside the outermost track. A pole is one of the posts a car can knock
// over (posts.ts): its span wire comes down with it.

const WIRE = 5.6; // m above the rails
const SPAN = 30; // m between supports along a track
const ACROSS = 8; // m either side of a track to look for the tracks beside it
const REACH = 11; // m from the outermost track to a building front it may be anchored to
const POLE_OUT = 3.3, POLE_H = 8.2; // a pole: how far out from the outermost track, how tall
const POLE_MAX_OUT = 40; // m from the outermost track a pole may be moved to get off the carriageway; beyond it the span wire is left out
const ANCHOR_H = 7; // m up a building front
const SAG = 0.35; // m the span wire sags in the middle
// How wide a wire is drawn: a little wider than it is, or from up where the camera is it
// would thin out to nothing between the pixels.
const THICK = 0.06;
const POLE_R = 0.18, TOUGH = 9, GIVE = 0.5; // a pole: its radius at the foot, how hard a hit knocks it over, how much it slows the car

// A pole standing on its foot at the origin, for one that is falling.
let fallen: THREE.BufferGeometry | null = null;
const poleGeometry = () => fallen ||= mergeGeometries([
  new THREE.CylinderGeometry(0.12, POLE_R, POLE_H, 8).translate(0, POLE_H / 2, 0).toNonIndexed(),
  new THREE.SphereGeometry(0.18, 8, 4).translate(0, POLE_H, 0).toNonIndexed(),
]);
const axis = new THREE.Vector3();

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
export function overheadWires(rails: Point2[][], buildings: Point2[][], ground: HeightAt, terrain: HeightAt, onRoad: (x: number, y: number) => boolean = () => false) {
  // Each wire a flat ribbon facing up, THICK wide.
  const lines: number[] = [];
  const poles: THREE.BufferGeometry[] = [];
  let vertices = 0; // in `poles` so far
  const add = (g: THREE.BufferGeometry) => { poles.push(g); vertices += g.attributes.position.count; };
  // Each pole: where it is, its vertices in the poles' mesh, and its span wire's in the wires'.
  const standing: { post: Post; x: number; y: number; z: number; from: number; to: number; span: [number, number] }[] = [];
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
    const z = terrain(x, y), from = vertices;
    add(poleGeometry().clone().translate(x, z, -y));
    const post: Post = { x, y, z, r: POLE_R, tough: TOUGH, give: GIVE, down: null };
    standing.push({ post, x, y, z, from, to: vertices, span: [0, 0] });
  };
  const rosette = (x: number, y: number, z: number) => {
    add(new THREE.BoxGeometry(0.3, 0.3, 0.3).translate(x, z, -y).toNonIndexed());
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
        const held = standing.length;
        const ends = [-1, 1].map((s) => {
          const edge = s > 0 ? hi : lo, ox = px + nx * edge, oy = py + ny * edge;
          const wall = cast(walls, ox, oy, nx * s, ny * s, REACH);
          if (Number.isFinite(wall)) {
            const x = ox + nx * s * wall, y = oy + ny * s * wall, h = Math.max(terrain(x, y) + ANCHOR_H, z + WIRE + 0.8);
            return { x, y, z: h, build: () => rosette(x, y, h) };
          }
          // Beside the tracks, but not in the carriageway: out to the pavement when the street is wide.
          let out = POLE_OUT;
          while (out <= POLE_MAX_OUT && onRoad(ox + nx * s * out, oy + ny * s * out)) out += 0.5;
          if (out > POLE_MAX_OUT) return null;
          const x = ox + nx * s * out, y = oy + ny * s * out;
          return { x, y, z: Math.max(terrain(x, y) + POLE_H - 0.6, z + WIRE + 0.6), build: () => pole(x, y) };
        });
        // No pavement to stand a pole on: no span wire here.
        if (ends.some((e) => !e)) continue;
        for (const e of ends) e!.build();
        // The span wire, sagging a little.
        const [a, b] = ends as NonNullable<(typeof ends)[number]>[], n = 6, pt = (k: number) => {
          const u = k / n;
          return [a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u - SAG * 4 * u * (1 - u)];
        };
        const first = lines.length;
        for (let k = 0; k < n; k++) {
          const [x0, y0, z0] = pt(k), [x1, y1, z1] = pt(k + 1);
          line(x0, y0, z0, x1, y1, z1);
        }
        for (let k = held; k < standing.length; k++) standing[k].span = [first / 3, lines.length / 3];
      }
      along += len;
    }
  }

  const out: THREE.Mesh[] = [];
  let wireMesh: THREE.Mesh | null = null, poleMesh: THREE.Mesh | null = null;
  if (lines.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    g.computeVertexNormals();
    wireMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#202223', side: THREE.DoubleSide }));
    wireMesh.castShadow = true;
    out.push(wireMesh);
  }
  if (poles.length) {
    poleMesh = new THREE.Mesh(mergeGeometries(poles), new THREE.MeshLambertMaterial({ color: '#4a524d' }));
    poleMesh.castShadow = true;
    out.push(poleMesh);
  }
  // Knocked over: the pole and its span wire gone from the tile's meshes, and in its
  // place one that falls the way it was hit (drawn with the tile, so gone with it).
  const collapse = (mesh: THREE.Mesh | null, from: number, to: number) => {
    if (!mesh || to <= from) return;
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
    for (let v = from; v < to; v++) pos.setXYZ(v, pos.getX(from), pos.getY(from), pos.getZ(from));
    pos.needsUpdate = true;
  };
  for (const s of standing) {
    s.post.knocked = (p) => {
      collapse(poleMesh, s.from, s.to);
      collapse(wireMesh, s.span[0], s.span[1]);
      const parent = poleMesh?.parent;
      if (!poleMesh || !parent) return;
      const m = new THREE.Mesh(poleGeometry(), poleMesh.material);
      m.castShadow = true;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.position.set(s.x, s.z, -s.y);
      const ang = p.down?.ang ?? 0;
      const place = () => {
        m.quaternion.setFromAxisAngle(axis.set(-Math.sin(ang), 0, -Math.cos(ang)), fall(p, performance.now()));
        m.updateMatrix();
        m.matrixWorld.copy(m.matrix); // (the tile's group is where the world is, and never moves)
      };
      place();
      m.onBeforeRender = place;
      parent.add(m);
    };
  }
  return { meshes: out, posts: standing.map((s) => s.post) };
}
