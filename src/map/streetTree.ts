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

// Where the lower trunk ends and the crown begins, in the crown's frame as this model is
// made: well below the top-down crown's, since a tree seen from the side has leaves most of
// the way down. The shader moves it to each tree's own crown base (CROWN_BASE in
// vegetation.ts), drawing the part below TREE_FROM out or in to fit.
export const CROWN_FOOT = -1.3, TREE_FROM = 0.2;
// `part.y` of a spray laid over the crown seen from above (canopyGeometry): such a card is
// not drawn once its leaves are gone (the tufts' own bare twigs show instead).
export const CANOPY = -2;
// …and of a conifer's bough (coniferGeometry): its card shows the atlas's third picture.
export const BOUGH = -3;

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
    [new THREE.Vector3(0, CROWN_FOOT - 0.4, 0), 0.038, 0.6], [axis(CROWN_FOOT), 0.035, 1], [axis(-0.85), 0.031, -1], [axis(-0.4), 0.026, -1], [axis(0), 0.019, -1], [axis(0.38), 0.01, -1], [axis(0.6), 0.003, -1],
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
    const k = i / Math.max(1, boughs - 1), a = turn + i * 2.4 + (r() - 0.5) * 0.5; // (the golden angle: no two above each other)
    // From just above the crown's foot to near its top, reaching furthest a little below the middle.
    const y0 = CROWN_FOOT + 0.1 + k * 1.45, reach = 0.36 + 0.44 * Math.sin(Math.PI * (0.12 + 0.8 * k)) + (r() - 0.5) * 0.1;
    const from = axis(y0), to = new THREE.Vector3(Math.cos(a) * reach, y0 + 0.1 + r() * 0.22, Math.sin(a) * reach);
    const bough = grow(from, to, 0.022 - k * 0.01, 0.006, 5, true);
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
    // (How near the crown's surface the spray is: by how far out it stands for its height, or how near the top.)
    const height = (centre.y - CROWN_FOOT) / (0.6 - CROWN_FOOT), girth = 0.4 + 0.5 * Math.sin(Math.PI * (0.1 + 0.8 * Math.min(1, Math.max(0, height))));
    const deep = Math.min(1, Math.max(Math.hypot(centre.x, centre.z) / girth, (centre.y - 0.1) / 0.45)), own = r(), flip = r() < 0.5;
    round.set(centre.x, (centre.y + 0.35) * 0.55, centre.z).normalize();
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

// Leaves for the crown seen from above: the same sprays laid over the top-down crown's
// tufts like shingles, each growing outwards and down the crown's slope from a stem nearer
// the middle, a little clear of the tufts, the outermost hanging over the crown's edge. The
// tufts underneath keep the crown's shape, its shade and its shadow; these give it real
// leaves and a ragged outline in place of the tufts' smooth lobes. `rings`: how many
// sprays in each ring, from the top outwards.
// `skirt`: a shrub's: more rings carry on down its sides to the ground it sits on (a shrub's
// crown is its whole body), each spray growing outwards and a little up, as a bush's do.
export function canopyGeometry(seed: number, rings: number[], skirt: number[] = []) {
  const r = rng(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], part: number[] = [], idx: number[] = [];
  // The crown's top surface: how high it is at a distance from the middle (the tufts' tiers
  // in vegetation.ts run from 0.5 at the top to -0.08 at the rim).
  const dome = (d: number) => 0.6 - 0.62 * Math.pow(Math.min(d, 1.15), 1.7);
  const at = new THREE.Vector3(), out = new THREE.Vector3(), grown = new THREE.Vector3(), across = new THREE.Vector3(), corner = new THREE.Vector3(), n = new THREE.Vector3(), round = new THREE.Vector3();
  rings.forEach((count, ring) => {
    const d0 = rings.length > 1 ? (ring / (rings.length - 1)) * 0.74 : 0, turn = r() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      const a = turn + (i / count) * Math.PI * 2 + (r() - 0.5) * 0.5, d = Math.max(0, d0 + (r() - 0.5) * 0.14);
      const size = 0.46 + r() * 0.16, lift = 0.05 + r() * 0.06;
      out.set(Math.cos(a), 0, Math.sin(a));
      // Down the slope from the stem, swung a little to one side, never steeper than the dome.
      const slope = (dome(d + 0.2) - dome(d)) / 0.2;
      grown.copy(out).applyAxisAngle(new THREE.Vector3(0, 1, 0), (r() - 0.5) * 0.9).setY(slope * 0.8 + 0.08).normalize();
      across.set(-grown.z, (r() - 0.5) * 0.3, grown.x).normalize();
      at.copy(out).multiplyScalar(d).setY(dome(d) + lift);
      const own = r(), flip = r() < 0.5, first = pos.length / 3;
      for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        corner.copy(at).addScaledVector(grown, (cy - 0.12) * size).addScaledVector(across, cx * size * 0.5);
        // Lit as the crown's round shape is there, each corner a little its own way.
        round.set(corner.x, Math.max(0.25, 0.9 - corner.length() * 0.5), corner.z).normalize();
        n.copy(round).addScaledVector(across, cx * 0.18).addScaledVector(grown, (cy - 0.5) * 0.18).normalize();
        pos.push(corner.x, corner.y, corner.z); nor.push(n.x, n.y, n.z); uv.push((cx > 0) !== flip ? 1 : 0, cy);
        // (No wood, a canopy card at its own height, its own number; fully in the light, a little less at the rim.)
        part.push(0, CANOPY, own, 1 - 0.25 * Math.min(1, d) + (r() - 0.5) * 0.2);
      }
      idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
    }
  });
  skirt.forEach((count, ring) => {
    const y = 0.1 - (ring / Math.max(1, skirt.length - 1)) * 0.66, turn = r() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      // (Alternate sprays start deeper in, so the bush has a body and not only a shell.)
      const a = turn + (i / count) * Math.PI * 2 + (r() - 0.5) * 0.5, d = (i % 2 ? 0.2 : 0.5) + r() * 0.22;
      const size = 0.5 + r() * 0.18;
      out.set(Math.cos(a), 0, Math.sin(a));
      grown.copy(out).applyAxisAngle(new THREE.Vector3(0, 1, 0), (r() - 0.5) * 1.1).setY(0.15 + r() * 0.6).normalize();
      across.set(-grown.z, (r() - 0.5) * 0.5, grown.x).normalize();
      at.copy(out).multiplyScalar(d).setY(y + (r() - 0.5) * 0.1);
      const own = r(), flip = r() < 0.5, first = pos.length / 3;
      for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        corner.copy(at).addScaledVector(grown, (cy - 0.12) * size).addScaledVector(across, cx * size * 0.5);
        round.set(corner.x, 0.35, corner.z).normalize();
        n.copy(round).addScaledVector(across, cx * 0.18).addScaledVector(grown, (cy - 0.5) * 0.18).normalize();
        pos.push(corner.x, corner.y, corner.z); nor.push(n.x, n.y, n.z); uv.push((cx > 0) !== flip ? 1 : 0, cy);
        // (Darker towards the ground, under the bush's own overhang.)
        part.push(0, CANOPY, own, 0.55 + 0.4 * (1 - ring / Math.max(1, skirt.length - 1)) + (r() - 0.5) * 0.15);
      }
      idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
    }
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setAttribute('part', new THREE.Float32BufferAttribute(part, 4));
  geom.setIndex(idx);
  for (const a of [geom.index, ...Object.values(geom.attributes)]) if (a) (a as { shared?: boolean }).shared = true;
  return geom;
}

// A conifer for the view from the street and, on Ultra, from above: boughs of needles in
// whorls round the trunk, laid over the top-down model's tiers of skirts (vegetation.ts,
// pineGeometry: the same frame, from -1.5 at its foot to 1.4 at its tip), which stay as the
// tree's dark body behind them. Each bough is a flat card with a spruce bough on it, its
// stem at the trunk, growing outwards and drooping, the lower ones longest; a few small
// ones stand up round the tip.
export function coniferGeometry(seed: number) {
  const r = rng(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], part: number[] = [], idx: number[] = [];
  const at = new THREE.Vector3(), out = new THREE.Vector3(), grown = new THREE.Vector3(), across = new THREE.Vector3(), corner = new THREE.Vector3(), n = new THREE.Vector3();
  const bough = (a: number, y: number, length: number, droop: number, shade: number) => {
    out.set(Math.cos(a), 0, Math.sin(a));
    grown.copy(out).setY(-droop).normalize();
    across.set(-out.z, (r() - 0.5) * 0.25, out.x).normalize();
    at.copy(out).multiplyScalar(0.02).setY(y);
    const own = r(), flip = r() < 0.5, first = pos.length / 3, width = length * 0.78;
    for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      corner.copy(at).addScaledVector(grown, cy * length).addScaledVector(across, cx * width * 0.5);
      // Lit from above and from outside, as the whole tree is.
      n.copy(out).multiplyScalar(0.55).setY(0.8).addScaledVector(across, cx * 0.2).normalize();
      pos.push(corner.x, corner.y, corner.z); nor.push(n.x, n.y, n.z); uv.push((cx > 0) !== flip ? 1 : 0, cy);
      part.push(0, BOUGH, own, shade * (0.75 + 0.25 * cy) + (r() - 0.5) * 0.1);
    }
    idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
  };
  const WHORLS = 9;
  for (let i = 0; i < WHORLS; i++) {
    // (Longer than the skirts behind them are wide, and starting above each: they stand out from the body.)
    const t = i / (WHORLS - 1), y = -1.12 + t * 2.2, reach = 1.3 * (1 - t * 0.78), count = Math.round(10 - t * 4), turn = r() * Math.PI * 2;
    for (let j = 0; j < count; j++) bough(turn + (j / count) * Math.PI * 2 + (r() - 0.5) * 0.4, y + (r() - 0.5) * 0.12, reach * (0.9 + r() * 0.25), 0.34 - t * 0.2 + r() * 0.14, 0.7 + 0.35 * t);
  }
  // The tip: three small boughs standing up.
  for (let j = 0; j < 3; j++) {
    const a = j * 2.1 + r();
    out.set(Math.cos(a), 0, Math.sin(a));
    grown.set(out.x * 0.25, 1, out.z * 0.25).normalize();
    across.set(-out.z, 0, out.x);
    at.set(0, 1.0, 0);
    const first = pos.length / 3, own = r();
    for (const [cx, cy] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
      corner.copy(at).addScaledVector(grown, cy * 0.5).addScaledVector(across, cx * 0.17);
      n.copy(out).setY(0.6).normalize();
      pos.push(corner.x, corner.y, corner.z); nor.push(n.x, n.y, n.z); uv.push(cx > 0 ? 1 : 0, cy);
      part.push(0, BOUGH, own, 1.05);
    }
    idx.push(first, first + 2, first + 1, first, first + 3, first + 2);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.setAttribute('part', new THREE.Float32BufferAttribute(part, 4));
  geom.setIndex(idx);
  for (const a of [geom.index, ...Object.values(geom.attributes)]) if (a) (a as { shared?: boolean }).shared = true;
  return geom;
}

