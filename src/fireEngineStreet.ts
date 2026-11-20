// The close Prague water tender. +x is the nose, +z the passenger side, metres.
import * as THREE from 'three';

type Point = [number, number, number];
type Add = (g: THREE.BufferGeometry, colour: string, x: number, y: number, z: number) => void;
type Builder = {
  add: Add;
  box: (colour: string, x0: number, x1: number, y0: number, y1: number, width: number, z?: number) => void;
  rounded: (colour: string, x0: number, x1: number, y0: number, y1: number, width: number, radius: number, bevel?: number, z?: number) => void;
};
type Rect = [number, number, number, number];
const red = '#c4161c', white = '#efefe7', rubber = '#24282a', steel = '#999f9d', alloy = '#bdc4c3';
const shutter: Rect = [2, 2, 508, 252], tread: Rect = [2, 258, 508, 508], plate: Rect = [510, 388, 794, 454];
const frontWord: Rect = [514, 2, 1022, 84], doorWord: Rect = [514, 90, 1022, 162];
const chevrons: Rect = [514, 170, 1022, 254], gauges: Rect = [513, 260, 828, 382];

export function fireEngineStreet({ add, box, rounded }: Builder) {
  function quad(colour: string, a: Point, b: Point, c: Point, d: Point, print?: Rect, glass = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    if (print) {
      const [l, t, r, b] = print.map((p, i) => i % 2 ? 1 - p / 512 : p / 1024);
      g.setAttribute('uv', new THREE.Float32BufferAttribute([l, b, r, b, r, t, l, t], 2));
      g.userData.printed = true;
    }
    g.userData.cabWindow = glass;
    add(g, colour, 0, 0, 0);
  }
  function tube(colour: string, radius: number, a: Point, b: Point, segments = 10, tip = radius) {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), axis = to.clone().sub(from);
    const g = new THREE.CylinderGeometry(tip, radius, axis.length(), segments);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
    from.lerp(to, .5);
    add(g, colour, from.x, from.y, from.z);
  }
  const endFace = (x: number, z: number, y: number, width: number, height: number, print: Rect) => {
    const dz = Math.sign(x) * width / 2;
    quad('#ffffff', [x, y, z + dz], [x, y, z - dz], [x, y + height, z - dz], [x, y + height, z + dz], print);
  };
  const deck = (x0: number, x1: number, y: number, w: number, z = 0) =>
    quad('#ffffff', [x0, y, z + w / 2], [x1, y, z + w / 2], [x1, y, z - w / 2], [x0, y, z - w / 2], tread);
  function skirt(x0: number, x1: number, axle: number, high: number, s: number, z: number) {
    const shape = new THREE.Shape();
    shape.moveTo(x0, .49); shape.lineTo(axle - .59, .49);
    shape.absarc(axle, .49, .59, Math.PI, 0, true);
    shape.lineTo(x1, .49); shape.lineTo(x1, high); shape.lineTo(x0, high); shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: .065, bevelEnabled: false, curveSegments: 13 });
    add(g, red, 0, 0, s * z - (s > 0 ? .065 : 0));
    const points: Point[] = [];
    for (let i = 0; i <= 18; i++) {
      const a = Math.PI * i / 18;
      points.push([axle + .60 * Math.cos(a), .49 + .60 * Math.sin(a), s * (z + .006)]);
    }
    const lip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), 18, .037, 6, false);
    add(lip, rubber, 0, 0, 0);
  }
  box('#313636', -4.13, 4.14, .32, .68, 1.68);
  for (const axle of [2.76, -1.72]) for (const side of [-1, 1]) {
    const y = .515, outer = 1.225;
    // Cross section of the tyre and pressed rim, measured inward from its outer face.
    const revolve = (colour: string, section: number[][]) => {
      const profile = section.map(([r, inset]) => new THREE.Vector2(r, -inset));
      const g = new THREE.LatheGeometry(profile, 36).rotateX(side * Math.PI / 2);
      add(g, colour, axle, y, side * outer);
    };
    revolve('#26282a', [[.298, .285], [.398, .30], [.484, .274], [.515, .227], [.515, .066],
    [.498, .030], [.464, .011], [.39, 0], [.319, .005], [.295, .022]]);
    revolve('#444849', [[.431, .004], [.437, .001], [.444, .004]]);
    revolve(alloy, [[.298, .030], [.308, .002], [.298, -.014], [.272, -.009], [.258, .033],
    [.21, .054], [.158, .037], [.125, .012]]);
    const disc = (r: number, x: number, height: number, inset: number, c: string, n = 12) =>
      add(new THREE.CircleGeometry(r, n).rotateY(side < 0 ? Math.PI : 0), c, x, height, side * (outer - inset));
    disc(.19, axle, y, .035, '#9ba1a0', 32);
    tube('#767f80', .106, [axle, y, side * (outer - .035)], [axle, y, side * (outer + .024)], 16, .089);
    for (let i = 0; i < 10; i++) {
      const a = 2 * Math.PI * i / 10, dx = Math.cos(a), dy = Math.sin(a);
      disc(.030, axle + dx * .226, y + dy * .226, .029, '#343a3a');
      disc(.018, axle + dx * .139, y + dy * .139, .016, '#575e5e', 6);
    }
  }
  rounded(red, -4.22, 1.03, 1.10, 2.94, 2.46, .09, .04);
  rounded(red, 1.12, 4.23, 1.10, 1.78, 2.46, .18, .06);
  box('#31383b', 1.19, 3.99, 1.71, 1.78, 2.18);
  rounded(red, 1.14, 3.99, 2.89, 3.055, 2.40, .18, .055);
  box(red, 1.14, 1.25, 1.74, 2.94, 2.32);
  rounded('#363c3d', 3.63, 4.18, 1.75, 1.91, 2.10, .12, .035);
  // Gently bowed screen. The gasket follows the same four edges as the glass.
  const screen = (u: number, v: number): Point =>
    [4.206 - .247 * v - .12 * u * u, 1.815 + 1.055 * v + .026 * u * u, 1.102 * u * (1 - .035 * v)];
  for (let i = 0; i < 16; i++) {
    const u = 1 - i / 8, v = u - .125;
    quad('#42555d', screen(u, 0), screen(v, 0), screen(v, 1), screen(u, 1), undefined, true);
    for (const h of [0, 1]) tube(rubber, .032, screen(u, h), screen(v, h), 6);
  }
  for (const s of [-1, 1]) {
    const z = s * 1.199;
    skirt(-4.18, 1.00, -1.72, 1.22, s, 1.22);
    skirt(1.19, 4.10, 2.76, 1.24, s, 1.19);
    tube(red, .086, screen(s, 0), screen(s, 1), 12);
    const sidePane = (back: number, frontLow: number, frontHigh: number) => {
      const a: Point = [back, 1.84, z], b: Point = [frontLow, 1.84, z], c: Point = [frontHigh, 2.855, z * .974], d: Point = [back, 2.855, z * .974];
      if (s > 0) quad('#42555d', a, b, c, d, undefined, true);
      else quad('#42555d', b, a, d, c, undefined, true);
      for (const [p, q] of [[a, b], [b, c], [c, d], [d, a]]) tube(rubber, .026, p, q, 6);
    };
    sidePane(1.32, 2.42, 2.42); sidePane(2.56, 4.075, 3.82);
    box(red, 2.44, 2.55, 1.76, 2.92, .085, z * .984);
    box(red, 1.20, 1.32, 1.76, 2.92, .095, z * .984);
    tube(red, .095, [4.075, 1.80, z], [3.82, 2.90, z * .973]);
    // A front and rear seat with a head restraint, visible through opposite panes.
    for (const x of [1.61, 2.87]) {
      rounded('#41494b', x - .20, x + .27, 1.72, 1.86, .57, .07, .045, s * .56);
      rounded('#373e40', x - .20, x - .07, 1.78, 2.28, .56, .06, .036, s * .56);
      rounded('#454d4d', x - .18, x - .045, 2.23, 2.44, .31, .05, .038, s * .56);
    }
    tube(rubber, .021, [4.19, 1.86, s * .56], [4.172, 1.92, s * .77]);
    tube(rubber, .018, [4.16, 1.94, s * .86], [4.17, 2.02, s * .13]);
    for (const x of [1.28, 2.49, 3.95]) box('#7f1920', x, x + .014, 1.09, 1.76, .012, s * 1.233);
    box(white, 1.18, 4.05, 1.31, 1.56, .018, s * 1.234);
    const a = 2.61, b = 3.79, face = s * 1.246;
    quad('#ffffff', [s > 0 ? a : b, 1.32, face], [s > 0 ? b : a, 1.32, face], [s > 0 ? b : a, 1.55, face], [s > 0 ? a : b, 1.55, face], doorWord);
    for (const x of [1.38, 2.63]) rounded(rubber, x, x + .18, 1.605, 1.665, .035, .018, .008, s * 1.236);
    for (const x of [1.53, 3.63]) {
      box(rubber, x - .28, x + .27, .39, .49, .26, s * 1.14);
      deck(x - .28, x + .27, .492, .26, s * 1.14);
    }
    tube('#323739', .035, [3.76, 2.72, s * 1.16], [3.87, 2.71, s * 1.43]);
    tube('#323739', .03, [3.87, 2.71, s * 1.43], [3.87, 2.16, s * 1.43]);
    rounded(rubber, 3.80, 3.97, 2.13, 2.57, .19, .058, .035, s * 1.42);
    box('#85969a', 3.795, 3.805, 2.18, 2.52, .145, s * 1.42);

    for (const [x0, x1, low] of [[-4.10, -2.57, 1.15], [-2.49, -.93, 1.16], [-.85, .90, .67]]) {
      const frame = s * 1.235, skin = s * 1.251;
      box(rubber, x0, x1, low, 2.72, .024, frame);
      const l = s > 0 ? x0 + .046 : x1 - .046, r = s > 0 ? x1 - .046 : x0 + .046;
      quad('#ffffff', [l, low + .05, skin], [r, low + .05, skin], [r, 2.68, skin], [l, 2.68, skin], shutter);
      box(alloy, x0 + .035, x1 - .035, low + .03, low + .095, .045, skin);
      const mid = (x0 + x1) / 2;
      box(rubber, mid - .145, mid + .145, low + .12, low + .20, .040, skin);
      tube(steel, .021, [mid - .112, low + .165, skin + s * .024], [mid + .112, low + .165, skin + s * .024]);
      box(steel, x0 - .014, x0 + .012, low, 2.74, .027, skin);
    }
    // The side outlet is also where the deployed brigade hose starts.
    const px = -3.70;
    box('#434b4d', px - .32, px + .32, .71, 1.14, .024, s * 1.227);
    tube(alloy, .13, [px, .97, s * 1.227], [px, .97, s * 1.275], 12);
    tube('#535a5b', .085, [px, .97, s * 1.276], [px, .97, s * 1.288], 10);
    for (const x of [-3.18, -.56, .70]) box('#dc9b43', x, x + .085, .63, .675, .028, s * 1.235);
    box('#e1da83', -4.10, .94, 2.77, 2.818, .025, s * 1.225);
    box('#747d7d', -4.10, .95, 2.94, 3.00, .08, s * 1.16);
    for (const x of [-3.91, -1.71, .78]) tube(steel, .023, [x, 2.98, s * 1.16], [x, 3.15, s * 1.16]);
    tube(alloy, .026, [-4.02, 3.15, s * 1.16], [.90, 3.15, s * 1.16]);
  }
  add(new THREE.TorusGeometry(.20, .023, 8, 24).rotateY(Math.PI / 2 - .42), rubber, 3.58, 2.02, -.57);
  tube('#363d40', .052, [3.83, 1.75, -.57], [3.58, 2.02, -.57]);
  rounded(red, 3.93, 4.226, .84, 1.23, 2.29, .115, .032);
  rounded(white, 3.94, 4.30, .44, .94, 2.47, .16, .05);
  rounded(white, 4.085, 4.244, 1.27, 1.61, 2.18, .06, .026);
  endFace(4.246, 0, 1.295, 1.52, .28, frontWord);
  box(rubber, 4.189, 4.245, .88, 1.255, 1.54);
  for (let j = 0; j < 4; j++) {
    const w = 1.22 + j * .095;
    rounded('#555d5d', 4.235, 4.268, .908 + j * .085, .939 + j * .085, w, .022, .008);
  }
  box(rubber, 4.296, 4.31, .484, .514, 1.17);
  for (const z of [-.47, .47]) box('#899192', 4.293, 4.303, .525, .58, .10, z);
  for (const s of [-1, 1]) {
    rounded('#353b3e', 4.225, 4.31, .565, .845, .56, .045, .021, s * .86);
    for (const [z, r] of [[.75, .092], [.945, .079]]) {
      // Reflector bowl, luminous projector and the clear cover over the cluster.
      const optic = new THREE.LatheGeometry([
        new THREE.Vector2(.012, 0), new THREE.Vector2(r * .52, .004),
        new THREE.Vector2(r * .83, .018), new THREE.Vector2(r, .027),
        new THREE.Vector2(r + .01, .024)
      ], 20).rotateZ(-Math.PI / 2);
      add(optic, alloy, 4.30, .71, s * z);
      tube('#fff6d8', r * .51, [4.307, .71, s * z], [4.319, .71, s * z], 20, r * .46);
    }
    const pane = new THREE.BoxGeometry(.009, .244, .493);
    pane.userData.cabWindow = true;
    add(pane, '#76868b', 4.331, .707, s * .86);
    box('#c48137', 4.30, 4.32, .585, .613, .32, s * .87);
    rounded(rubber, 3.54, 3.86, 3.05, 3.20, .32, .055, .025, s * .65);
    rounded('#214c85', 3.53, 3.87, 3.204, 3.39, .73, .065, .035, s * .62);
    rounded(rubber, -3.98, -3.62, 2.95, 3.29, .37, .04, .012, s * 1.0);
    rounded('#285891', -3.95, -3.65, 3.285, 3.395, .31, .052, .025, s * 1.0);
  }
  box('#51595b', 3.56, 3.84, 3.18, 3.25, 1.83);
  endFace(4.303, 0, .54, .52, .112, plate);

  deck(-4.10, .98, 2.95, 2.30);
  for (const z of [.43, .91]) for (const h of [3.035, 3.145])
    box(alloy, -3.80, .68, h, h + .052, .045, z);
  for (let x = -3.71; x < .67; x += .30) tube(steel, .022, [x, 3.085, .44], [x, 3.085, .90]);
  for (const z of [-.61, -.88]) {
    tube('#3a4242', .089, [-3.55, 3.047, z], [.43, 3.047, z], 16);
    for (const x of [-3.55, -2.25, -.62, .32]) tube(alloy, .098, [x, 3.047, z], [x + .095, 3.047, z], 12);
  }
  rounded(steel, -3.75, -2.55, 2.98, 3.24, .58, .055, .026, -.06);
  tube('#7d8380', .145, [.96, 2.95, 0], [.96, 3.2, 0]);
  tube(red, .126, [.96, 3.19, 0], [1.39, 3.2, 0]);
  tube('#515a5c', .118, [1.36, 3.20, 0], [1.70, 3.20, 0], 14, .076);

  // Rear working bay, flanked by upright combination lamps and a fold-down step.
  box(rubber, -4.24, -4.17, .76, 2.77, 1.87);
  endFace(-4.247, 0, 1.68, 1.78, 1.035, shutter);
  box(steel, -4.27, -4.21, 1.64, 1.70, 1.80);
  box('#667072', -4.25, -4.20, .83, 1.61, 1.78);
  endFace(-4.258, 0, 1.21, 1.13, .395, gauges);
  for (const s of [-1, 1]) {
    tube('#949d9b', .151, [-4.248, 1.03, s * .52], [-4.317, 1.03, s * .52], 12);
    tube('#333b3c', .108, [-4.318, 1.03, s * .52], [-4.33, 1.03, s * .52], 12);
    box(rubber, -4.246, -4.18, .62, 1.51, .215, s * 1.055);
    for (const [y, c] of [[.72, '#b3161b'], [.91, '#c88237'], [1.10, '#b3161b']] as const)
      box(c, -4.261, -4.239, y, y + .14, .17, s * 1.055);
    tube(alloy, .028, [-4.29, 1.72, s * 1.063], [-4.29, 2.61, s * 1.063]);
  }
  rounded('#5c6565', -4.37, -4.03, .38, .55, 2.33, .065, .02);
  deck(-4.37, -4.24, .555, 2.21);
  endFace(-4.246, 0, 2.79, 2.24, .13, chevrons);
  endFace(-4.374, 0, .405, 2.14, .12, chevrons);
  endFace(-4.266, 0, .675, .52, .112, plate);
}
