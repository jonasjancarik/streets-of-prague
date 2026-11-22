// Fourth-generation Petřín car. Local +X is uphill. The exterior follows the cable;
// the four passenger landings and their door frames are level on the design grade.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { pane, strut, tint, type Point3 } from './vehicleFittings.ts';

const grade = .25, white = '#e3e4df', black = '#212729', gasket = '#343c3c';
const alloy = '#9ca8a5', glass = '#364b50';
const width = 1.25, compartments = 4;
const base = (x: number) => grade * x;

export function petrinCar(number: number, close: boolean) {
  const body: THREE.BufferGeometry[] = [], windows: THREE.BufferGeometry[] = [];
  function add(g: THREE.BufferGeometry, colour: string, glow = 0, window = false) {
    tint(g, colour);
    g.setAttribute('streetGlow', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(glow), 1));
    (window && close ? windows : body).push(g);
  }
  function box(x: number, y: number, z: number, l: number, h: number, w: number, colour: string, glow = 0) {
    add(new THREE.BoxGeometry(l, h, w).translate(x, y, z), colour, glow);
  }
  const rail = (a: Point3, b: Point3, r: number, colour = alloy) => add(strut(a, b, r, 8), colour);
  // Radiused corners in plan. Each successive ring can rake inward, as at the
  // transition from the black windscreens to the white crown around the roof.
  type Ring = [number, number, number, number]; // half-length, half-width, height above rail, corner radius
  function rim(layers: Ring[], colour: string) {
    const pos: number[] = [], ix: number[] = [], segments = close ? 6 : 3;
    const count = 4 * (segments + 1);
    for (const [l, w, y, r] of layers) {
      for (let corner = 0; corner < 4; corner++) {
        const cx = (corner === 0 || corner === 3 ? 1 : -1) * (l - r);
        const cz = (corner < 2 ? 1 : -1) * (w - r);
        for (let k = 0; k <= segments; k++) {
          const a = (corner + k / segments) * Math.PI / 2, x = cx + r * Math.cos(a);
          pos.push(x, base(x) + y, cz + r * Math.sin(a));
        }
      }
    }
    for (let row = 1; row < layers.length; row++) for (let k = 0; k < count; k++) {
      const i = (row - 1) * count + k, j = (row - 1) * count + (k + 1) % count;
      ix.push(i, i + count, j + count, i, j + count, j);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(ix); g.computeVertexNormals();
    add(g, colour);
  }
  const band = (x0: number, x1: number, y: number, z: number, w: number, h: number, colour: string, glow = 0) => {
    const x = (x1 + x0) / 2;
    add(new THREE.BoxGeometry((x1 - x0) * Math.hypot(1, grade), h, w).rotateZ(Math.atan(grade)).translate(x, base(x) + y, z), colour, glow);
  };
  const window = (a: Point3, b: Point3, c: Point3, d: Point3) => add(pane(a, b, c, d), glass, .10, true);
  rim([[6.82, 1.10, .43, .24], [7, 1.24, .56, .24], [7, width, .87, .22],
  [6.98, width, 1.02, .21]], white);
  rim([[6.98, width, 1.02, .21], [6.97, 1.245, 1.12, .20]], black);
  rim([[6.71, 1.20, 2.95, .18], [6.70, 1.22, 3.05, .22], [6.65, 1.19, 3.14, .24],
  [6.61, 1.12, 3.18, .25], [6.59, .99, 3.18, .23]], white);
  band(-6.84, 6.84, .47, 0, 2.18, .13, '#4c5454');
  band(-6.45, 6.45, .34, 0, 1.32, .23, '#353c3c');
  for (const axle of [-4.45, 4.45]) for (const side of [-1, 1]) {
    const z = side * .719, y = base(axle) + .29;
    add(new THREE.CylinderGeometry(.31, .31, .15, close ? 20 : 10).rotateX(Math.PI / 2).translate(axle, y, z), '#454a49');
    if (close) add(new THREE.CylinderGeometry(.17, .17, .035, 16).rotateX(Math.PI / 2)
      .translate(axle, y, z + side * .083), '#717775');
  }
  for (const side of [-1, 1]) {
    const z = side * (width - .031);
    const wallPoint = (x: number, y: number): Point3 => [x, base(x) + y, z - side * .027 * (y - 1.12)];
    const corners = [wallPoint(-6.94, 1.12), wallPoint(6.94, 1.12), wallPoint(6.68, 3.0), wallPoint(-6.68, 3.0)] as const;
    if (side > 0) window(...corners); else window(corners[3], corners[2], corners[1], corners[0]);
    band(-6.70, 6.70, 2.94, z - side * .047, .086, .14, black);
    // Slim black columns distinguish the fixed panorama panes from paired door leaves.
    for (let bay = 0; bay < compartments; bay++) {
      const x = (bay - 1.5) * 3.40, floor = base(x) + .90;
      const centre = x - .60;
      for (const dx of [-.62, 0, .62]) {
        const at = centre + dx;
        const lo = wallPoint(at, 1.04), hi = wallPoint(at, 2.93);
        rail(lo, hi, dx ? .044 : .021, black);
        if (close) {
          const seamZ = side * (width + .004);
          rail([at, base(at) + .56, seamZ], [at, base(at) + 1.04, seamZ], .009, '#87918d');
        }
      }
      if (close) {
        box(centre, floor - .035, side * 1.22, 1.24, .05, .14, alloy);
        const at = centre + .73;
        add(new THREE.CylinderGeometry(.055, .055, .018, 16).rotateX(Math.PI / 2)
          .translate(at, base(at) + 1.49, side * 1.223), '#c9cebf');
      }
    }
    // The glazing continues overhead between white cant rails and transverse seals.
    band(-6.62, 6.62, 3.145, side * 1.015, .28, .08, white);
    band(-6.58, 6.58, 3.173, side * .86, .043, .038, gasket);
  }
  for (let i = 0; i < 8; i++) {
    const x0 = -6.44 + i * 1.61, x1 = x0 + 1.61;
    window([x0, base(x0) + 3.16, .88], [x1, base(x1) + 3.16, .88],
      [x1, base(x1) + 3.16, -.88], [x0, base(x0) + 3.16, -.88]);
    box(x0, base(x0) + 3.16, 0, .042, .052, 1.79, black);
  }
  for (const end of [-1, 1]) {
    // The end skirt leaves the brake gear visible below the nose.
    band(end * 6.25 - .41, end * 6.25 + .41, .31, 0, 1.65, .30, '#393f40');
    if (close) {
      for (const z of [-.65, .65]) {
        box(end * 6.67, base(end * 6.67) + .31, z, .11, .26, .19, '#565c5a');
        rail([end * 6.72, base(end * 6.72) + .28, z], [end * 6.74, base(end * 6.74) + .28, z], .052, '#969a91');
      }
      rail([end * 6.57, base(end * 6.57) + .17, -.79], [end * 6.57, base(end * 6.57) + .17, .79], .032);
    }
    const at = (h: number, z: number, offset = 0): Point3 => {
      const bow = .043 * (1 - (z / 1.08) ** 4);
      const x = end * (7 - .29 * THREE.MathUtils.clamp((h - 1.03) / 2, 0, 1) + bow + offset);
      return [x, base(x) + h, z];
    };
    const face = (lo: number, hi: number, w0: number, w1: number, colour: string, glazed = false, offset = 0) => {
      const g = new THREE.PlaneGeometry(1, 1, close ? 12 : 6, 3);
      const pos = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const v = uv.getY(i), z = end * (1 - 2 * uv.getX(i)) * THREE.MathUtils.lerp(w0, w1, v);
        pos.setXYZ(i, ...at(THREE.MathUtils.lerp(lo, hi, v), z, offset));
      }
      g.computeVertexNormals(); add(g, colour, 0, glazed);
    };
    face(.68, .77, .94, 1.055, black, false, .027);
    face(.77, 1.48, 1.055, 1.055, black, false, .027);
    if (close) face(.77, 1.48, 1.055, 1.055, glass, true, .033);
    face(1.48, 2.91, 1.055, 1.015, glass, true);
    face(2.91, 3.02, 1.02, 1.02, black);
    for (const side of [-1, 1]) {
      // The white ends wrap around the corners, joining the lower apron to the roof.
      const edge = at(1.03, side * 1.055), top = at(3.035, side * 1.025);
      const outerLow: Point3 = [end * 6.89, base(end * 6.89) + 1.03, side * 1.223];
      const outerTop: Point3 = [end * 6.64, base(end * 6.64) + 3.00, side * 1.18];
      const points = [edge, outerLow, outerTop, top] as const;
      const flip = end * side > 0;
      add(flip ? pane(points[3], points[2], points[1], points[0]) : pane(...points), white);
      rail(edge, top, .044, white);
      for (const h of [.95, 1.055]) {
        const [x, y, z] = at(h, side * .80, .064);
        add(new THREE.SphereGeometry(.047, 10, 6).scale(.42, 1, .75).translate(x, y, z), '#fff7df', 2.1);
      }
    }
    box(end * 6.50, base(end * 6.50) + 3.14, 0, .31, .095, 2.08, white);
    band(end * 5.82 - .44, end * 5.82 + .44, 3.28, 0, 1.52, .21, '#333b3f');
    if (close) {
      const railX = end * 6.39, railY = base(railX) + 1.76;
      rail([railX, railY, -.94], [railX, railY, .94], .024);
      for (const z of [-.94, .94]) rail([railX, railY - .50, z], [railX, railY, z], .021);
      // Paired lower lamps sit in recessed bezels beside the operator's white roundel.
      for (const z of [-.80, .80]) {
        const [x, y] = at(1, z, .046);
        add(new THREE.SphereGeometry(1, 12, 8).scale(.021, .115, .062).translate(x, y, z), '#4a5153');
      }
      const emblem = at(1.01, end * .39, .048);
      for (const side of [-1, 1]) {
        const loop = new THREE.TorusGeometry(.066, .011, 6, 24).scale(1, .66, 1)
          .rotateZ(.55).rotateY(end * Math.PI / 2).translate(emblem[0], emblem[1] + side * .030, emblem[2] + end * side * .029);
        add(loop, white);
      }
    }
    if (close) {
      const glyph = number === 1 ? [[-.08, .10], [0, .17], [0, -.13], [-.08, -.13], [.075, -.13]]
        : [[-.085, .11], [-.055, .16], [.03, .17], [.079, .13], [.081, .076], [.05, .024], [-.081, -.13], [.091, -.13]];
      for (let i = 1; i < glyph.length; i++) {
        const point = ([u, v]: number[]) => at(2.60 + v, -end * (.71 + u), .014);
        rail(point(glyph[i - 1]), point(glyph[i]), .019, white);
      }
    }
  }
  if (close) {
    for (let i = 0; i < compartments; i++) {
      const x = (i - 1.5) * 3.40, y = base(x) + .90;
      box(x, y - .055, 0, 3.40, .11, 2.31, '#505553');
      if (i > 0) box(x - 1.68, y - .43, 0, .05, .79, 2.31, white);
      // Frosted lower partition, open upper sightline, curved rails and timber perches.
      box(x + 1.58, y + .29, 0, .054, .57, 2.11, '#c6ceca');
      rail([x + 1.57, y + .77, -1.03], [x + 1.57, y + .77, 1.03], .028);
      for (const z of [-.98, .98]) rail([x + 1.57, y + .28, z], [x + 1.57, y + .77, z], .023);
      for (const z of [-.59, .59]) {
        box(x + 1.36, y + .47, z, .29, .055, .69, '#aa8e6e');
        box(x + 1.47, y + .56, z, .05, .16, .69, '#b9a184');
      }
    }
    for (const side of [-1, 1]) band(-6.45, 6.45, 2.97, side * .89, .055, .03, '#f4ebd6', 1.3);
  }
  const g = mergeGeometries(body.concat(windows));
  if (windows.length) {
    const solid = body.reduce((sum, p) => sum + p.index!.count, 0);
    g.addGroup(0, solid, 0); g.addGroup(solid, g.index!.count - solid, 1);
  }
  // The pose applied in funicular.ts is the actual track pitch.
  return g.rotateZ(-Math.atan(grade));
}
