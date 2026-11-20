import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Atlas coordinates are pixels, measured down from the top of furniture-surfaces.webp.
type Swatch = readonly [number, number, number, number];
type Point = [number, number, number];
const plain: Swatch = [470, 445, 471, 446], stone: Swatch = [5, 135, 506, 244], leaf: Swatch = [1, 257, 254, 510];
function finish(g: THREE.BufferGeometry, color: string, patch: Swatch = plain) {
  const part = g.index ? g.toNonIndexed() : g, uv = part.attributes.uv;
  const c = new THREE.Color(color), rgb = new Float32Array(uv.count * 3);
  const [left, top, right, bottom] = patch;
  for (let i = 0; i < uv.count; i++) {
    c.toArray(rgb, i * 3);
    uv.setXY(i, (left + (right - left) * uv.getX(i)) / 512, 1 - (bottom + (top - bottom) * uv.getY(i)) / 512);
  }
  part.setAttribute('color', new THREE.BufferAttribute(rgb, 3)); return part;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, patch?: Swatch) =>
  finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color, patch);
function join(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return merged;
}
// A turned casting; the profile may return down the inside of an open rim.
function spun(profile: [number, number][], sides: number, color: string, patch?: Swatch, flat = false) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), sides).toNonIndexed();
  if (flat) g.computeVertexNormals();
  return finish(g, color, patch);
}
function rod(a: Point, b: Point, r: number, sides: number, color: string, end = r) {
  const start = new THREE.Vector3(...a), delta = new THREE.Vector3(...b).sub(start);
  const g = new THREE.CylinderGeometry(end, r, delta.length(), sides);
  start.addScaledVector(delta, 0.5);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
  return finish(g.translate(start.x, start.y, start.z), color);
}

// Board length runs along X. The bevel catches the light along the slat. Each
// board uses a different strip of grain, with tight sampling across its cut ends.
function slat(w: number, h: number, d: number, tone: string, row: number) {
  const y = h / 2, z = d / 2, b = 0.008, x = w / 2;
  const section = [[y - b, z], [y, z - b], [y, -z + b], [y - b, -z], [-y + b, -z], [-y, -z + b], [-y, z - b], [-y + b, z]];
  const pos: number[] = [], uv: number[] = [];
  const ring = (side: number, i: number) => [side * x, ...section[i % 8]];
  for (let i = 0; i < 8; i++) {
    pos.push(...ring(-1, i), ...ring(1, i + 1), ...ring(-1, i + 1), ...ring(-1, i), ...ring(1, i), ...ring(1, i + 1));
    uv.push(0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1);
  }
  for (const side of [-1, 1]) for (let i = 1; i < 7; i++) {
    const a = side > 0 ? i + 1 : i, b = side > 0 ? i : i + 1;
    pos.push(...ring(side, 0), ...ring(side, a), ...ring(side, b));
    uv.push(.85, .2, .86, .7, .86, .1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
  return finish(g, tone, [2, 2 + row * 14, 510, 28 + row * 14]);
}

function bench() {
  const parts = [], iron = '#394644', bolts = '#929591';
  const colours = ['#a88760', '#96805e', '#af9169', '#a7906b', '#b19470', '#a18460', '#9f8564'];
  for (let i = 0; i < 4; i++) {
    const z = -0.191 + i * 0.124, y = 0.465 - i * 0.006;
    parts.push(slat(1.90, 0.044, 0.112, colours[i], i).translate(0, y, z));
    for (const x of [-0.69, 0.69]) parts.push(rod([x, y + .020, z], [x, y + .025, z], .011, 6, bolts));
  }
  for (let i = 0; i < 3; i++) {
    const y = 0.592 + i * .131, z = 0.20 + i * .033;
    parts.push(slat(1.90, 0.108, 0.037, colours[i + 4], i + 4).rotateX(.245).translate(0, y, z));
    for (const x of [-.69, .69]) parts.push(rod([x, y, z - .015], [x, y + .001, z - .021], .011, 6, bolts));
  }
  for (const x of [-.69, .69]) {
    // Splayed cast legs and the curved arm/seat support, with a bolted shoe at each foot.
    for (const [foot, knee] of [[-.25, -.15], [.26, .15]]) {
      parts.push(box(.11, .035, .10, x, .024, foot, iron), rod([x, .035, foot], [x, .405, knee], .037, 7, iron, .028));
    }
    parts.push(box(.072, .055, .48, x, .401, 0, iron), rod([x, .38, .17], [x, .90, .305], .028, 7, iron, .022));
    const loop: Point[] = [[x, .40, -.17], [x, .53, -.18], [x, .609, -.16], [x, .64, -.11], [x, .65, .12], [x, .62, .21], [x, .58, .229]];
    for (let i = 1; i < loop.length; i++) parts.push(rod(loop[i - 1], loop[i], .018, 6, iron));
  }
  return join(parts);
}

function bin() {
  const parts = [], green = '#43554e', liner = '#565c59';
  parts.push(spun([[0, .035], [.21, .035], [.225, .06], [.225, .12], [.246, .14]], 20, green));
  // The rolled steel rim folds back down the liner; the opening has genuine depth.
  parts.push(spun([[.215, .11], [.251, .74], [.274, .76], [.274, .79], [.262, .805], [.236, .805], [.228, .787], [.225, .755]], 24, green));
  parts.push(spun([[.225, .758], [.202, .29], [.001, .29]], 24, '#353b38'));
  for (const y of [.19, .68]) parts.push(spun([[.241, y], [.256, y + .003], [.256, y + .036], [.24, y + .039]], 24, liner));
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8;
    // Turn the timber grain to run up each stave.
    const board = slat(.53, .021, .071, i % 3 === 0 ? '#86765a' : '#968165', i % 7);
    board.rotateX(Math.PI / 2).rotateZ(Math.PI / 2).rotateX(.05).translate(0, .432, .246).rotateY(a);
    parts.push(board);
  }
  return join(parts);
}

function planter() {
  const pot = spun([[.001, .04], [.70, .04], [.74, .10], [.88, .48], [.90, .49], [.90, .545], [.84, .55], [.80, .535], [.77, .445]], 4, '#b5aaa0', stone, true).rotateY(Math.PI / 4);
  const parts = [pot, box(1.11, .035, 1.11, 0, .474, 0, '#514337', stone)];
  // Three low shrubs. Each radial spray has its stem in the soil and foliage on both
  // sides. The upper sprays lean out over the lower ones, so one can also look down in.
  for (const [x, z, h, a] of [[-.26, -.16, .55, .6], [.25, -.08, .64, 2.7], [-.04, .25, .49, 4.3]]) {
    parts.push(rod([x, .47, z], [x + .02, .47 + h * .72, z], .024, 6, '#685847', .008));
    for (let i = 0; i < 11; i++) {
      const theta = a + i * 2.4, t = i / 11, size = h * (1.04 - .44 * t);
      const card = new THREE.PlaneGeometry(size * .83, size, 1, 2);
      const v = card.attributes.position;
      for (let j = 0; j < v.count; j++) {
        const u = card.attributes.uv.getY(j);
        v.setXYZ(j, v.getX(j), u * size * .76, (.29 + .22 * (1 - t)) * size * u + .045 * Math.sin(u * Math.PI));
      }
      card.rotateY(theta).translate(x, .477 + t * h * .47, z);
      // Broadleaf cutouts retain soft canopy normals instead of dark, edge-on sheets.
      const normals = card.attributes.normal;
      for (let j = 0; j < normals.count; j++) normals.setXYZ(j, Math.sin(theta) * .51, .86, Math.cos(theta) * .51);
      parts.push(finish(card, i % 3 === 0 ? '#e4e6bc' : '#d5d9b0', leaf));
    }
  }
  return join(parts);
}

function hydrant() {
  const red = '#a13c2b', joint = '#56443c';
  const parts = [spun([[.001, .02], [.151, .02], [.151, .055], [.14, .068], [.114, .08], [.113, .16], [.095, .22], [.09, .53], [.102, .60], [.119, .62], [.119, .65], [.108, .66], [.108, .71], [.095, .747], [.053, .77], [.001, .773]], 16, red)];
  parts.push(spun([[.117, .146], [.128, .152], [.128, .173], [.112, .181]], 16, joint), rod([0, .759, 0], [0, .808, 0], .037, 6, '#7b6050'));
  for (const s of [-1, 1]) {
    parts.push(rod([s * .077, .525, 0], [s * .145, .549, 0], .073, 12, red),
      rod([s * .145, .549, 0], [s * .169, .556, 0], .08, 12, '#7d7768'), rod([s * .168, .556, 0], [s * .18, .558, 0], .056, 8, '#aaa391'));
    const p: Point[] = [[s * .169, .529, .035], [s * .163, .47, .052], [s * .127, .431, .065], [s * .095, .455, .071], [s * .086, .519, .062]];
    for (let i = 1; i < p.length; i++) parts.push(rod(p[i - 1], p[i], .005, 5, joint));
  }
  for (let i = 0; i < 4; i++) {
    const x = Math.cos(i * Math.PI / 2 + .78) * .125, z = Math.sin(i * Math.PI / 2 + .78) * .125;
    parts.push(rod([x, .054, z], [x, .069, z], .013, 6, joint));
  }
  return join(parts);
}

function kiosk() {
  const foot = '#737675', metal = '#b5b9b6', gasket = '#475152';
  const parts = [box(.91, .066, .92, 0, .042, 0, foot), box(.94, .055, .94, 0, 2.105, 0, gasket),
  box(.94, .148, .94, 0, 2.20, 0, '#c9a343'), box(.948, .036, .948, 0, 2.286, 0, '#d2d1bf')];
  const title: Swatch = [265, 262, 507, 312], keys: Swatch = [265, 328, 425, 500];
  for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) parts.push(finish(new THREE.PlaneGeometry(.615, .133).translate(0, 2.2, .472).rotateY(angle), '#ffffff', title));
  for (const x of [-.426, .426]) for (const z of [-.426, .426]) {
    parts.push(box(.047, 2.07, .047, x, 1.076, z, metal), box(.074, .15, .074, x, .106, z, gasket));
  }
  const panes: THREE.BufferGeometry[] = [];
  for (const angle of [Math.PI, Math.PI / 2, -Math.PI / 2]) {
    for (const y of [.235, 1.026, 2.046]) parts.push(box(.82, .041, .037, 0, y, .427, metal).rotateY(angle));
    parts.push(box(.808, .128, .027, 0, .151, .427, gasket).rotateY(angle));
    panes.push(new THREE.PlaneGeometry(.802, 1.78).translate(0, 1.141, .428).rotateY(angle));
    for (let i = -2; i <= 2; i++) parts.push(box(.063, .012, .008, i * .145, 1.494, .431, '#bfc8c1').rotateY(angle));
  }
  // Back board, payphone cabinet, recessed keypad and handset on a coiled tether.
  parts.push(box(.514, .89, .043, 0, 1.31, -.395, metal), box(.366, .574, .137, 0, 1.374, -.31, '#666f71'),
    box(.37, .031, .194, 0, 1.079, -.28, gasket), box(.27, .06, .095, .035, 1.205, -.22, '#596062'),
    finish(new THREE.PlaneGeometry(.181, .230).translate(.054, 1.473, -.239), '#fff', keys),
    box(.105, .014, .015, .051, 1.294, -.232, '#30383b'));
  const hand: Point[] = [[-.136, 1.59, -.206], [-.131, 1.55, -.176], [-.137, 1.404, -.168], [-.134, 1.38, -.194]];
  for (let i = 1; i < hand.length; i++) parts.push(rod(hand[i - 1], hand[i], .019, 8, '#303c3c'));
  for (const y of [1.38, 1.589]) parts.push(box(.058, .057, .057, -.136, y, -.194, '#354042'));
  const cord: Point[] = [[-.138, 1.356, -.193], [-.155, 1.16, -.182], [-.124, 1.084, -.18], [-.090, 1.116, -.197], [-.076, 1.215, -.23]];
  for (let i = 1; i < cord.length; i++) parts.push(rod(cord[i - 1], cord[i], .005, 5, gasket));
  return { body: join(parts), glass: join(panes) };
}
export function furnitureModels() {
  const phone = kiosk();
  return { bodies: [bench(), bin(), planter(), hydrant(), phone.body], glass: phone.glass };
}
