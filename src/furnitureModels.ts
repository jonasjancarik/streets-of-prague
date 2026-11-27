import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Atlas coordinates are pixels, measured down from the top of furniture-surfaces.webp.
type Swatch = readonly [number, number, number, number];
type Point = [number, number, number];
const plain: Swatch = [470, 445, 471, 446], stone: Swatch = [5, 135, 506, 244], leaf: Swatch = [1, 257, 254, 510];
let atlas: THREE.Texture | undefined;
export function furnitureAtlas() {
  if (!atlas) {
    atlas = new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'furniture-surfaces.webp');
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.anisotropy = 4;
  }
  return atlas;
}
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
export const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string, patch?: Swatch) =>
  finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color, patch);
export function join(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return merged;
}
// A turned casting; the profile may return down the inside of an open rim.
export function spun(profile: [number, number][], sides: number, color: string, patch?: Swatch, flat = false) {
  const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), sides).toNonIndexed();
  if (flat) g.computeVertexNormals();
  return finish(g, color, patch);
}
export function rod(a: Point, b: Point, r: number, sides: number, color: string, end = r) {
  const start = new THREE.Vector3(...a), delta = new THREE.Vector3(...b).sub(start);
  const g = new THREE.CylinderGeometry(end, r, delta.length(), sides);
  start.addScaledVector(delta, 0.5);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
  return finish(g.translate(start.x, start.y, start.z), color);
}

// Board length runs along X. The bevel catches the light along the slat. Each
// board uses a different strip of grain, with tight sampling across its cut ends.
export function slat(w: number, h: number, d: number, tone: string, row: number) {
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

// The mapped street furniture (MAPPED in map/furniture.ts). Each model's local x runs
// along its street and its +z faces the street.

// Prague's galvanised inverted U, set across the kerb so a bike leans along it.
function bikeStand() {
  const steel = '#a7aca9', parts: THREE.BufferGeometry[] = [];
  const r = .024, half = .36, top = .74, bend = .12;
  for (const z of [-half, half]) parts.push(rod([0, 0, z], [0, top - bend, z], r, 8, steel), rod([0, -.01, z], [0, .01, z], .045, 8, '#7c807d'));
  const arc: Point[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * i / 8;
    arc.push([0, top - bend + Math.sin(a) * bend, -Math.cos(a) * half]);
  }
  for (let i = 1; i < arc.length; i++) parts.push(rod(arc[i - 1], arc[i], r, 8, steel));
  // A low cross bar to lock a wheel to.
  parts.push(rod([0, .30, -half], [0, .30, half], .018, 6, steel));
  return join(parts);
}

// The city's pay-and-display machine: a grey cabinet on a plinth, its screen and slots on
// the pavement side, under a blue P sign.
function parkingMachine() {
  const grey = '#8b9194', dark = '#22272a', blue = '#1f4f9c', white = '#eef1f2';
  const parts = [box(.36, .09, .26, 0, .045, 0, '#5d6264'), box(.42, 1.12, .3, 0, .65, 0, grey), box(.44, .05, .32, 0, 1.235, 0, '#6f7578')];
  parts.push(box(.22, .16, .01, 0, .98, -.155, dark), box(.30, .05, .02, 0, .82, -.155, '#3a4043'), box(.08, .03, .02, .08, .70, -.155, dark),
    box(.14, .26, .02, 0, .40, -.155, '#7a8083'));
  // The sign: a white P on blue, on both faces.
  parts.push(rod([0, 1.26, 0], [0, 1.42, 0], .025, 6, '#6f7578'), box(.34, .34, .03, 0, 1.58, 0, blue));
  for (const z of [-.017, .017]) {
    parts.push(box(.045, .24, .004, -.05, 1.58, z, white), box(.12, .04, .004, .0, 1.68, z, white),
      box(.12, .04, .004, .0, 1.58, z, white), box(.04, .14, .004, .06, 1.63, z, white));
  }
  return join(parts);
}

// The cast-iron Prague bollard (pražský sloupek): a dark fluted post with a collar and a
// rounded cap.
function bollard() {
  const iron = '#2d3130';
  const g = spun([[.001, 0], [.105, 0], [.105, .05], [.088, .07], [.078, .12], [.07, .62], [.086, .64], [.09, .68], [.076, .70],
    [.072, .78], [.06, .84], [.036, .875], [.001, .885]], 12, iron, undefined, true);
  return join([g, spun([[.074, .30], [.082, .31], [.082, .34], [.072, .35]], 12, '#3a3f3d')]);
}

// The orange Česká pošta box on a grey post, its slot facing the pavement.
function postBox() {
  const orange = '#e7862a', post = '#6b6f6e', dark = '#2a2423';
  const parts = [rod([0, 0, 0], [0, .92, 0], .03, 8, post), box(.34, .44, .22, 0, 1.12, 0, orange)];
  // A roof sloping to the back sheds rain; the slot has a hood, the front the post's horn
  // and a white collection-times card.
  parts.push(box(.37, .03, .26, 0, 0, 0, orange).rotateX(.18).translate(0, 1.36, .01),
    box(.2, .022, .01, 0, 1.24, -.115, dark), box(.24, .018, .04, 0, 1.262, -.128, orange),
    box(.10, .07, .006, 0, 1.06, -.113, '#24459a'), box(.16, .05, .006, 0, .96, -.113, '#f2ede4'));
  return join(parts);
}

// The same box hung on a house wall at local -z, its slot facing out (+z).
function wallPostBox() {
  const orange = '#e7862a', dark = '#2a2423';
  return join([box(.30, .08, .04, 0, 1.12, -.11, '#5a5e5d'), box(.34, .44, .22, 0, 1.12, 0, orange),
    box(.37, .03, .26, 0, 0, 0, orange).rotateX(-.18).translate(0, 1.36, -.01),
    box(.2, .022, .01, 0, 1.24, .115, dark), box(.24, .018, .04, 0, 1.262, .128, orange),
    box(.10, .07, .006, 0, 1.06, .113, '#24459a'), box(.16, .05, .006, 0, .96, .113, '#f2ede4')]);
}

// A Stolperstein: a 10 cm brass plate on its cobble, its top level with the paving (the
// furniture stands 4 cm down: furnitureMatrices).
function stolperstein() {
  return join([box(.096, .03, .096, 0, .03, 0, '#c19a45'), box(.1, .006, .1, 0, .0455, 0, '#d8b25a')]);
}

// A street cabinet of the power or signal people: grey steel, two doors, on a concrete foot.
function cabinet() {
  const steel = '#9a9b94', seam = '#5f625d';
  const parts = [box(.84, .12, .38, 0, .06, 0, '#8e8b84'), box(.8, 1.1, .34, 0, .67, 0, steel), box(.86, .04, .4, 0, 1.24, 0, '#86877f')];
  for (const s of [-1, 1]) parts.push(box(.01, 1.0, .012, 0, .67, s * .171, seam), box(.03, .09, .02, s * .06, .78, s * .175, '#3b3d3a'));
  for (let i = 0; i < 4; i++) parts.push(box(.3, .012, .01, -.2, 1.0 + i * .04, -.172, seam), box(.3, .012, .01, -.2, 1.0 + i * .04, .172, seam));
  return join(parts);
}

// The round advertising column (reklamní sloup): a green cast foot and crown, and a drum
// of posters between, each in its own faded colours.
function advertisingColumn() {
  const green = '#2f4a3c', posters = ['#c9b48a', '#a3402f', '#e2ddcf', '#2f5d86', '#d8a531', '#55734f', '#c96b8c', '#efe8d8', '#7a3b2e', '#4a4a52'];
  const parts = [spun([[.001, 0], [.66, 0], [.66, .1], [.6, .16], [.58, .42], [.62, .46], [.001, .46]], 24, green, undefined, true)];
  for (let i = 0; i < 12; i++) {
    const a0 = i * Math.PI / 6, a1 = (i + 1) * Math.PI / 6, r = .57, low = .46 + (i % 3) * .02, high = 2.62 - (i % 2) * .05;
    const g = new THREE.CylinderGeometry(r, r, high - low, 3, 1, true, a0, a1 - a0).translate(0, (low + high) / 2, 0);
    parts.push(finish(g, posters[(i * 7) % posters.length]));
    const top = new THREE.CylinderGeometry(r, r, .9, 3, 1, true, a0, (a1 - a0) / 2).translate(0, 1.95, 0);
    parts.push(finish(top.scale(1.004, 1, 1.004), posters[(i * 3 + 4) % posters.length]));
  }
  parts.push(spun([[.001, 2.6], [.6, 2.6], [.66, 2.66], [.7, 2.72], [.66, 2.78], [.5, 2.95], [.28, 3.1], [.1, 3.22], [.05, 3.42], [.08, 3.5], [.001, 3.56]], 24, green, undefined, true));
  return join(parts);
}

// A poster case on the pavement: an aluminium frame on two legs, a poster behind glass on
// either face.
function posterCase() {
  const frame = '#5d6365', parts = [box(1.24, 1.84, .12, 0, 1.18, 0, frame)];
  for (const z of [-.061, .061]) parts.push(box(1.12, 1.7, .004, 0, 1.18, z, z > 0 ? '#d7c59a' : '#7d9db5'), box(.9, .3, .004, 0, 1.6, z * 1.02, '#a8452f'));
  for (const x of [-.5, .5]) parts.push(box(.08, .3, .08, x, .14, 0, frame), box(.2, .03, .2, x, .015, 0, '#45494a'));
  return join(parts);
}

// The cast-iron grate round a street tree: a square frame, two rings of bars round the
// trunk's hole, level with the paving (the furniture stands 4 cm down).
function treeGrate() {
  const iron = '#2b2d2b', parts: THREE.BufferGeometry[] = [], y = .035;
  for (const s of [-1, 1]) parts.push(box(1.2, .03, .06, 0, y, s * .57, iron), box(.06, .03, 1.2, s * .57, y, 0, iron));
  for (const r of [.3, .45]) for (const s of [-1, 1]) parts.push(box(r * 2, .03, .03, 0, y, s * r, iron), box(.03, .03, r * 2, s * r, y, 0, iron));
  for (let i = 0; i < 16; i++) {
    const a = i * Math.PI / 8, c = Math.cos(a), sn = Math.sin(a), lo = .22 / Math.max(Math.abs(c), Math.abs(sn)), hi = .56 / Math.max(Math.abs(c), Math.abs(sn));
    parts.push(rod([c * lo, y, sn * lo], [c * hi, y, sn * hi], .012, 4, iron));
  }
  return join(parts);
}

// Traffic signs on a grey post, their face towards local +z and a grey back.
function signPost(face: THREE.BufferGeometry[], y: number) {
  const back = new THREE.CircleGeometry(.3, 20).rotateY(Math.PI).translate(0, y, .02);
  return join([rod([0, 0, 0], [0, y + .35, 0], .03, 8, '#8e9394'), finish(back, '#9a9d9c'), ...face]);
}
// No entry (B2 in the Czech rules): a red disc with a white bar.
function noEntrySign() {
  const y = 2.25;
  return signPost([finish(new THREE.CircleGeometry(.3, 24).translate(0, y, .035), '#c4271f'),
    finish(new THREE.CircleGeometry(.315, 24).translate(0, y, .032), '#f2f0ea'), box(.42, .085, .01, 0, y, .042, '#f4f2ec')], y);
}
// One way (IP4b): a blue square with a white arrow pointing up.
function oneWaySign() {
  const y = 2.2, arrow = new THREE.Shape([new THREE.Vector2(-.13, -.02), new THREE.Vector2(0, .17), new THREE.Vector2(.13, -.02)]);
  return signPost([box(.5, .5, .02, 0, y, .03, '#1f4fa0'), box(.07, .26, .01, 0, y - .1, .045, '#f4f2ec'),
    finish(new THREE.ShapeGeometry(arrow).translate(0, y, .046), '#f4f2ec')], y);
}

// A drinking fountain (pítko): a dark steel post with a basin and a push tap.
function drinkingFountain() {
  const dark = '#3a3f3f';
  return join([spun([[.001, 0], [.2, 0], [.2, .04], [.13, .06], [.12, .86], [.001, .86]], 16, dark, undefined, true),
    spun([[.001, .82], [.2, .82], [.24, .9], [.22, .93], [.17, .88], [.001, .88]], 18, '#6e7372'),
    rod([0, .86, 0], [0, 1.02, 0], .03, 8, dark), rod([0, 1.02, 0], [.08, 1.02, 0], .016, 6, '#8d9291'),
    box(.05, .03, .05, 0, 1.05, 0, '#b9bdbc')]);
}

// A glass bell: a round fibreglass dome with two openings and a lifting hook.
function glassBell(color: string) {
  const g = spun([[.001, .05], [.62, .05], [.66, .12], [.68, .55], [.66, .95], [.58, 1.22], [.42, 1.42], [.2, 1.52], [.001, 1.545]], 20, color, undefined, false);
  const parts = [g, rod([0, 1.53, 0], [0, 1.72, 0], .03, 6, '#5c625f')];
  // Ring for the crane's hook.
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, b = (i + 1) * Math.PI / 4;
    parts.push(rod([Math.cos(a) * .09, 1.80 + Math.sin(a) * .09, 0], [Math.cos(b) * .09, 1.80 + Math.sin(b) * .09, 0], .018, 5, '#5c625f'));
  }
  for (const a of [Math.PI / 2, -Math.PI / 2]) {
    const disc = new THREE.CircleGeometry(.11, 14);
    const at = new THREE.Vector3(Math.sin(a) * .675, 1.02, Math.cos(a) * .675);
    disc.lookAt(at.clone().setY(0).normalize()).translate(at.x, at.y, at.z);
    parts.push(finish(disc, '#151816'), box(.30, .06, .06, at.x * .99, 1.17, at.z * .99, color).rotateY(a));
  }
  return join(parts);
}

// A 1100 l steel container on four castors with a domed plastic lid.
function container(color: string) {
  const body = color, lid = color, dark = '#2b2e2d';
  const parts = [box(1.30, .95, 1.0, 0, .62, 0, body), box(1.36, .06, 1.06, 0, 1.11, 0, '#4e5352')];
  const dome = spun([[.001, 0], [.5, 0], [.48, .09], [.36, .17], [.001, .2]], 16, lid, undefined, true);
  dome.scale(1.32, 1, 1.02); dome.translate(0, 1.14, 0);
  parts.push(dome, box(1.2, .04, .05, 0, 1.12, .53, dark));
  for (const x of [-.55, .55]) for (const z of [-.4, .4]) parts.push(rod([x, .02, z], [x, .14, z], .05, 8, dark));
  parts.push(rod([-.67, .95, -.2], [-.67, .95, .2], .02, 6, '#7d8281'), rod([.67, .95, -.2], [.67, .95, .2], .02, 6, '#7d8281'));
  return join(parts);
}
export const CONTAINER_COLOURS = ['#2f6b3a', '#e6e6dc', '#2a5aa8', '#e8c22a', '#e27a24', '#7b8180'];

export function furnitureModels() {
  return [bench(), bin(), planter(), hydrant(), bikeStand(), parkingMachine(), bollard(), postBox(),
    glassBell(CONTAINER_COLOURS[0]), glassBell(CONTAINER_COLOURS[1]), ...CONTAINER_COLOURS.slice(2).map(container), wallPostBox(), stolperstein(),
    cabinet(), advertisingColumn(), posterCase(), drinkingFountain(), treeGrate(), noEntrySign(), oneWaySign()];
}
