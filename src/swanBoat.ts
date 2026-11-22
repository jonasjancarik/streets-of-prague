import * as THREE from 'three';
import { loftSections, strut, type Point3 } from './vehicleFittings.ts';

type Add = (g: THREE.BufferGeometry, colour: string, glow?: number) => void;
const shell = '#f4f2e9', rubber = '#303334';

// A rectangular patch sampled around the mould. The hull, neck and painted eye
// patches use the same surface positions in both levels of detail.
function surface(rows: number, columns: number, point: (u: number, v: number) => Point3) {
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= columns; j++) {
    positions.push(...point(i / rows, j / columns));
    if (i === rows || j === columns) continue;
    const a = i * (columns + 1) + j, b = a + columns + 1;
    indices.push(a, b, b + 1, a, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

// The Žofín hire boats are moulded tubs with a low entry beside the pedals.
// The stern sweeps up like a tail; there are no separate outboard wings or floats.
export function swanBoat(add: Add, close: boolean) {
  // x, half-beam, height of rubbing strip, gunwale height, half-width of cockpit, inner floor
  const stations = [
    [-1.69, .045, .57, .60, .012, .57], [-1.63, .49, .55, .64, .28, .60],
    [-1.44, .77, .36, .77, .48, .53], [-1.14, .87, .24, .85, .65, .44],
    [-.82, .93, .22, .82, .71, .34], [-.54, .945, .21, .70, .74, .32],
    [-.20, .945, .20, .52, .75, .30], [.18, .93, .20, .39, .75, .27],
    [.45, .91, .20, .42, .71, .28], [.68, .88, .20, .65, .60, .32],
    [.90, .81, .21, .87, .38, .50], [1.15, .68, .22, .88, .17, .74],
    [1.41, .48, .25, .75, .05, .72], [1.61, .23, .29, .59, .025, .58],
    [1.67, .035, .30, .50, .012, .49],
  ];
  const lines = [1, 2, 3, 4, 5].map(k => new THREE.SplineCurve(stations.map(r => new THREE.Vector2(r[0], r[k]))));
  function section(u: number) {
    const [beam, strip, rim, well, floor] = lines.map(line => line.getPoint(u));
    return { x: beam.x, w: beam.y, strip: strip.y, rim: rim.y, well: well.y, floor: floor.y };
  }
  const rows = close ? 48 : 14, rounding = close ? 8 : 3;
  // Keel to sheer, followed by a separate top moulding rolled over the edge
  // and down into the well. The light buff waterline shows below the black seam.
  for (const side of [-1, 1]) {
    add(surface(rows, rounding, (u, v) => {
      const s = section(u), a = (side > 0 ? v : 1 - v) * Math.PI / 2;
      return [s.x, s.strip - .34 * Math.cos(a), side * s.w * Math.sin(a)];
    }), '#e5e0cb');
    add(surface(rows, rounding, (u, v) => {
      const s = section(u), a = (side > 0 ? v : 1 - v) * Math.PI / 2;
      return [s.x, s.strip + (s.rim - s.strip) * Math.sin(a), side * (s.w - (s.w - s.well) * .40 * (1 - Math.cos(a)))];
    }), shell);
    add(surface(rows, rounding, (u, v) => {
      const s = section(u), a = (side > 0 ? v : 1 - v) * Math.PI / 2;
      const lip = s.w * .60 + s.well * .40;
      return [s.x, s.floor + (s.rim - s.floor) * Math.cos(a), side * (lip - (lip - s.well) * Math.sin(a))];
    }), '#ebe9df');
    const path = new THREE.CatmullRomCurve3(stations.map(([x, w, h]) => new THREE.Vector3(x, h, side * w)));
    add(new THREE.TubeGeometry(path, rows, .017, close ? 8 : 4, false), rubber);
  }
  add(surface(rows, 2, (u, v) => {
    const s = section(u);
    return [s.x, s.floor, (1 - 2 * v) * s.well];
  }), '#d8d8cf');
  for (const u of [0, 1]) {
    const s = section(u);
    const end = u === 0 ? -1 : 1;
    // Return the moulding and bumper round the narrow stem and the raised stern.
    const lip = .60 * s.w + .40 * s.well;
    const cap = new THREE.Shape();
    cap.moveTo(-lip, s.rim);
    cap.lineTo(-s.w, s.strip);
    cap.quadraticCurveTo(-s.w, s.strip - .34, 0, s.strip - .34);
    cap.quadraticCurveTo(s.w, s.strip - .34, s.w, s.strip);
    cap.lineTo(lip, s.rim);
    cap.lineTo(s.well, s.floor);
    cap.lineTo(-s.well, s.floor);
    cap.closePath();
    add(new THREE.ShapeGeometry(cap).rotateY(end * Math.PI / 2).translate(s.x, 0, 0), shell);
    add(strut([s.x, s.strip, -s.w], [s.x, s.strip, s.w], .017), rubber);
  }

  // The breast, recurved neck, crown and cheek are one tapered skin. A curl
  // towards the passengers before the forehead turns forward gives the head its profile.
  const rings = [
    [1.02, .47, .46, .49], [1.09, .73, .37, .38], [1.06, 1.00, .25, .235],
    [.91, 1.26, .194, .172], [.70, 1.54, .159, .146], [.61, 1.80, .143, .132],
    [.63, 2.02, .143, .135], [.75, 2.16, .165, .149], [.92, 2.205, .17, .162],
    [1.095, 2.185, .145, .150], [1.22, 2.14, .106, .123], [1.28, 2.13, .074, .094],
  ];
  const spine = new THREE.SplineCurve(rings.map(([x, y]) => new THREE.Vector2(x, y)));
  const radii = new THREE.SplineCurve(rings.map((r) => new THREE.Vector2(r[2], r[3])));
  function skin(u: number, angle: number, offset = 0): Point3 {
    const p = spine.getPoint(u), tangent = spine.getTangent(u), r = radii.getPoint(u);
    const across = (r.x + offset) * Math.sin(angle);
    return [p.x - tangent.y * across, p.y + tangent.x * across, (r.y + offset) * Math.cos(angle)];
  }
  // Sample the crown at the same height in both views for bridge clearance.
  add(surface(44, close ? 28 : 12, (u, v) => skin(u, v * Math.PI * 2)), shell);
  add(loftSections([[1.19, 2.14, .085, .105], [1.29, 2.13, .102, .113], [1.43, 2.09, .081, .088],
  [1.59, 2.04, .047, .052], [1.67, 2.015, .026, .020]], 2.15, close ? 24 : 12), '#eaa424');
  for (const side of [-1, 1]) {
    // Printed black mask follows the cheek all the way to the bill. The eye sits
    // on that surface, not on the centreline where the head would conceal it.
    const theta = (a: number) => side > 0 ? a : Math.PI - a;
    add(surface(close ? 14 : 7, close ? 6 : 3, (u, v) => {
      const t = side > 0 ? v : 1 - v;
      const spread = Math.min(1, u * 6 + .08);
      const bottom = -.13 - spread * (.25 + .75 * Math.exp(-((u - .54) ** 2) / .021));
      return skin(.755 + .245 * u, theta(THREE.MathUtils.lerp(bottom, .23 + .19 * u, t)), .003);
    }), '#24292a');
    const ball = (at: Point3, size: Point3, colour: string) =>
      add(new THREE.SphereGeometry(1, close ? 16 : 10, 8).scale(...size).translate(...at), colour);
    ball(skin(.801, theta(.01), .007), [.046, .047, .012], '#e5e3d9');
    ball(skin(.802, theta(.018), .016), [.027, .031, .010], '#191f21');
    if (close) {
      ball(skin(.805, theta(.094), .025), [.009, .009, .005], '#fffdf3');
      ball([1.326, 2.165, side * .104], [.031, .011, .007], '#655239');
      const p: Point3 = [-1.20, .84, side * .74];
      add(strut([p[0] - .11, p[1] - .035, p[2]], [p[0] - .08, p[1] + .055, p[2]], .014), '#838785');
      add(strut([p[0] - .08, p[1] + .055, p[2]], [p[0] + .09, p[1] + .055, p[2]], .014), '#838785');
      add(strut([p[0] + .09, p[1] + .055, p[2]], [p[0] + .12, p[1] - .035, p[2]], .014), '#838785');
    }
  }
  // Recessed passenger seat spanning the well and an all-round lamp on the stern.
  add(loftSections([[-.97, .68, .145, .45], [-.86, .69, .16, .67], [-.74, .66, .16, .68],
  [-.62, .53, .086, .68], [-.35, .49, .060, .66], [-.24, .49, .048, .59]], 3.5), '#e9e7dd');
  if (close) {
    for (const z of [-.35, .35]) {
      const housing = loftSections([[.02, .35, .05, .055], [.10, .40, .12, .074],
      [.20, .45, .165, .081], [.29, .41, .12, .069], [.39, .33, .05, .045]], 2.5);
      add(housing.translate(0, 0, z), '#d4d2c7');
      add(new THREE.CylinderGeometry(.044, .044, .18, 12).rotateX(Math.PI / 2).translate(.20, .60, z), '#686c67');
      for (const side of [-1, 1]) for (const dx of [-.036, 0, .036]) {
        add(new THREE.BoxGeometry(.009, .008, .066)
          .translate(.20 + side * .11 + dx, .621 + side * .07, z + side * .125), '#575b56');
      }
    }
    add(new THREE.CylinderGeometry(.035, .078, .19, 16).translate(-.21, .399, 0), '#7b807a');
    add(new THREE.CylinderGeometry(.035, .035, .008, 14).translate(.06, .30, -.53), '#91948c');
  }
  add(strut([-1.29, .69, 0], [-1.29, .97, 0], .019), '#777c79');
  add(new THREE.CylinderGeometry(.044, .059, .088, 12).translate(-1.29, 1.005, 0), '#fffae8', 2);
}
