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
  const dx = (x - axle) / 0.49;
  return Math.abs(dx) >= 1 ? 0.45 : 0.45 + 0.49 * Math.sqrt(1 - dx * dx);
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

  // The atlas is authored in a 1024 x 512 layout. Set UVs only on printed
  // surfaces; the rest of the vehicle retains its own material colours.
  const print = (area: [number, number, number, number], cols: number, rows: number,
    at: (u: number, v: number) => Point, reverse = false, texV: (u: number, v: number) => number = (_, v) => v) => {
    const g = surface(cols, rows, at, reverse), [x, y, width, height] = area;
    const uv = new Float32Array(g.attributes.position.count * 2);
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
      const k = 2 * (j * (cols + 1) + i);
      uv[k] = (x + 0.5 + (width - 1) * i / cols) / 1024;
      uv[k + 1] = 1 - (y + 0.5 + (height - 1) * (1 - texV(i / cols, j / rows))) / 512;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.userData.printed = true;
    shell('#ffffff', g);
  };
  const back = 0.715, last = cabSections.length - 1;
  const glaze = (g: THREE.BufferGeometry) => { g.userData.cabWindow = true; shell(glass, g); };
  // Perimeter from the middle of the flat face round its cylindrical corner.
  const noseAt = (y: number, u: number) => {
    const [, nose, width, r] = section(y);
    const angle = Math.max(0, (u - 0.55) / 0.45) * Math.PI / 2;
    return point(nose - r * (1 - Math.cos(angle)), y,
      u < 0.55 ? (width - r) * u / 0.55 : width - r + r * Math.sin(angle));
  };
  // Use the same perimeter for the aperture in the wing and the lens cover.
  // The grille ends inboard of the inner edge at every height.
  const lampStart = 0.514, lampEnd = 0.963;
  const lampBottom = (t: number) => 0.957 + 0.105 * t + 0.020 * (1 - t) ** 5;
  const lampTop = (t: number) => 1.154 + 0.127 * t - 0.041 * t ** 5;
  const lampPoint = (side: number, t: number, v: number, recess = 0) => {
    const y = THREE.MathUtils.lerp(lampBottom(t), lampTop(t), v);
    const u = THREE.MathUtils.lerp(lampStart, lampEnd, t);
    const p = noseAt(y, u);
    const angle = Math.max(0, (u - 0.55) / 0.45) * Math.PI / 2;
    p.x -= recess * Math.cos(angle);
    p.z = side * (p.z - recess * Math.sin(angle));
    return p;
  };
  for (const side of [-1, 1]) {
    // Leave actual openings between the sill and header. Thin strips of
    // metal and gasket frame the glazing without blocking the view through it.
    for (const [low, high] of [[0, 5], [5, 8], [8, 12], [12, last]]) {
      const windowBand = low === 8;
      const heightAt = (v: number) => cabSections[low + Math.round(v * (high - low))][0];
      const noseBand = (from: number, to: number, colour: string, isGlass = false) => {
        const g = surface(16, high - low, (u, v) => {
          const p = noseAt(heightAt(v), THREE.MathUtils.lerp(from, to, u));
          p.z *= side;
          return p;
        }, side > 0);
        if (isGlass) glaze(g); else shell(colour, g);
      };
      const flank = (from: number, to: number, colour: string, isGlass = false, bumperEdge?: 'before' | 'after') => {
        const g = surface(windowBand ? 8 : 48, high - low, (u, v) => {
          const y = heightAt(v), [, nose, width, r] = section(y);
          // The moulded bumper meets the wing behind the headlight, sharing
          // the exact edge vertices so neither yellow nor black shows through.
          const seam = 2.29 + 0.19 * THREE.MathUtils.smoothstep(y, 0.48, 1.13);
          const a = bumperEdge === 'after' ? seam : back, b = bumperEdge === 'before' ? seam : nose - r;
          const x = THREE.MathUtils.lerp(a, b, THREE.MathUtils.lerp(from, to, u));
          const fender = Math.max(0, wheelLip(x, 1.82) - 0.46);
          return point(x, y + fender * Math.max(0, (1.13 - y) / 0.67), side * width);
        }, side < 0);
        if (isGlass) glaze(g); else shell(colour, g);
      };
      if (windowBand) {
        noseBand(0, 0.89, glass, true); noseBand(0.89, 0.915, seal); noseBand(0.915, 1, yellow);
        flank(0, 0.135, yellow); flank(0.135, 0.16, seal); flank(0.16, 0.88, glass, true);
        flank(0.88, 0.903, seal); flank(0.903, 1, yellow);
      } else {
        if (high <= 8) {
          const below = low === 0, colour = below ? trim : yellow;
          noseBand(0, lampStart, colour);
          noseBand(lampEnd, 1, colour);
          panel(colour, 24, high - low, (t, v) => {
            const y = below ? Math.min(heightAt(v), lampBottom(t)) : Math.max(heightAt(v), lampTop(t));
            const p = noseAt(y, THREE.MathUtils.lerp(lampStart, lampEnd, t));
            p.z *= side;
            return p;
          }, side > 0);
        } else noseBand(0, 1, yellow);
        if (low === 0) {
          flank(0, 1, yellow, false, 'before');
          flank(0, 1, trim, false, 'after');
        } else flank(0, 1, yellow);
      }
    }
    panel(yellow, 20, 1, (u, v) => {
      const p = noseAt(2.50, u);
      return point(back + (p.x - back) * v, p.y, p.z * side);
    }, side < 0);
  }

  // Bonded glass has a black ceramic edge across the scuttle and header.
  for (const y of [1.40, 2.32]) {
    panel(seal, 28, 1, (u, v) => {
      const h = y + (y < 2 ? 1 : -1) * v * 0.035;
      return front(h, (1 - 2 * u) * section(h)[2] * 0.962, 0.010);
    });
  }
  // The moulding over the cab rises from the screen to the patient box.
  panel(yellow, 32, 12, (u, v) => {
    const t = 2 * u - 1;
    const nose = 1.635 - 0.115 * t * t;
    return point(THREE.MathUtils.lerp(nose, 0.735, v),
      2.358 + 0.288 * Math.sin(v * Math.PI * 0.50) - 0.052 * t * t, t * (0.825 + 0.135 * v));
  }, true);
  for (const side of [-1, 1]) panel(yellow, 12, 4, (u, v) => {
    const x = THREE.MathUtils.lerp(1.52, 0.735, u);
    const top = 2.306 + 0.288 * Math.sin(u * Math.PI * 0.50);
    const width = 0.842 + 0.135 * u - 0.043 * (1 - v) ** 3 - 0.017 * v ** 4;
    return point(x, THREE.MathUtils.lerp(2.305, top, v), side * width);
  }, side > 0);
  // The bulkhead, dashboard and upholstery can be seen from the opposite
  // window. The back and underside of the cab do not open into the patient box.
  mould('#68645d', 0.77, 1.69, 0, 0.10, 1.60, 1.78, 0.045);
  mould('#363a3a', 1.49, 1.055, 0, 1.43, 0.21, 1.80, 0.07);
  mould('#a39d90', 1.13, 2.392, 0, 0.69, 0.085, 1.59, 0.039);
  mould('#383d3d', 1.98, 1.423, 0, 0.56, 0.20, 1.72, 0.090);
  mould('#222827', 1.90, 1.52, -0.43, 0.33, 0.16, 0.39, 0.075);
  for (const side of [-1, 1]) {
    const z = side * 0.44;
    mould('#505353', 1.19, 1.16, z, 0.56, 0.17, 0.53, 0.072);
    const seat = new RoundedBoxGeometry(0.19, 0.64, 0.52, 2, 0.072).rotateZ(0.105);
    add(seat, '#454a4a', 1.03, 1.50, z);
    mould('#494d4c', 0.999, 1.91, z, 0.17, 0.21, 0.29, 0.069);
    mould('#85847a', 1.38, 2.26, z, 0.065, 0.10, 0.46, 0.025);
    tube('#373b3b', 0.014, [point(0.93, 1.83, z + side * 0.23), point(1.09, 1.26, z - side * 0.16)]);
  }
  const wheelCentre = point(1.74, 1.50, -0.43);
  add(new THREE.TorusGeometry(0.173, 0.023, 8, 36).rotateY(Math.PI / 2).rotateZ(-0.31), '#242a2b', wheelCentre.x, wheelCentre.y, wheelCentre.z);
  mould('#303536', 1.74, 1.50, -0.43, 0.061, 0.108, 0.134, 0.027);
  for (const offset of [-0.16, 0.16]) tube(trim, 0.016, [wheelCentre, point(1.74, 1.50, -0.43 + offset)]);
  tube(trim, 0.017, [point(1.73, 1.49, -0.43), point(1.70, 1.34, -0.43)]);
  mould('#242628', 1.72, 2.19, 0, 0.056, 0.080, 0.23, 0.026);
  tube(trim, 0.013, [point(1.72, 2.19, 0), point(1.76, 2.25, 0)]);
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
  // The Sprinter's black moulding fills the whole face below the lamps.
  grille(0.533, 0.668, 0.55, seal, 0.031);
  grille(0.77, 1.142, 0.425, seal, 0.014);
  for (const y of [0.81, 0.919, 1.034]) grille(y, y + 0.024, 0.418 + (y - 0.81) * 0.22, '#53585b', 0.022);
  mould('#202729', 3.047, 0.648, 0, 0.032, 0.127, 0.49, 0.010);
  print([232, 300, 140, 31], 1, 1, (u, v) => point(3.065, 0.599 + 0.101 * v, 0.230 - 0.46 * u));
  print([740, 306, 104, 85], 12, 8, (u, v) => front(1.302 + 0.054 * v, (1 - 2 * u) * 0.109, 0.010));
  for (const side of [-1, 1]) {
    panel(trim, 10, 4, (u, v) => front(1.349 + 0.032 * v, side * (0.38 + 0.25 * u), 0.010), side > 0);
    for (let i = 0; i < 5; i++) panel('#555957', 2, 1, (u, v) => front(1.354 + 0.020 * v, side * (0.399 + 0.045 * i + 0.012 * u), 0.012), side > 0);
  }
  print([232, 348, 240, 37], 32, 5, (u, v) => front(1.172 + 0.105 * v + 0.021 * (2 * u - 1) ** 2, 0.78 * (1 - 2 * u), 0.018));
  for (const side of [-1, 1]) {
    // A dark bucket sits behind the wing. Its four returns close the recess
    // even when the player walks round to look along the side of the van.
    const socket = (u: number, v: number) => lampPoint(side, u, v, 0.122);
    panel('#353b3e', 24, 4, socket, side > 0);
    for (const edge of [0, 1]) {
      panel('#697073', 24, 1, (u, d) => lampPoint(side, u, edge, d * 0.122), (side > 0) === (edge === 0));
      panel('#50575b', 1, 6, (d, v) => lampPoint(side, edge, v, d * 0.122), (side > 0) === (edge === 0));
    }
    // Mount the reflectors on their own axes behind the wraparound cover.
    for (const [t, width, height] of [[0.25, 0.087, 0.063], [0.63, 0.065, 0.050]]) {
      const centre = lampPoint(side, t, 0.52, 0.077);
      const axis = point(1, 0.28, side * (0.16 + t * 0.50)).normalize();
      const across = point(0, 1, 0).cross(axis).normalize(), up = axis.clone().cross(across);
      const cup = (a: number, r: number, depth: number) => {
        // A rounded rectangular reflector mouth, pinched towards the bulb.
        const c = Math.cos(a), s = Math.sin(a);
        return centre.clone().addScaledVector(across, width * r * Math.sign(c) * Math.abs(c) ** 0.67)
          .addScaledVector(up, height * r * Math.sign(s) * Math.abs(s) ** 0.67).addScaledVector(axis, depth);
      };
      // Shallow flutes around the rim catch narrow highlights. The projector
      // has its own curved lens, set back inside the reflector mouth.
      for (let facet = 0; facet < 20; facet++) {
        const shade = ['#bec6c9', '#a2acb1', '#ced3d2', '#b0babf'][facet % 4];
        panel(shade, 2, 4, (u, v) => cup((facet + u) * Math.PI / 10, 0.39 + 0.61 * v,
          -0.034 * (1 - v * v) - 0.002 * Math.sin(Math.PI * u)), true);
      }
      panel('#424d58', 28, 2, (u, v) => cup(u * Math.PI * 2, 0.30 + 0.12 * v, -0.022 - 0.006 * v), true);
      panel(headlamp, 28, 4, (u, v) => cup(u * Math.PI * 2, 0.31 * v,
        -0.022 + 0.015 * Math.sqrt(1 - v * v)), true);
    }
    // A thin inner light guide and black gasket trace the sweep of the lens.
    for (const edge of [0, 1]) panel('#272d30', 24, 2, (u, v) =>
      lampPoint(side, u, edge ? 1 - v * 0.041 : v * 0.041, 0.002), (side > 0) !== (edge === 1));
    panel(headlamp, 20, 2, (u, v) => lampPoint(side, 0.09 + 0.65 * u, 0.085 + 0.044 * v, 0.027), side > 0);
    panel('#ca883b', 7, 4, (u, v) => lampPoint(side, 0.81 + 0.15 * u, 0.18 + 0.58 * v, 0.045), side > 0);
    for (const u of [0.83, 0.87, 0.91, 0.95]) {
      panel('#edb566', 1, 3, (d, v) => lampPoint(side, u + d * 0.009, 0.21 + 0.50 * v, 0.042), side > 0);
    }
    const cover = surface(24, 6, (u, v) =>
      lampPoint(side, u, v, -0.003 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v)), side > 0);
    cover.userData.cabWindow = true;
    shell('#79888d', cover);
    panel('#202528', 10, 3, (u, v) => front(0.576 + 0.062 * v + 0.018 * u, side * (0.67 + 0.17 * u), 0.008), side > 0);
    const door = (x: number, y: number) => point(x, y, side * (section(y)[2] + 0.007));
    tube('#929046', 0.008, [door(0.82, 2.31), door(0.82, 1.44), door(0.84, 0.72), door(0.90, 0.58), door(1.19, 0.58)]);
    mould(trim, 1.016, 1.32, side * 0.981, 0.217, 0.056, 0.041, 0.020);
    tube(trim, 0.031, [door(1.95, 1.50), point(1.96, 1.52, side * 1.06), point(1.93, 1.66, side * 1.13)]);
    mould(trim, 1.925, 1.75, side * 1.15, 0.151, 0.286, 0.180, 0.064);
    mould('#76878e', 1.847, 1.765, side * 1.15, 0.012, 0.206, 0.123, 0.005);
    const belt = (colour: string, low: number, high: number, end: number) =>
      panel(colour, 24, 4, (u, v) => {
        const y = low + v * (high - low) - 0.055 * u ** 3;
        const [, nose, width, r] = section(y);
        const x = THREE.MathUtils.lerp(0.83, Math.min(end, nose - 0.65 * r), u);
        const dx = Math.max(0, x - (nose - r));
        return point(x, y, side * (width - r + Math.sqrt(Math.max(0, r * r - dx * dx)) + 0.014));
      }, side < 0);
    belt('#b8202c', 1.13, 1.35, 2.49);
    belt('#006653', 0.81, 1.08, 1.32);
    print([740, 408, 200, 55], 8, 2, (u, v) => door(1.155 + side * (u - 0.5) * 0.54, 1.076 + v * 0.080));
    // Black wheel-well liner just inside the arch, and a painted rolled lip.
    const arch = (axle: number, w: number) => {
      // Close the inside of the recess behind the tyre, including the gap
      // above its shoulder when viewed at an oblique angle.
      panel(seal, 32, 1, (u, v) => {
        const a = Math.PI * (1 - u);
        return point(axle + 0.495 * Math.cos(a), 0.35 + v * (0.10 + 0.50 * Math.sin(a)), side * (w - 0.20));
      }, side < 0);
      panel(seal, 32, 1, (u, v) => {
        const a = (1 - u) * Math.PI;
        return point(axle + 0.49 * Math.cos(a), 0.45 + 0.491 * Math.sin(a), side * (w - 0.15 + v * 0.15));
      }, side > 0);
      const lip = Array.from({ length: 17 }, (_, i) => {
        const a = (1 - i / 16) * Math.PI;
        return point(axle + 0.49 * Math.cos(a), 0.45 + 0.491 * Math.sin(a), side * w);
      });
      tube(yellow, 0.019, lip);
    };
    arch(1.82, 0.98);
    arch(-1.78, 1.038);
    mould('#e2a347', -2.81, 0.82, side * 1.039, 0.13, 0.048, 0.027, 0.012);
  }

  // The patient's box has moulded corner caps and skirt cut-outs for the
  // back wheels. The livery is printed across both body sections below.
  mould(yellow, -1.115, 1.915, 0, 3.77, 1.57, 2.10, 0.095);
  const skirt = new THREE.Shape();
  skirt.moveTo(-2.99, 1.28); skirt.lineTo(0.765, 1.28); skirt.lineTo(0.765, 0.55);
  skirt.lineTo(-1.28, 0.55);
  skirt.absellipse(-1.78, 0.45, 0.50, 0.49, 0, Math.PI, false, 0);
  skirt.lineTo(-2.99, 0.55); skirt.closePath();
  const skirtGeo = new THREE.ExtrudeGeometry(skirt, { depth: 2.014, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.023, bevelSegments: 3, curveSegments: 18 });
  add(skirtGeo, yellow, 0, 0, -1.007);
  // Rounded tyre shoulders and dished rims catch the light as continuous rings.
  for (const axle of [1.82, -1.78]) for (const side of [-1, 1]) {
    const radial = (colour: string, profile: [number, number][]) =>
      add(new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r * 0.84, z)), 48)
        .rotateX(side * Math.PI / 2), colour, axle, 0.42, side * 0.871);
    radial('#212426', [[0.285, -0.146], [0.42, -0.145], [0.479, -0.122], [0.498, -0.080], [0.50, 0.068], [0.488, 0.112], [0.453, 0.137], [0.38, 0.145], [0.285, 0.14]]);
    radial('#747d80', [[0.29, 0.139], [0.279, 0.153], [0.265, 0.142], [0.22, 0.119], [0.17, 0.122], [0.12, 0.139], [0.002, 0.137]]);
    radial('#60676b', [[0.002, 0.141], [0.102, 0.14], [0.096, 0.166], [0.080, 0.178], [0.002, 0.178]]);
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      add(new THREE.CircleGeometry(0.029, 12).rotateY(side < 0 ? Math.PI : 0), seal,
        axle + 0.179 * Math.cos(a), 0.42 + 0.179 * Math.sin(a), side * 1.006);
    }
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, x = axle + 0.106 * Math.cos(a), y = 0.42 + 0.106 * Math.sin(a);
      add(new THREE.CylinderGeometry(0.017, 0.019, 0.022, 6).rotateX(Math.PI / 2),
        '#7f8580', x, y, side * 1.016);
      const tick = new THREE.Shape([new THREE.Vector2(-0.014, 0), new THREE.Vector2(0.014, 0), new THREE.Vector2(0.007, 0.034)]);
      add(new THREE.ShapeGeometry(tick).rotateZ(a).rotateY(side < 0 ? Math.PI : 0),
        '#c4cb3e', x, y, side * 1.030);
    }
  }

  // The lower vinyl follows the wheel arch. Mapping height in metres, even
  // where the skirt curves, keeps the printed squares and lettering undistorted.
  for (const side of [-1, 1]) {
    const xAt = (u: number) => side > 0 ? -2.935 + u * 3.63 : 0.695 - u * 3.63;
    const yAt = (u: number, v: number) => THREE.MathUtils.lerp(Math.max(0.566, wheelLip(xAt(u), -1.78) + 0.027), 2.621, v);
    print([side > 0 ? 4 : 516, 4, 500, 280], 100, 8, (u, v) => {
      const y = yAt(u, v);
      return point(xAt(u), y, side * 1.054);
    }, false, (u, v) => (yAt(u, v) - 0.566) / (2.621 - 0.566));
    // Glass inset, rubber gasket and a flush door latch on the kerb side.
    if (side > 0) {
      for (const x of [-0.98, 0.10]) mould('#827c53', x, 1.53, 1.056, 0.014, 1.79, 0.012, 0.005);
      mould('#93938b', -0.44, 2.424, 1.056, 1.09, 0.030, 0.016, 0.007);
      mould('#d8dbcf', -0.44, 2.034, 1.059, 0.663, 0.663, 0.018, 0.008);
      mould(seal, -0.44, 2.034, 1.075, 0.609, 0.614, 0.024, 0.011);
      mould(glass, -0.44, 2.034, 1.091, 0.561, 0.567, 0.012, 0.005);
      mould(trim, -0.85, 1.435, 1.070, 0.078, 0.147, 0.025, 0.012);
      mould(trim, -0.43, 0.475, 1.05, 1.06, 0.082, 0.20, 0.038);
      for (const z of [1.065, 1.11]) mould(steel, -0.43, 0.519, z, 1.00, 0.014, 0.023, 0.005);
    }
    // Flush lockers: narrow seals and recessed paddle handles, clear of the wheel.
    for (const x of [0.18, 0.65, -1.19]) mould('#797751', x, 1.10, side * 1.057, 0.011, 0.69, 0.009, 0.004);
    mould('#e3dcab', 0.415, 1.443, side * 1.058, 0.48, 0.024, 0.012, 0.005);
    mould('#343a38', 0.42, 1.32, side * 1.071, 0.087, 0.116, 0.022, 0.010);
    mould(steel, 0.42, 1.321, side * 1.085, 0.035, 0.065, 0.010, 0.004);
    mould('#aec3c9', -0.08, 2.576, side * 1.063, 0.17, 0.054, 0.021, 0.010);
    for (const x of [-2.76, -1.24, 0.48]) mould('#e0a347', x, 0.822, side * 1.055, 0.113, 0.037, 0.025, 0.010);
  }
  print([4, 292, 214, 211], 1, 1, (u, v) => point(-3.017, 0.61 + 2.015 * v, -0.939 + 1.878 * u));
  print([232, 300, 140, 31], 1, 1, (u, v) => point(-3.041, 0.748 + 0.102 * v, -0.685 + 0.47 * u));
  print([232, 399, 240, 60], 24, 4, (u, v) => front(2.344 + v * 0.095, (1 - 2 * u) * 0.37, 0.023));

  // Coloured end caps and an aluminium spine over the windscreen.
  mould(trim, 1.275, 2.54, 0, 0.285, 0.14, 1.78, 0.06);
  mould('#c1cbd1', 1.275, 2.66, 0, 0.286, 0.145, 1.75, 0.060);
  for (const side of [-1, 1]) {
    mould(seal, 3.016, .96, side * .305, .041, .066, .162, .012);
    // Separate LED optics behind the clear front edge of the bar.
    for (let lamp = 0; lamp < 4; lamp++) mould('#93b8cf', 1.423, 2.668, side * (0.41 + 0.108 * lamp), 0.022, 0.054, 0.071, 0.010);
    mould(side < 0 ? '#a52832' : '#21569d', 1.275, 2.665, side * 0.59, 0.29, 0.16, 0.59, 0.065);
    mould('#d9dcd3', 1.275, 2.745, side * 0.59, 0.20, 0.012, 0.52, 0.005);
    mould(side < 0 ? '#a52832' : '#21569d', -2.80, 2.695, side * 0.84, 0.306, 0.16, 0.31, 0.059);
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
