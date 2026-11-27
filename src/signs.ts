// The traffic signs (pipeline/build_traffic_signs.py: data/<area>_now/traffic-signs.json),
// their faces drawn to a canvas atlas in the Czech designs, and each tile's posts as one
// mesh (map/signs.ts builds it in the land worker). The crossings' lit boxes glow after
// dark (lightSigns). Optional: without the file a map has no signs.
import * as THREE from 'three';
import { cutAway } from './shading.ts';
import { atlasCols, cellRect, signStyle, CELL } from './map/signs.ts';
import type { SignArrays, TrafficSigns } from './map/signs.ts';
import { directionLayout, faceOutline, PX, PANEL_LINE, WHITE_CORNER } from './map/directions.ts';
import type { DirectionArrays, DirectionSign, Face, PlateColour, Rect } from './map/directions.ts';
export { loadTrafficSigns } from './map/signs.ts';
export type { TrafficSigns } from './map/signs.ts';

const RED = '#c8102e', BLUE = '#1d55a4', YELLOW = '#f4c300', WHITE = '#f7f7f3', BLACK = '#171717', GREY = '#8b8e90';
const FONT = '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';
type Ctx = CanvasRenderingContext2D;

// The Czech number style on signs: a decimal comma.
const czech = (v: string) => v.replace('.', ',');

function walker(c: Ctx, x: number, y: number, h: number, colour: string, child = false) {
  // A walking figure `h` tall standing on (x, y), going right.
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = h * (child ? .11 : .1); c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.arc(x + h * .04, y - h * .9, h * .09, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.moveTo(x + h * .02, y - h * .75); c.lineTo(x - h * .02, y - h * .42);
  c.moveTo(x - h * .02, y - h * .42); c.lineTo(x + h * .16, y - h * .2); c.lineTo(x + h * .14, y);
  c.moveTo(x - h * .02, y - h * .42); c.lineTo(x - h * .16, y - h * .18); c.lineTo(x - h * .26, y - h * .04);
  c.moveTo(x + h * .02, y - h * .7); c.lineTo(x + h * .2, y - h * .5); c.lineTo(x + h * .26, y - h * .38);
  c.moveTo(x + h * .02, y - h * .7); c.lineTo(x - h * .14, y - h * .52); c.lineTo(x - h * .2, y - h * .38);
  c.stroke(); c.restore();
}
function car(c: Ctx, x: number, y: number, w: number, colour: string) {
  // A car seen from the side, `w` long, its wheels on (x, y) about its middle.
  c.save(); c.fillStyle = colour;
  c.beginPath(); c.roundRect(x - w / 2, y - w * .36, w, w * .22, w * .05); c.fill();
  c.beginPath(); c.moveTo(x - w * .3, y - w * .34); c.lineTo(x - w * .18, y - w * .55); c.lineTo(x + w * .16, y - w * .55); c.lineTo(x + w * .32, y - w * .34); c.fill();
  for (const s of [-.3, .3]) { c.beginPath(); c.arc(x + s * w, y - w * .12, w * .12, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function lorry(c: Ctx, x: number, y: number, w: number, colour: string) {
  c.save(); c.fillStyle = colour;
  c.fillRect(x - w / 2, y - w * .62, w * .66, w * .42);
  c.beginPath(); c.moveTo(x + w * .2, y - w * .2); c.lineTo(x + w * .2, y - w * .48); c.lineTo(x + w * .4, y - w * .48); c.lineTo(x + w * .5, y - w * .32); c.lineTo(x + w * .5, y - w * .2); c.fill();
  for (const s of [-.32, -.1, .36]) { c.beginPath(); c.arc(x + s * w, y - w * .12, w * .1, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function motorbike(c: Ctx, x: number, y: number, w: number, colour: string) {
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = w * .09; c.lineCap = 'round';
  for (const s of [-.34, .34]) { c.beginPath(); c.arc(x + s * w, y - w * .17, w * .15, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(x - w * .34, y - w * .17); c.lineTo(x - w * .05, y - w * .42); c.lineTo(x + w * .2, y - w * .42); c.lineTo(x + w * .34, y - w * .17);
  c.moveTo(x + w * .2, y - w * .42); c.lineTo(x + w * .26, y - w * .58); c.stroke();
  c.beginPath(); c.arc(x, y - w * .7, w * .1, 0, Math.PI * 2); c.fill();
  c.restore();
}
// An arrow from (x, y) up `len`, then bent by `turn` (-1 left, 1 right, 0 straight on).
function arrow(c: Ctx, x: number, y: number, len: number, wid: number, turn: number, colour: string) {
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = wid; c.lineJoin = 'round';
  const bend = turn ? len * .55 : len - wid * 1.6;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - bend);
  let tx = x, ty = y - bend, dx = 0, dy = -1;
  if (turn) { tx = x + turn * len * .45; ty = y - bend; c.lineTo(tx - turn * wid * 1.4, ty); dx = turn; dy = 0; }
  c.stroke();
  const hx = tx + dx * wid * .2, hy = ty + dy * wid * .2, s = wid * 1.6;
  c.beginPath(); c.moveTo(hx + dx * s, hy + dy * s); c.lineTo(hx - dy * s - dx * s * .6, hy + dx * s - dy * s * .6); c.lineTo(hx + dy * s - dx * s * .6, hy - dx * s - dy * s * .6); c.fill();
  c.restore();
}
function slash(c: Ctx, r: number, colour: string, width: number) {
  c.save(); c.strokeStyle = colour; c.lineWidth = width; c.lineCap = 'butt';
  c.beginPath(); c.moveTo(-r * .68, -r * .68); c.lineTo(r * .68, r * .68); c.stroke(); c.restore();
}
function text(c: Ctx, s: string, x: number, y: number, size: number, colour = BLACK, weight = 'bold') {
  c.save(); c.fillStyle = colour; c.font = `${weight} ${size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(s, x, y); c.restore();
}
function zoneDisc(c: Ctx, x: number, y: number, r: number, value: string, colour: string, ring: string) {
  c.save(); c.fillStyle = WHITE; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.strokeStyle = ring; c.lineWidth = r * .2; c.beginPath(); c.arc(x, y, r * .9, 0, Math.PI * 2); c.stroke(); c.restore();
  text(c, value, x, y + r * .06, r * (value.length > 2 ? .85 : 1.05), colour);
}

// One sign's face in its cell, `s` px a metre, about the middle (canvas y down).
function drawFace(c: Ctx, name: string, w: number, h: number, s: number) {
  const R = w / 2 * s;
  const disc = (fill: string) => { c.fillStyle = fill; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill(); };
  const prohibition = () => { disc(WHITE); c.strokeStyle = RED; c.lineWidth = R * .2; c.beginPath(); c.arc(0, 0, R * .9, 0, Math.PI * 2); c.stroke(); };
  const square = (fill: string) => { c.fillStyle = fill; c.beginPath(); c.roundRect(-w / 2 * s, -h / 2 * s, w * s, h * s, s * .03); c.fill(); };
  let m: RegExpMatchArray | null;
  if (name === 'no entry') { disc(RED); c.fillStyle = WHITE; c.fillRect(-R * .72, -R * .15, R * 1.44, R * .3); return; }
  if ((m = name.match(/^speed (\d+)$/))) { prohibition(); text(c, m[1], 0, R * .05, R * (m[1].length > 2 ? .78 : 1)); return; }
  if ((m = name.match(/^speed (\d+) end$/))) {
    disc(WHITE); c.strokeStyle = GREY; c.lineWidth = R * .04; c.beginPath(); c.arc(0, 0, R * .97, 0, Math.PI * 2); c.stroke();
    text(c, m[1], 0, R * .05, R * (m[1].length > 2 ? .78 : 1), GREY);
    c.save(); c.beginPath(); c.arc(0, 0, R * .97, 0, Math.PI * 2); c.clip(); c.strokeStyle = BLACK; c.lineWidth = R * .045;
    for (const k of [-.24, -.12, 0, .12, .24]) { c.beginPath(); c.moveTo(R * (1 + k), -R * (1 - k)); c.lineTo(-R * (1 - k), R * (1 + k)); c.stroke(); }
    c.restore(); return;
  }
  if ((m = name.match(/^weight ([\d.]+)$/))) { prohibition(); text(c, czech(m[1]) + 't', 0, R * .04, R * (m[1].length > 2 ? .62 : .8)); return; }
  if ((m = name.match(/^height ([\d.]+)$/))) {
    prohibition(); text(c, czech(m[1]) + ' m', 0, R * .04, R * .5);
    c.fillStyle = BLACK;
    for (const d of [-1, 1]) { c.beginPath(); c.moveTo(0, d * R * .3); c.lineTo(-R * .16, d * R * .55); c.lineTo(R * .16, d * R * .55); c.fill(); }
    return;
  }
  if (name === 'no lorries') { prohibition(); lorry(c, 0, R * .32, R * 1.2, BLACK); return; }
  if (name === 'no motor vehicles') { prohibition(); car(c, 0, -R * .02, R * .95, BLACK); motorbike(c, 0, R * .58, R * .6, BLACK); return; }
  if (name === 'no left turn' || name === 'no right turn') {
    prohibition(); arrow(c, name === 'no left turn' ? R * .2 : -R * .2, R * .5, R * 1.05, R * .16, name === 'no left turn' ? -1 : 1, BLACK); slash(c, R, RED, R * .2); return;
  }
  if (name === 'ahead only') { disc(BLUE); arrow(c, 0, R * .62, R * 1.25, R * .2, 0, WHITE); return; }
  if (name === 'left only' || name === 'right only') { const t = name === 'left only' ? -1 : 1; disc(BLUE); arrow(c, -t * R * .22, R * .6, R * 1.15, R * .2, t, WHITE); return; }
  if (name === 'roundabout') {
    disc(BLUE); c.save(); c.strokeStyle = c.fillStyle = WHITE; c.lineWidth = R * .16;
    for (let k = 0; k < 3; k++) {
      const a0 = k * Math.PI * 2 / 3 + .35, a1 = a0 + 1.35, r = R * .52;
      c.beginPath(); c.arc(0, 0, r, -a0, -a1, true); c.stroke();
      const hx = Math.cos(-a1) * r, hy = Math.sin(-a1) * r, tx = Math.sin(-a1), ty = -Math.cos(-a1);
      c.beginPath(); c.moveTo(hx - tx * R * .2, hy - ty * R * .2); c.lineTo(hx + Math.cos(-a1) * R * .17, hy + Math.sin(-a1) * R * .17); c.lineTo(hx - Math.cos(-a1) * R * .17, hy - Math.sin(-a1) * R * .17); c.fill();
    }
    c.restore(); return;
  }
  if (name === 'give way') {
    const a = w / 2 * s, b = h / 2 * s, i = s * .1;
    c.fillStyle = RED; c.beginPath(); c.moveTo(-a, -b); c.lineTo(a, -b); c.lineTo(0, b); c.closePath(); c.fill();
    c.fillStyle = WHITE; c.beginPath(); c.moveTo(-a + i * 1.73, -b + i); c.lineTo(a - i * 1.73, -b + i); c.lineTo(0, b - i * 2); c.closePath(); c.fill();
    return;
  }
  if (name === 'stop') {
    const r = R / Math.cos(Math.PI / 8);
    const oct = (rr: number) => { c.beginPath(); for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + k * Math.PI / 4; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); };
    c.fillStyle = WHITE; oct(r); c.fill(); c.fillStyle = RED; oct(r * .93); c.fill();
    text(c, 'STOP', 0, R * .05, R * .55, WHITE); return;
  }
  if (name === 'main road') {
    const a = w / 2 * s;
    const dia = (rr: number) => { c.beginPath(); c.moveTo(0, -rr); c.lineTo(rr, 0); c.lineTo(0, rr); c.lineTo(-rr, 0); c.closePath(); };
    c.fillStyle = BLACK; dia(a); c.fill(); c.fillStyle = WHITE; dia(a * .96); c.fill(); c.fillStyle = YELLOW; dia(a * .66); c.fill(); return;
  }
  if (name === 'one way') { square(BLUE); arrow(c, 0, h * s * .4, h * s * .8, w * s * .14, 0, WHITE); return; }
  if (name === 'crossing' || name === 'crossing lit') {
    square(BLUE); const a = w / 2 * s * .84, top = -h / 2 * s * .78, bot = h / 2 * s * .72;
    c.fillStyle = WHITE; c.beginPath(); c.moveTo(0, top); c.lineTo(a, bot); c.lineTo(-a, bot); c.closePath(); c.fill();
    c.fillStyle = BLACK;
    for (let k = 0; k < 4; k++) c.fillRect(-a * .62 + k * a * .34, bot - s * .055, a * .2, s * .04);
    walker(c, 0, bot - s * .07, s * .27, BLACK); return;
  }
  if (name === 'speed bump') {
    square(BLUE); c.fillStyle = WHITE; const a = w / 2 * s * .72;
    c.beginPath(); c.moveTo(-a, s * .1); c.quadraticCurveTo(0, -s * .2, a, s * .1); c.closePath(); c.fill();
    c.fillRect(-a, s * .12, a * 2, s * .035); return;
  }
  if ((m = name.match(/^zone (\d+)( end)?$/))) {
    const end = !!m[2], ink = end ? GREY : BLACK;
    c.fillStyle = BLACK; c.fillRect(-w / 2 * s, -h / 2 * s, w * s, h * s); c.fillStyle = WHITE; c.fillRect(-w / 2 * s + s * .015, -h / 2 * s + s * .015, w * s - s * .03, h * s - s * .03);
    zoneDisc(c, 0, -h * s * .14, w * s * .34, m[1], ink, end ? GREY : RED);
    text(c, 'ZÓNA', 0, h * s * .3, s * .17, ink);
    if (end) { c.save(); c.strokeStyle = BLACK; c.lineWidth = s * .035; c.beginPath(); c.moveTo(w / 2 * s * .85, -h / 2 * s * .9); c.lineTo(-w / 2 * s * .85, h / 2 * s * .9); c.stroke(); c.restore(); }
    return;
  }
  if ((m = name.match(/^(living street|pedestrian zone)( end)?$/))) {
    square(BLUE);
    if (m[1] === 'living street') {
      c.fillStyle = WHITE; const hx = -w * s * .2, hy = -h * s * .1;
      c.beginPath(); c.moveTo(hx - s * .1, hy); c.lineTo(hx - s * .1, hy - s * .16); c.lineTo(hx, hy - s * .25); c.lineTo(hx + s * .1, hy - s * .16); c.lineTo(hx + s * .1, hy); c.fill();
      walker(c, w * s * .12, -h * s * .02, s * .28, WHITE); walker(c, w * s * .3, -h * s * .02, s * .17, WHITE, true);
      c.beginPath(); c.arc(-w * s * .02, -h * s * .03, s * .03, 0, Math.PI * 2); c.fill();
      car(c, 0, h * s * .34, s * .4, WHITE);
    } else {
      walker(c, -w * s * .1, h * s * .1, s * .36, WHITE); walker(c, w * s * .14, h * s * .1, s * .24, WHITE, true);
      text(c, 'ZÓNA', 0, h * s * .3, s * .13, WHITE);
    }
    if (m[2]) slash(c, Math.min(w, h) / 2 * s * 1.3, RED, s * .05);
    return;
  }
  if (name === 'except access') {
    c.fillStyle = BLACK; c.fillRect(-w / 2 * s, -h / 2 * s, w * s, h * s); c.fillStyle = WHITE; c.fillRect(-w / 2 * s + s * .012, -h / 2 * s + s * .012, w * s - s * .024, h * s - s * .024);
    text(c, 'MIMO DOPRAVNÍ', 0, -h * s * .2, s * .062, BLACK); text(c, 'OBSLUHY', 0, h * s * .22, s * .062, BLACK); return;
  }
  square(GREY);
}

function drawAtlas(names: string[], cols: number, lit: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cols * CELL;
  const c = canvas.getContext('2d')!;
  c.fillStyle = lit ? '#000' : WHITE; c.fillRect(0, 0, canvas.width, canvas.height);
  if (!lit) { c.fillStyle = '#fff'; c.fillRect(0, 0, CELL, CELL); }
  names.forEach((name, k) => {
    const style = signStyle(name);
    if (!style || (lit && !name.endsWith(' lit'))) return;
    const r = cellRect(k + 1, cols, style);
    c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
    drawFace(c, name, style.w, style.h, r.scale);
    c.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

let material: THREE.MeshStandardMaterial | undefined, drawnFor: string[] | undefined;
const meshes = new Set<THREE.Mesh>();
// The material of the signs: the atlas is drawn once for the area's sign names.
function signMaterial(names: string[]) {
  if (material && drawnFor === names) return material;
  material?.map?.dispose(); material?.emissiveMap?.dispose();
  const cols = atlasCols(names.length);
  material = cutAway(new THREE.MeshStandardMaterial({ map: drawAtlas(names, cols, false), emissiveMap: drawAtlas(names, cols, true), emissive: '#ffffff',
    emissiveIntensity: 0, vertexColors: true, roughness: .5, metalness: .15 }), 'furniture');
  drawnFor = names;
  return material;
}

export function signMesh(arrays: SignArrays, signs: TrafficSigns) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(arrays.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, signMaterial(signs.names));
  mesh.name = 'traffic signs'; mesh.castShadow = mesh.receiveShadow = true; mesh.userData.posts = arrays.posts;
  mesh.addEventListener('added', () => meshes.add(mesh));
  mesh.addEventListener('removed', () => meshes.delete(mesh));
  return mesh;
}

// Every frame: the lit crossing boxes after dark (`night`: 0 by day, 1 at night).
export function lightSigns(night: number) {
  if (material) material.emissiveIntensity = Math.min(1, night * 2) * 1.6;
}

// For tests (scene.mjs, importing this module in the page): the sign meshes in the scene.
export const signAtlas = () => (material?.map?.image as HTMLCanvasElement | undefined)?.toDataURL('image/png') ?? null;
export const signsOnShow = () => ({ meshes: meshes.size, posts: [...meshes].flatMap(m => Array.from({ length: m.userData.posts.length / 4 }, (_, i) => Array.from(m.userData.posts.subarray(i * 4, i * 4 + 4) as Float32Array, v => Math.round(v * 10) / 10))), triangles: [...meshes].reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0),
  names: drawnFor ?? [], lit: material?.emissiveIntensity ?? 0 });

// ---- Direction signs: each tile's plates and boards drawn onto a canvas of its own ----

const GREEN = '#0d7a3e';
const PLATE_INK: Record<PlateColour, [string, string]> = {
  green: [GREEN, WHITE], blue: [BLUE, WHITE], white: [WHITE, BLACK], brown: ['#7a4b2a', WHITE],
};
// A road number's badge, `h` px high with its left edge at x: red for motorways and the
// first-class roads (one or two digits), green for E roads, white with a black edge for the
// rest. Gives its width.
function badge(c: Ctx, ref: string, x: number, y: number, h: number) {
  const red = /^D\d/.test(ref) || /^\d{1,2}$/.test(ref), green = /^E\s?\d/.test(ref);
  c.save(); c.font = `bold ${h * .72}px ${FONT}`;
  const w = Math.max(h * 1.2, c.measureText(ref).width + h * .5);
  c.fillStyle = red ? RED : green ? GREEN : WHITE;
  c.beginPath(); c.roundRect(x, y - h / 2, w, h, h * .12); c.fill();
  c.strokeStyle = red || green ? WHITE : BLACK; c.lineWidth = h * .08; c.stroke();
  c.fillStyle = red || green ? WHITE : BLACK; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(ref, x + w / 2, y + h * .05); c.restore();
  return w;
}
// The airport symbol, `s` px across.
function plane(c: Ctx, x: number, y: number, s: number, colour: string) {
  c.save(); c.translate(x, y); c.rotate(-Math.PI / 4); c.fillStyle = colour;
  const p = [[0, -.5], [.07, -.1], [.45, .1], [.45, .18], [.07, .08], [.06, .34], [.17, .43], [.17, .5], [0, .45]];
  c.beginPath();
  for (const [px, py] of p) c.lineTo(px * s, py * s);
  for (const [px, py] of p.slice(1, -1).reverse()) c.lineTo(-px * s, py * s);
  c.closePath(); c.fill(); c.restore();
}
// Text no more than `room` px wide: narrowed to fit.
function fitText(c: Ctx, s: string, x: number, y: number, size: number, room: number, colour: string, align: 'left' | 'right' | 'center' = 'left') {
  c.save(); c.font = `bold ${size}px ${FONT}`; c.fillStyle = colour; c.textBaseline = 'middle';
  const w = c.measureText(s).width, k = w > room ? room / w : 1;
  const left = align === 'left' ? x : align === 'right' ? x - w * k : x - w * k / 2;
  c.translate(left, y); c.scale(k, 1); c.textAlign = 'left'; c.fillText(s, 0, 0); c.restore();
}
function drawPlate(c: Ctx, f: Face, r: Rect) {
  const b = f.branch!, [bg, ink] = PLATE_INK[b.colour], s = PX;
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  const ring = faceOutline(f);
  const path = (inset: number) => {
    c.beginPath();
    ring.forEach(([x, y], i) => {
      const px = x * s * (1 - inset / f.w * 2), py = -y * s * (1 - inset / f.h * 2);
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    });
    c.closePath();
  };
  c.fillStyle = bg; path(0); c.fill();
  c.strokeStyle = ink; c.lineWidth = s * .018; path(.03); c.stroke();
  // The text between the plate's square end and its point (or after the straight-on arrow).
  const a = f.w / 2 * s, hh = f.h / 2 * s;
  let left = -a + s * .09, right = a - s * .09;
  if (f.point > 0) right = a - hh - s * .02;
  else if (f.point < 0) left = -a + hh + s * .02;
  else { arrow(c, left + s * .1, hh * .7, hh * 1.4, s * .05, 0, ink); left += s * .26; }
  const lines = Math.max(1, f.places.length), gap = (hh * 2 - s * .06) / lines;
  for (let i = 0; i < lines; i++) {
    let x = left;
    const y = -hh + s * .03 + gap * (i + .5);
    if (i === 0) {
      for (const ref of f.refs) x += badge(c, ref, x, y, s * .17) + s * .04;
      if (b.symbol === 'airport') { plane(c, x + s * .1, y, s * .2, ink); x += s * .24; }
    }
    if (f.places[i]) fitText(c, f.places[i], x, y + s * .005, s * .15, right - x, ink);
  }
  c.restore();
}
function drawBoard(c: Ctx, f: Face, r: Rect) {
  const s = PX, a = f.w / 2 * s, hh = f.h / 2 * s, branches = f.sign.branches;
  const field = branches.every(b => b.colour === 'green') ? GREEN : BLUE;
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  c.fillStyle = field; c.fillRect(-a, -hh, a * 2, hh * 2);
  c.strokeStyle = WHITE; c.lineWidth = s * .03; c.strokeRect(-a + s * .04, -hh + s * .04, a * 2 - s * .08, hh * 2 - s * .08);
  // The junction: the stem from the bottom, then a line out along each branch with its head.
  const jy = hh * .25, len = s * .38, wide = s * .1;
  c.strokeStyle = WHITE; c.lineWidth = wide;
  c.beginPath(); c.moveTo(0, hh - s * .1); c.lineTo(0, jy); c.stroke();
  for (const b of branches) {
    const t = b.turn * Math.PI / 180, ux = -Math.sin(t), uy = -Math.cos(t);
    const ex = ux * len, ey = jy + uy * len;
    c.strokeStyle = c.fillStyle = WHITE;
    c.beginPath(); c.moveTo(0, jy); c.lineTo(ex, ey); c.stroke();
    c.beginPath(); c.moveTo(ex + ux * wide * 1.6, ey + uy * wide * 1.6); c.lineTo(ex - uy * wide * 1.1, ey + ux * wide * 1.1); c.lineTo(ex + uy * wide * 1.1, ey - ux * wide * 1.1); c.fill();
    // Its places by the head: left of a left branch, right of a right one, above straight on.
    const lines = b.places.slice(0, 3), lineH = s * .17, blockH = lineH * (Math.max(1, lines.length) + (b.refs.length ? 1 : 0));
    const side = Math.abs(b.turn) < 30 ? 0 : b.turn > 0 ? -1 : 1;
    const bw = side ? Math.max(s * .6, a - Math.abs(ex) - s * .16 - wide) : a * 1.1;
    let bx = side < 0 ? ex - wide * 2 - bw : side > 0 ? ex + wide * 2 : -bw / 2;
    let by = side ? ey - blockH / 2 : ey - wide * 2 - blockH;
    bx = Math.max(-a + s * .08, Math.min(a - s * .08 - bw, bx)); by = Math.max(-hh + s * .08, Math.min(hh - s * .08 - blockH, by));
    const [bg, ink] = PLATE_INK[b.colour];
    if (bg !== field) { c.fillStyle = bg; c.beginPath(); c.roundRect(bx - s * .03, by - s * .02, bw + s * .06, blockH + s * .04, s * .03); c.fill(); }
    let y = by + lineH / 2;
    if (b.refs.length) {
      let x = side < 0 ? bx + bw - b.refs.length * s * .3 : bx;
      for (const ref of b.refs) x += badge(c, ref, x, y, s * .15) + s * .04;
      y += lineH;
    }
    for (const place of lines) {
      fitText(c, place, side < 0 ? bx + bw : side > 0 ? bx : bx + bw / 2, y, s * .14, bw, ink, side < 0 ? 'right' : side > 0 ? 'left' : 'center');
      y += lineH;
    }
  }
  c.restore();
}
// A gantry's panel: its road numbers, its places, and an arrow over each of its lanes, down
// for straight on, up and out for a lane turning off.
function drawPanel(c: Ctx, f: Face, r: Rect) {
  const p = f.panel!, s = f.px, a = f.w / 2 * s, hh = f.h / 2 * s, [bg, ink] = PLATE_INK[p.colour];
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  c.fillStyle = bg; c.fillRect(-a, -hh, a * 2, hh * 2);
  c.strokeStyle = ink; c.lineWidth = s * .05; c.strokeRect(-a + s * .08, -hh + s * .08, a * 2 - s * .16, hh * 2 - s * .16);
  let y = -hh + s * .25 + s * PANEL_LINE / 2;
  if (p.refs.length) {
    c.font = `bold ${s * .25}px ${FONT}`;
    const widths = p.refs.map(ref => Math.max(s * .42, c.measureText(ref).width + s * .18));
    let x = -(widths.reduce((t, w) => t + w + s * .1, 0) - s * .1) / 2;
    for (const ref of p.refs) x += badge(c, ref, x, y, s * .34) + s * .1;
    y += s * PANEL_LINE;
  }
  for (const place of f.places) {
    fitText(c, place, 0, y, s * .3, a * 2 - s * .4, ink, 'center');
    y += s * PANEL_LINE;
  }
  const lanes = p.last - p.first + 1, ay = hh - s * .32;
  for (let k = 0; k < lanes; k++) {
    const x = -a + (k + .5) * a * 2 / lanes, turn = p.turns[k] ?? 'through';
    const side = /right/.test(turn) ? 1 : /left/.test(turn) ? -1 : 0;
    // Down over a lane going on, up and to its side over a lane turning off.
    const ux = side * .7, uy = side ? -.7 : 1, len = s * .38, w = s * .07;
    c.save(); c.strokeStyle = c.fillStyle = ink; c.lineWidth = w;
    const x0 = x - ux * len / 2, y0 = ay - uy * len / 2, x1 = x + ux * len / 2, y1 = ay + uy * len / 2;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - ux * w * 1.5, y1 - uy * w * 1.5); c.stroke();
    c.beginPath(); c.moveTo(x1 + ux * w * .6, y1 + uy * w * .6); c.lineTo(x1 - ux * w * 2 - uy * w * 1.6, y1 - uy * w * 2 + ux * w * 1.6);
    c.lineTo(x1 - ux * w * 2 + uy * w * 1.6, y1 - uy * w * 2 - ux * w * 1.6); c.fill(); c.restore();
  }
  c.restore();
}
// A tile's direction signs as a mesh, their faces drawn on a canvas of its own (laid out as
// map/directions.ts lays it out for the geometry). Its material and canvas are its own.
export function directionMesh(arrays: DirectionArrays, signs: DirectionSign[]) {
  const { faces, rects, width, height } = directionLayout(signs);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#fff'; c.fillRect(0, 0, WHITE_CORNER, WHITE_CORNER);
  faces.forEach((f, i) => (f.kind === 'board' ? drawBoard : f.kind === 'panel' ? drawPanel : drawPlate)(c, f, rects[i]));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]] as const) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, cutAway(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: .5, metalness: .15 }), 'furniture'));
  mesh.name = 'direction signs'; mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.posts = arrays.posts; mesh.userData.ownMaterial = true;
  mesh.addEventListener('added', () => meshes.add(mesh));
  mesh.addEventListener('removed', () => meshes.delete(mesh));
  return mesh;
}
// For tests: the direction signs' canvases in the scene, as PNGs.
export const directionCanvases = () => [...meshes].filter(m => m.userData.ownMaterial)
  .map(m => ((m.material as THREE.MeshStandardMaterial).map!.image as HTMLCanvasElement).toDataURL('image/png'));
