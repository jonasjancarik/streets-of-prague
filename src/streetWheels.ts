// Close wheel assemblies for civilian cars. The hub face lies towards +z.
// Radial dimensions are fractions of the tyre radius, axial ones fractions
// of its width. The Blender body supplies the actual measurements per model.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Rim = 'steel' | 'alloy' | 'split' | 'touring';
const templates = new Map<Rim, THREE.BufferGeometry>();

function wheel(rim: Rim) {
  const parts: THREE.BufferGeometry[] = [];
  const part = (g: THREE.BufferGeometry, colour: string) => {
    g.deleteAttribute('uv');
    const c = new THREE.Color(colour), rgb = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    parts.push(g);
  };
  const turn = (colour: string, profile: [number, number][], n = rim === 'touring' ? 64 : 32) =>
    part(new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), n).rotateX(Math.PI / 2), colour);
  // Inner and outer sidewalls roll into a gently crowned tread. Two
  // circumferential grooves remain visible when the front wheels turn out.
  turn('#252626', [[0.65, -0.42], [0.79, -0.50], [0.89, -0.48], [0.956, -0.39], [0.99, -0.28], [1, -0.16],
  [0.986, -0.145], [1, -0.127], [1, 0.115], [0.985, 0.134], [1, 0.15], [0.991, 0.28], [0.97, 0.36], [0.92, 0.423],
  [0.83, 0.48], [0.74, 0.48], [0.68, 0.44], [0.65, 0.403]]);
  turn('#363737', [[0.835, 0.477], [0.847, 0.481], [0.858, 0.476]]);
  turn('#464a4a', [[0.64, -0.39], [0.666, -0.38], [0.67, 0.38], [0.652, 0.444], [0.613, 0.446], [0.602, 0.37]]);
  const disc = (colour: string, radius: number, z: number, segments = 24) =>
    part(new THREE.CircleGeometry(radius, segments).translate(0, 0, z), colour);
  // Rotor behind the open spokes, with a darker unswept hat in the middle.
  disc('#505355', 0.527, 0.115);
  disc('#383c3d', 0.32, 0.12);
  if (rim === 'touring') {
    // A machined face on a darker casting. Each of the five arms forks near
    // the bolt circle. The flanks continue down into the barrel.
    turn('#b5babc', [[.67, .437], [.674, .467], [.656, .478], [.635, .468], [.62, .415]]);
    turn('#565b5e', [[.57, .11], [.57, .15], [.33, .15], [.30, .12]], 48);
    for (const r of [.35, .402, .46, .53]) turn('#868888', [[r, .149], [r + .006, .152], [r + .012, .149]], 48);
    for (let i = 0; i < 5; i++) for (const side of [-1, 1]) {
      const angle = i * Math.PI * 2 / 5, pos: number[] = [], indices: number[] = [], rgb: number[] = [];
      // Radius, sweep, half width, and outward offset of the cut face.
      const stations = [[.19, .013, .064, .336], [.32, .021, .043, .377], [.41, .071, .028, .402], [.54, .137, .024, .434], [.655, .188, .043, .446]];
      for (const [r, bend, w, z] of stations) {
        for (const [across, depth, tone] of [[-1, -.084, .27], [-.76, -.010, .54], [-.52, .002, .82], [.63, .002, .84], [1, -.022, .45], [.96, -.086, .24]]) {
          const a = angle + .11 * r, off = side * bend + across * w;
          pos.push(Math.cos(a) * r - Math.sin(a) * off, Math.sin(a) * r + Math.cos(a) * off, z + depth);
          rgb.push(tone * .85, tone * .89, tone * .91);
        }
      }
      for (let j = 0; j < stations.length - 1; j++) for (let k = 0; k < 5; k++) {
        const v = j * 6 + k; indices.push(v, v + 6, v + 7, v, v + 7, v + 1);
      }
      const g = new THREE.BufferGeometry(); g.setIndex(indices);
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(rgb, 3)); g.computeVertexNormals(); parts.push(g);
    }
    // Tread shoulders, mould lines and valve. Actual gaps remain between spokes.
    turn('#333434', [[.748, .480], [.756, .486], [.766, .484]]);
    turn('#303131', [[.893, .445], [.903, .449], [.912, .437]]);
    const marks: number[] = [], triangles: number[] = [];
    for (let i = 0; i < 56; i++) for (const side of [-1, 1]) {
      const a = i * Math.PI * 2 / 56, first = marks.length / 3;
      for (const [da, r, z] of [[0, .992, .272], [.010, .992, .272], [.041, .951, .403], [.030, .951, .403]]) {
        marks.push(Math.cos(a + side * da) * r, Math.sin(a + side * da) * r, side * z);
      }
      triangles.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    const grooves = new THREE.BufferGeometry(); grooves.setIndex(triangles);
    grooves.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3)); grooves.computeVertexNormals(); part(grooves, '#191b1c');
    part(new THREE.CylinderGeometry(.015, .026, .066, 8).rotateX(Math.PI / 2).translate(.47, -.38, .423), '#292d30');
  } else if (rim === 'steel') {
    // Form each sector of the pressed dish round an oval ventilation hole.
    const count = 10, delta = Math.PI / count;
    for (let i = 0; i < count; i++) {
      const shape = new THREE.Shape();
      const x = Math.cos(delta), y = Math.sin(delta);
      shape.moveTo(0.27 * x, -0.27 * y); shape.lineTo(0.62 * x, -0.62 * y);
      shape.absarc(0, 0, 0.62, -delta, delta, false);
      shape.lineTo(0.27 * x, 0.27 * y); shape.closePath();
      const hole = new THREE.Path();
      hole.absellipse(0.477, 0, 0.085, 0.088, 0, Math.PI * 2, true, 0);
      shape.holes.push(hole);
      const g = new THREE.ShapeGeometry(shape, 4), pos = g.attributes.position;
      for (let j = 0; j < pos.count; j++) {
        const r = Math.hypot(pos.getX(j), pos.getY(j));
        pos.setZ(j, 0.24 + 0.12 * ((r - 0.46) / 0.23) ** 2);
      }
      g.computeVertexNormals();
      part(g.rotateZ(i * 2 * delta), '#737b7d');
    }
  } else {
    // Cast spokes sweep outwards from the recessed bolt circle. Their two
    // sloping side faces read as metal even with a stationary camera.
    const count = rim === 'split' ? 10 : 5;
    for (let i = 0; i < count; i++) {
      const a = i * 2 * Math.PI / count;
      const sweep = rim === 'split' ? (i % 2 ? -0.10 : 0.10) : 0.08;
      const w = rim === 'split' ? 0.036 : 0.067;
      const pos: number[] = [];
      for (const [r, centre, half, z] of [[0.19, 0, w * 0.9, 0.365], [0.42, sweep * 0.55, w, 0.38], [0.635, sweep, w * 1.18, 0.415]]) {
        for (const [offset, depth] of [[-half, -0.05], [-half * 0.64, 0], [half * 0.68, 0.008], [half, -0.05]]) {
          pos.push(Math.cos(a) * r - Math.sin(a) * (centre + offset), Math.sin(a) * r + Math.cos(a) * (centre + offset), z + depth);
        }
      }
      const g = new THREE.BufferGeometry(), indices: number[] = [];
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
        const k = row * 4 + col;
        indices.push(k, k + 4, k + 5, k, k + 5, k + 1);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(indices); g.computeVertexNormals();
      part(g, '#a7abad');
    }
    turn('#b8bcbf', [[0.65, 0.427], [0.63, 0.453], [0.609, 0.452], [0.60, 0.415]]);
  }
  turn('#7b8283', [[0.266, 0.272], [0.25, 0.38], [0.2, 0.397], [0.12, 0.392], [0.10, 0.414], [0.002, 0.414]]);
  for (let i = 0; i < 5; i++) {
    const a = i * 2 * Math.PI / 5, x = 0.17 * Math.cos(a), y = 0.17 * Math.sin(a);
    part(new THREE.CircleGeometry(0.043, 10).translate(x, y, 0.404), '#393d3d');
    part(new THREE.CircleGeometry(0.029, 6).rotateZ(0.3).translate(x, y, 0.411), '#898e8f');
  }
  return mergeGeometries(parts)!;
}

// The dark tub behind the tyre stays on the body. Without the back of the
// wheel well, daylight and pavement show through the gap above the shoulder.
function wheelWell(x: number, radius: number, z: number, width: number) {
  const pos: number[] = [], indices: number[] = [], side = Math.sign(z);
  const depth = z - side * (width * 0.52 + 0.045);
  pos.push(x, radius - 0.12, depth);
  const segments = 20;
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * Math.PI;
    const px = x + (radius + 0.058) * Math.cos(a), y = radius + (radius + 0.058) * Math.sin(a);
    pos.push(px, y, depth, px, y, z + side * width * 0.43);
    if (!i) continue;
    const back = 1 + i * 2, lip = back + 1;
    indices.push(0, back - 2, back, back - 2, lip, back, back - 2, lip - 2, lip);
  }
  if (side < 0) indices.reverse();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(0.009), 3));
  g.setAttribute('hinge', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}

export function buildStreetWheels(type: string, mounts: readonly number[]) {
  const rim: Rim = type === 'sport-sedan' ? 'touring' : type === 'van' || type === 'hatch' ? 'steel' : type === 'suv' || type === 'estate' ? 'split' : 'alloy';
  let original = templates.get(rim);
  if (!original) { original = wheel(rim); templates.set(rim, original); }
  const wheels: THREE.BufferGeometry[] = [];
  for (let i = 0; i < mounts.length; i += 4) {
    const [x, radius, z, width] = mounts.slice(i, i + 4);
    const g = original.clone().scale(radius, radius, width);
    if (z < 0) g.rotateY(Math.PI);
    g.translate(x, radius, z);
    const n = g.attributes.position.count, hinge = new Float32Array(n * 3);
    // Negative hinge.z identifies a wheel to the close-body shader. The
    // magnitude holds its radius; the steering axle is ahead of the middle.
    for (let j = 0; j < hinge.length; j += 3) hinge.set([x, z, -radius], j);
    g.setAttribute('hinge', new THREE.BufferAttribute(hinge, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n), 1));
    wheels.push(g, wheelWell(x, radius, z, width));
    if (rim === 'touring') {
      // The caliper follows steering but stays put as the disc turns.
      const caliper = new THREE.CapsuleGeometry(1, 2, 3, 8).scale(radius * .082, radius * .105, width * .075);
      caliper.deleteAttribute('uv');
      caliper.rotateZ(.26).translate(x - radius * .43, radius * 1.10, z + Math.sign(z) * width * .22);
      const n = caliper.attributes.position.count, pivots = new Float32Array(n * 3), rgb = new Float32Array(n * 3);
      const coat = new THREE.Color('#62625c');
      for (let k = 0; k < n; k++) { pivots.set([x, z, -radius - 2], k * 3); coat.toArray(rgb, k * 3); }
      caliper.setAttribute('color', new THREE.BufferAttribute(rgb, 3)); caliper.setAttribute('hinge', new THREE.BufferAttribute(pivots, 3));
      caliper.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n), 1)); wheels.push(caliper);
    }
  }
  return wheels;
}
