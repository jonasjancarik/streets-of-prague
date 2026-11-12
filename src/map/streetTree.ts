// A broadleaf tree for the view from the street. The crown drawn from above is tufts laid
// like shingles (vegetation.ts): made to be looked down on, and from below a dark lid on a
// pole. This one is made to be stood under: a trunk with a flared foot, boughs that rise and
// fork into the crown, and at every branch end a few sprays of leaves, flat cards with a
// picture of a leafy branch end on them (public/street-trees.webp, assets/trees/), growing
// outwards from the wood. In winter the same cards show bare twigs.
//
// It lives in the top-down crown's own frame (the crown's middle at the origin, its radius
// 1, the ground a tree's own distance below), so the same instances place both, and the
// tree pool (trees.ts) draws this one in place of the other near you in first person.
//
// `part` of each vertex: x 1 on wood, 0 on a card; y on the lower trunk, how far up from
// the ground to the crown's foot it is (0 to 1; -1 elsewhere: the height is its own);
// z a card's own random number (which cards lose their leaves first); w how deep inside
// the crown it is (1 at its surface), for the shade inside it.
import * as THREE from 'three';
import { rng } from './geo.ts';

export const CROWN_FOOT = -0.38; // where the lower trunk ends, in the crown's frame

export function streetTreeGeometry(seed: number, boughs: number, sprays: number) {
  const r = rng(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], part: number[] = [], idx: number[] = [];
  const v = (p: THREE.Vector3, n: THREE.Vector3, s: number, t: number, a: number, b: number, c: number, d: number) => {
    pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z); uv.push(s, t); part.push(a, b, c, d);
    return pos.length / 3 - 1;
  };
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);

  // A tube through `points` ([place, radius, how far up the lower trunk or -1]), `sides` round.
  const tube = (points: [THREE.Vector3, number, number][], sides: number, turns: number) => {
    let last: number[] = [];
    const u = new THREE.Vector3(), w = new THREE.Vector3(), dir = new THREE.Vector3(), n = new THREE.Vector3(), p = new THREE.Vector3();
    points.forEach(([at, radius, rise], i) => {
      dir.copy(points[Math.min(i + 1, points.length - 1)][0]).sub(points[Math.max(i - 1, 0)][0]).normalize();
      u.crossVectors(Math.abs(dir.y) > 0.9 ? side : up, dir).normalize();
      w.crossVectors(dir, u);
      const ring: number[] = [];
      for (let j = 0; j <= sides; j++) {
        const th = (j / sides) * Math.PI * 2;
        n.copy(u).multiplyScalar(Math.cos(th)).addScaledVector(w, Math.sin(th));
        p.copy(at).addScaledVector(n, radius);
        ring.push(v(p, n, (j / sides) * turns, 0, 1, rise, 0, 1));
      }
      if (last.length) for (let j = 0; j < sides; j++) idx.push(last[j], ring[j], last[j + 1], last[j + 1], ring[j], ring[j + 1]);
      last = ring;
    });
  };

  // The trunk: the lower part stretches from the ground to the crown's foot (part.y), the
  // upper part runs on up into the crown and thins out into a leader.
  const lean = (r() - 0.5) * 0.08, bend = r() * Math.PI * 2;
  const axis = (y: number) => new THREE.Vector3(Math.cos(bend) * lean * (y + 0.4), y, Math.sin(bend) * lean * (y + 0.4));
  tube([
    // (The lower rings' heights here only keep them apart: the shader puts them by `rise`.)
    [new THREE.Vector3(0, CROWN_FOOT - 1, 0), 0.07, 0], [new THREE.Vector3(0, CROWN_FOOT - 0.95, 0), 0.048, 0.04], [new THREE.Vector3(0, CROWN_FOOT - 0.8, 0), 0.041, 0.18],
    [new THREE.Vector3(0, CROWN_FOOT - 0.4, 0), 0.038, 0.6], [axis(CROWN_FOOT), 0.035, 1], [axis(-0.15), 0.03, -1], [axis(0.1), 0.021, -1], [axis(0.38), 0.01, -1], [axis(0.6), 0.003, -1],
  ], 8, 2);

  // Boughs: off the upper trunk, out and up in a bow, each forking into two or three
  // branches. Every end, and the middle of every bough, is somewhere a spray of leaves grows.
  const ends: { at: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  // From `from` to `to` in a bow (three bends, sagging outwards and rising at the end), as wood grows.
  const grow = (from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, sides: number, leafAlong: boolean) => {
    const span = from.distanceTo(to), sag = span * (0.1 + r() * 0.12), swing = (r() - 0.5) * span * 0.25;
    const out = to.clone().sub(from).setY(0).normalize(), sideways = new THREE.Vector3(-out.z, 0, out.x);
    const points: [THREE.Vector3, number, number][] = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4, at = from.clone().lerp(to, t);
      at.y += Math.sin(t * Math.PI) * sag * (t < 0.5 ? 1 : 0.4) - (1 - t) * t * span * 0.1;
      at.addScaledVector(sideways, Math.sin(t * Math.PI) * swing);
      points.push([at, r0 + (r1 - r0) * Math.sqrt(t), -1]);
    }
    tube(points, sides, 1);
    ends.push({ at: to, dir: to.clone().sub(points[3][0]).normalize() });
    if (leafAlong) ends.push({ at: points[2][0], dir: new THREE.Vector3(r() - 0.5, 0.5 + r() * 0.5, r() - 0.5).normalize() });
    return points;
  };
  const turn = r() * Math.PI * 2;
  for (let i = 0; i < boughs; i++) {
    const k = i / boughs, a = turn + i * 2.4 + (r() - 0.5) * 0.5; // (the golden angle: no two above each other)
    const y0 = -0.32 + k * 0.55, reach = 0.74 - k * 0.32 + (r() - 0.5) * 0.12;
    const from = axis(y0), to = new THREE.Vector3(Math.cos(a) * reach, y0 + 0.1 + k * 0.3 + r() * 0.22, Math.sin(a) * reach);
    const bough = grow(from, to, 0.022 - k * 0.008, 0.006, 5, true);
    const forks = 2 + (r() < 0.6 ? 1 : 0);
    for (let f = 0; f < forks; f++) {
      const b = a + (f - (forks - 1) / 2) * 1.0 + (r() - 0.5) * 0.5, far = reach * (0.7 + r() * 0.35);
      const tip = new THREE.Vector3(Math.cos(b) * far, to.y + (r() - 0.3) * 0.3, Math.sin(b) * far);
      grow(bough[1 + Math.floor(r() * 3)][0].clone(), tip, 0.008, 0.003, 3, false);
    }
  }
  ends.push({ at: axis(0.6), dir: up.clone() }, { at: axis(0.38), dir: new THREE.Vector3(0.6, 0.6, 0.3).normalize() }, { at: axis(0.38), dir: new THREE.Vector3(-0.5, 0.6, -0.5).normalize() });

  // Sprays: at each end, flat cards growing outwards from it, their stems at the wood.
  // Their normals lean towards the crown's own round shape, so the whole crown has a sunny
  // side and a shaded one however the cards happen to lie.
  const grown = new THREE.Vector3(), across = new THREE.Vector3(), face = new THREE.Vector3(), centre = new THREE.Vector3(), round = new THREE.Vector3(), corner = new THREE.Vector3(), n = new THREE.Vector3();
  for (const end of ends) for (let s = 0; s < sprays; s++) {
    const size = 0.4 + r() * 0.18;
    grown.set(r() - 0.5, r() - 0.3, r() - 0.5).multiplyScalar(1.1).add(end.dir).normalize();
    across.set(r() - 0.5, (r() - 0.5) * 0.6, r() - 0.5).cross(grown).normalize();
    face.crossVectors(across, grown).normalize();
    centre.copy(end.at).addScaledVector(grown, size * 0.42);
    round.set(centre.x, (centre.y - 0.05) * 1.3, centre.z);
    const deep = Math.min(1, round.length() / 0.9), own = r(), flip = r() < 0.5;
    round.normalize();
    const first = pos.length / 3;
    for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      corner.copy(end.at).addScaledVector(grown, (cy - 0.08) * size).addScaledVector(across, cx * size * 0.5);
      n.copy(round).multiplyScalar(1.4).addScaledVector(face, face.dot(round) < 0 ? -0.5 : 0.5).addScaledVector(across, cx * 0.35).addScaledVector(grown, (cy - 0.5) * 0.35).normalize();
      v(corner, n, (cx > 0) !== flip ? 1 : 0, cy, 0, -1, own, deep);
    }
    idx.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setAttribute('part', new THREE.Float32BufferAttribute(part, 4));
  geom.setIndex(idx);
  // Every page's trees use these buffers: the WebGPU renderer must keep them when one page goes.
  for (const a of [geom.index, ...Object.values(geom.attributes)]) if (a) (a as { shared?: boolean }).shared = true;
  return geom;
}
