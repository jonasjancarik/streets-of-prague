// The cab, wheels and fittings seen at street level. Coordinates match the
// overhead ambulance: +x forward, +z kerb side, ground at y = 0.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

type Add = (g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number) => void;
type Point = THREE.Vector3;
const point = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const yellow = '#e6dc24', trim = '#34383a', seal = '#1b2225', glass = '#30414a';
const steel = '#a2a7a8', headlamp = '#fff6d8', tailLamp = '#b3161b';

// Each horizontal section gives height, nose, half-width and front corner radius.
// Above the bonnet the sections recede into the windscreen; the top turns
// gently into the roof. All the fittings follow this same painted surface.
const cabSections = [
  [0.46, 2.91, 0.88, 0.28], [0.53, 2.98, 0.95, 0.32], [0.69, 3.01, 0.98, 0.34],
  [0.81, 3.02, 0.98, 0.34], [0.98, 3.00, 0.985, 0.34], [1.13, 2.93, 0.99, 0.38],
  [1.23, 2.82, 0.985, 0.41], [1.32, 2.59, 0.976, 0.35], [1.40, 2.34, 0.965, 0.25],
  [1.46, 2.29, 0.954, 0.23], [1.85, 2.05, 0.924, 0.215], [2.20, 1.81, 0.88, 0.19],
  [2.32, 1.70, 0.85, 0.17], [2.385, 1.64, 0.83, 0.16], [2.46, 1.57, 0.78, 0.15],
  [2.50, 1.49, 0.69, 0.14],
];
function section(y: number) {
  const i = cabSections.findIndex(s => s[0] >= y);
  if (i <= 0) return cabSections[i === 0 ? 0 : cabSections.length - 1];
  const a = cabSections[i - 1], b = cabSections[i], t = (y - a[0]) / (b[0] - a[0]);
  return a.map((v, j) => v + t * (b[j] - v));
}
function front(y: number, z: number, offset = 0) {
  const [, nose, width, radius] = section(y);
  const u = THREE.MathUtils.clamp((Math.abs(z) - width + radius) / radius, 0, 1);
  return point(nose - radius * (1 - Math.sqrt(1 - u * u)) + offset, y, z);
}
function wheelLip(x: number, axle: number) {
  const dx = (x - axle) / 0.57;
  return Math.abs(dx) >= 1 ? 0.45 : 0.45 + 0.61 * Math.sqrt(1 - dx * dx);
}

// Curved body panels and flush decals, triangulated along the surface. Shared
// vertices within each panel give continuous normals across the bonnet and glass.
function surface(cols: number, rows: number, at: (u: number, v: number) => Point, reverse = false) {
  const vertices: number[] = [], indices: number[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const p = at(i / cols, j / rows);
    vertices.push(p.x, p.y, p.z);
    if (!i || !j) continue;
    const d = j * (cols + 1) + i, c = d - 1, b = d - cols - 1, a = b - 1;
    if (reverse) indices.push(a, d, b, a, c, d);
    else indices.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

export function ambulanceStreet(add: Add) {
  const shell = (colour: string, g: THREE.BufferGeometry) => add(g, colour, 0, 0, 0);
  const mould = (colour: string, x: number, y: number, z: number, length: number, height: number, width: number, radius: number) =>
    add(new RoundedBoxGeometry(length, height, width, radius >= 0.05 ? 2 : 1, radius), colour, x, y, z);
  const tube = (colour: string, radius: number, pts: Point[]) => {
    const curve = new THREE.CatmullRomCurve3(pts);
    shell(colour, new THREE.TubeGeometry(curve, pts.length === 2 ? 1 : pts.length * 3, radius, 8, false));
  };
  const panel = (colour: string, cols: number, rows: number, at: (u: number, v: number) => Point, reverse = false) =>
    shell(colour, surface(cols, rows, at, reverse));

  const last = cabSections.length - 1, back = 0.715;
  const cabHeight = (v: number) => cabSections[Math.round(v * last)][0];
  // Perimeter from the middle of the flat face round its cylindrical corner.
  const noseAt = (y: number, u: number) => {
    const [, nose, width, r] = section(y);
    const angle = Math.max(0, (u - 0.55) / 0.45) * Math.PI / 2;
    return point(nose - r * (1 - Math.cos(angle)), y,
      u < 0.55 ? (width - r) * u / 0.55 : width - r + r * Math.sin(angle));
  };
  for (const side of [-1, 1]) {
    for (const [colour, low, high] of [[trim, 0, 2], [yellow, 2, last]] as const) {
      panel(colour, 20, high - low, (u, v) => {
        const p = noseAt(cabSections[low + Math.round(v * (high - low))][0], u);
        p.z *= side;
        return p;
      }, side > 0);
    }
    panel(yellow, 48, last, (u, v) => {
      const y = cabHeight(v), [, nose, w, r] = section(y), x = back + u * (nose - r - back);
      const fender = Math.max(0, wheelLip(x, 1.82) - 0.46);
      return point(x, y + fender * Math.max(0, (1.13 - y) / 0.67), side * w);
    }, side < 0);
    panel(yellow, 20, 1, (u, v) => {
      const p = noseAt(2.50, u);
      return point(back + (p.x - back) * v, p.y, p.z * side);
    }, side < 0);
  }

  // Glass and rubber gasket share their curvature with the underlying cab.
  const screen = (colour: string, low: number, high: number, span: number, offset: number) =>
    panel(colour, 32, 12, (u, v) => {
      const t = u * 2 - 1;
      const y = THREE.MathUtils.lerp(low + 0.055 * t * t, high - 0.06 * t * t, v);
      return front(y, t * span * section(y)[2], offset);
    }, true);
  screen(seal, 1.408, 2.376, 0.975, 0.012);
  screen(glass, 1.438, 2.353, 0.949, 0.020);
  for (const z of [-0.42, 0.44]) {
    tube(seal, 0.014, [front(1.466, z - 0.16, 0.039), front(1.50, z + 0.03, 0.039)]);
    tube(trim, 0.013, [-0.28, 0, 0.28].map((dz, i) => front(1.50 + i * 0.014, z + dz, 0.042)));
  }

  // The grille and lamp lenses bend round the same nose as the bonnet.
  const grille = (y0: number, y1: number, width: number, colour: string, offset: number) =>
    panel(colour, 20, 6, (u, v) => {
      const t = 2 * u - 1;
      const y = THREE.MathUtils.lerp(y0 + t * t * 0.018, y1 + t * t * 0.018, v);
      return front(y, t * (width + 0.085 * v), offset);
    }, true);
  grille(0.48, 0.585, 0.38, seal, 0.026);
  grille(0.765, 1.115, 0.43, seal, 0.017);
  for (const y of [0.81, 0.92, 1.03]) grille(y, y + 0.026, 0.445 + (y - 0.81) * 0.24, steel, 0.029);
  mould('#e7e6df', 3.026, 0.633, 0, 0.034, 0.107, 0.46, 0.008);
  for (const side of [-1, 1]) {
    const lens = (colour: string, inset: number, offset: number) =>
      panel(colour, 18, 5, (u, v) => {
        const z = (0.505 + inset + u * (0.439 - 2 * inset)) * side;
        const y = 0.982 + 0.124 * u + inset + (0.102 + 0.038 * Math.sin(Math.PI * u) - 2 * inset) * v;
        return front(y, z, offset);
      }, side > 0);
    lens(trim, 0, 0.024);
    lens(headlamp, 0.014, 0.035);
    // A narrow reflector visible through the lower edge of each lens.
    panel('#bccbd1', 16, 1, (u, v) => {
      const z = side * (0.54 + 0.37 * u);
      return front(1.008 + 0.11 * u + 0.012 * v, z, 0.041);
    }, side > 0);
    // The black bumper returns round each front corner to the wheel opening.
    panel(trim, 12, 4, (u, v) => {
      const y = 0.46 + v * 0.23, [, nose, w, r] = section(y);
      return point(THREE.MathUtils.lerp(2.42, nose - r, u), y, side * (w + 0.001));
    }, side < 0);
    const fog = front(0.607, side * 0.76, 0.014);
    mould('#c2cdd0', fog.x, fog.y, fog.z, 0.033, 0.052, 0.122, 0.015);
    // One broad side window tapers towards the A-pillar.
    for (const [colour, inset, offset] of [[seal, 0, 0.004], [glass, 0.035, 0.009]] as const) {
      panel(colour, 14, 12, (u, v) => {
        const y = 1.42 + inset + v * (0.92 - 2 * inset) + 0.033 * (1 - u) ** 4 - 0.05 * u ** 5 * v;
        const [, nose, width, r] = section(y);
        return point(THREE.MathUtils.lerp(0.88 + inset, nose - r - 0.06 - inset, u), y, side * (width + offset));
      }, side < 0);
    }
    const door = (x: number, y: number) => point(x, y, side * (section(y)[2] + 0.007));
    tube('#929046', 0.008, [door(0.82, 2.31), door(0.82, 1.44), door(0.84, 0.72), door(0.90, 0.58), door(1.19, 0.58)]);
    mould(trim, 1.016, 1.32, side * 0.981, 0.217, 0.056, 0.041, 0.020);
    tube(trim, 0.031, [door(1.95, 1.50), point(1.96, 1.52, side * 1.06), point(1.93, 1.66, side * 1.13)]);
    mould(trim, 1.925, 1.75, side * 1.15, 0.151, 0.286, 0.180, 0.064);
    mould('#76878e', 1.847, 1.765, side * 1.15, 0.012, 0.206, 0.123, 0.005);
    panel('#df3829', 12, 2, (u, v) => door(0.86 + u * 0.99, 1.13 + v * 0.092), side < 0);
    // Black wheel-well liner just inside the arch, and a painted rolled lip.
    const arch = (axle: number, w: number) => {
      panel(seal, 32, 1, (u, v) => {
        const a = (1 - u) * Math.PI;
        return point(axle + 0.565 * Math.cos(a), 0.45 + 0.612 * Math.sin(a), side * (w - 0.15 + v * 0.15));
      }, side > 0);
      const lip = Array.from({ length: 17 }, (_, i) => {
        const a = (1 - i / 16) * Math.PI;
        return point(axle + 0.565 * Math.cos(a), 0.45 + 0.612 * Math.sin(a), side * w);
      });
      tube(yellow, 0.019, lip);
    };
    arch(1.82, 0.98);
    arch(-1.78, 1.038);
    mould('#e2a347', -2.81, 0.82, side * 1.039, 0.13, 0.048, 0.027, 0.012);
  }

  // The patient's box has moulded corner caps and skirt cut-outs for the
  // back wheels. Its flat faces carry the same livery as the overhead mesh.
  mould(yellow, -1.115, 1.915, 0, 3.77, 1.57, 2.10, 0.095);
  const skirt = new THREE.Shape();
  skirt.moveTo(-2.99, 1.28); skirt.lineTo(0.765, 1.28); skirt.lineTo(0.765, 0.55);
  skirt.lineTo(-1.20, 0.55);
  skirt.absellipse(-1.78, 0.46, 0.58, 0.61, 0, Math.PI, false, 0);
  skirt.lineTo(-2.99, 0.55); skirt.closePath();
  const skirtGeo = new THREE.ExtrudeGeometry(skirt, { depth: 2.014, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.023, bevelSegments: 3, curveSegments: 18 });
  add(skirtGeo, yellow, 0, 0, -1.007);
  // Rounded tyre shoulders and dished rims catch the light as continuous rings.
  for (const axle of [1.82, -1.78]) for (const side of [-1, 1]) {
    const radial = (colour: string, profile: [number, number][]) =>
      add(new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), 48)
        .rotateX(side * Math.PI / 2), colour, axle, 0.50, side * 0.871);
    radial('#212426', [[0.285, -0.146], [0.42, -0.145], [0.479, -0.122], [0.498, -0.080], [0.50, 0.068], [0.488, 0.112], [0.453, 0.137], [0.38, 0.145], [0.285, 0.14]]);
    radial(steel, [[0.29, 0.139], [0.279, 0.153], [0.265, 0.142], [0.22, 0.119], [0.17, 0.122], [0.12, 0.139], [0.002, 0.137]]);
    radial('#60676b', [[0.002, 0.141], [0.102, 0.14], [0.096, 0.166], [0.080, 0.178], [0.002, 0.178]]);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      add(new THREE.CircleGeometry(0.034, 12).rotateY(side < 0 ? Math.PI : 0), seal,
        axle + 0.213 * Math.cos(a), 0.50 + 0.213 * Math.sin(a), side * 1.006);
    }
  }

  // Smooth signwriter's numerals for the emergency number seen from the pavement.
  const one = new THREE.Shape();
  one.moveTo(0.07, 0); one.lineTo(0.07, 0.235); one.lineTo(0.012, 0.207);
  one.lineTo(0, 0.256); one.lineTo(0.078, 0.31); one.lineTo(0.132, 0.31); one.lineTo(0.132, 0);
  const five = new THREE.Shape();
  five.moveTo(0.190, 0.311); five.lineTo(0.022, 0.311); five.lineTo(0.010, 0.145);
  five.quadraticCurveTo(0.125, 0.183, 0.138, 0.117);
  five.bezierCurveTo(0.160, 0.044, 0.070, 0.038, 0.019, 0.072);
  five.lineTo(0, 0.021);
  five.bezierCurveTo(0.081, -0.027, 0.204, -0.006, 0.205, 0.105);
  five.bezierCurveTo(0.207, 0.187, 0.138, 0.221, 0.073, 0.207);
  five.lineTo(0.078, 0.254); five.lineTo(0.190, 0.254);
  const digits = [one, five, five];
  const offsets = [-0.32, -0.139, 0.098];
  digits.forEach((shape, i) => {
    const numeral = new THREE.ShapeGeometry(shape, 8);
    for (const side of [-1, 1]) {
      add(numeral.clone().rotateY(side < 0 ? Math.PI : 0), '#253544', -1.23 + side * offsets[i], 1.75, side * 1.058);
    }
    add(numeral.scale(0.51, 0.51, 1).rotateY(-Math.PI / 2), '#253544', -3.014, 0.86, 0.48 + offsets[i] * 0.51);
  });

  // Curved blue end caps and an aluminium spine over the windscreen.
  mould(trim, 1.275, 2.54, 0, 0.285, 0.14, 1.78, 0.06);
  mould('#c1cbd1', 1.275, 2.66, 0, 0.286, 0.145, 1.75, 0.060);
  for (const side of [-1, 1]) {
    mould('#21569d', 1.275, 2.665, side * 0.59, 0.29, 0.16, 0.59, 0.065);
    mould('#21569d', -2.80, 2.695, side * 0.84, 0.306, 0.16, 0.31, 0.059);
    mould(seal, -3.006, 1.94, side * 0.45, 0.038, 0.60, 0.72, 0.018);
    mould(glass, -3.028, 1.94, side * 0.45, 0.019, 0.54, 0.662, 0.009);
    for (const y of [0.87, 2.28]) mould(steel, -3.014, y, side * 0.88, 0.043, 0.092, 0.17, 0.018);
    mould(seal, -3.008, 1.19, side * 0.946, 0.049, 0.65, 0.128, 0.024);
    mould(tailLamp, -3.035, 1.19, side * 0.946, 0.025, 0.56, 0.098, 0.011);
    mould('#f2bd61', -3.051, 1.29, side * 0.946, 0.012, 0.077, 0.079, 0.005);
    mould('#b8c1c4', -3.054, 1.03, side * 0.946, 0.012, 0.057, 0.079, 0.005);
  }
  mould(trim, -3.007, 0.80, -0.45, 0.032, 0.135, 0.51, 0.014);
  mould('#e9e7d9', -3.025, 0.80, -0.45, 0.013, 0.109, 0.477, 0.006);
  mould('#244780', -3.034, 0.80, -0.656, 0.010, 0.104, 0.044, 0.004);
  mould(trim, -3.025, 0.427, 0, 0.213, 0.135, 1.91, 0.053);
  for (let i = 0; i < 11; i++) mould('#687075', -3.067, 0.497, (i - 5) * 0.144, 0.099, 0.012, 0.090, 0.005);
}
