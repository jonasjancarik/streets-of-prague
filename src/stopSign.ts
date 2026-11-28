import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { posts, fall, type Post } from './posts.ts';
import { crash } from './impacts.ts';

// The street sign follows the slim red two-post frame in IPR's public-space manual,
// section D.5.4.2. Its printed inserts use the lines and directions in this map.
export type StopMode = 'tram' | 'bus';
export interface StopRoute { ref: string; to: string; preceding: string[]; following: string[] }

function pictogram(g: CanvasRenderingContext2D, mode: StopMode) {
  g.fillStyle = '#0b4a9c'; g.beginPath(); g.roundRect(1, 1, 62, 62, 5); g.fill();
  g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.strokeRect(6, 6, 52, 52);
  g.fillStyle = '#eef0ee'; g.fillRect(10, 10, 44, 44);
  g.fillStyle = '#16181a';
  if (mode === 'bus') {
    g.beginPath(); g.roundRect(13, 22, 38, 17, 3); g.fill();
    g.fillStyle = '#eef0ee';
    for (const x of [16, 23, 30, 37]) g.fillRect(x, 25, 5, 6);
    g.fillRect(44, 25, 4, 10); g.fillStyle = '#16181a';
    for (const x of [20, 43]) { g.beginPath(); g.arc(x, 40, 3.5, 0, Math.PI * 2); g.fill(); }
  } else {
    g.fillRect(29, 21, 6, 1.5);
    g.beginPath(); g.moveTo(32, 22.5); g.lineTo(28, 27); g.lineTo(36, 27); g.closePath(); g.fill();
    g.beginPath(); g.roundRect(14, 27, 36, 14, 3); g.fill();
    g.fillStyle = '#eef0ee';
    for (const x of [17, 24, 31, 38, 45]) g.fillRect(x, 29.5, 5, 5);
    g.fillStyle = '#16181a'; g.fillRect(13, 43, 38, 1.5);
  }
}

function canvas(width: number, height: number) {
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  const g = c.getContext('2d'); if (!g) throw new Error('Cannot paint a stop sign');
  return g;
}
function texture(g: CanvasRenderingContext2D) {
  const t = new THREE.CanvasTexture(g.canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function symbol(mode: StopMode) {
  const g = canvas(64, 64); pictogram(g, mode);
  return new THREE.MeshBasicMaterial({ map: texture(g), transparent: true, side: THREE.DoubleSide });
}
const symbols = { tram: symbol('tram'), bus: symbol('bus') };
const names = new Map<string, THREE.MeshBasicMaterial>();
function overheadName(name: string) {
  let m = names.get(name);
  if (!m) {
    const g = canvas(256, 48);
    g.fillStyle = '#12233b'; g.fillRect(0, 0, 256, 48); g.fillStyle = '#fff';
    g.font = 'bold 26px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, 128, 26, 240);
    m = new THREE.MeshBasicMaterial({ map: texture(g), side: THREE.DoubleSide }); names.set(name, m);
  }
  return m;
}
const mapPost = new THREE.BoxGeometry(0.14, 2.6, 0.14).translate(0, 1.3, 0);
const mapPole = new THREE.MeshLambertMaterial({ color: '#3a3d40' });
const mapTop = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const face = new THREE.PlaneGeometry(1, 1);

function makeFrame() {
  const parts: THREE.BufferGeometry[] = [];
  function bar(x: number, y: number, z: number, w: number, h: number, d: number, color: string) {
    const part = new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const col = new THREE.Color(color), a = new Float32Array(part.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) col.toArray(a, i);
    part.setAttribute('color', new THREE.BufferAttribute(a, 3)); parts.push(part);
  }
  const red = '#b92721';
  for (const x of [-0.267, 0.267]) {
    bar(x, 1.55, 0, 0.045, 3.08, 0.064, red);
    bar(x, 0.032, 0, 0.095, 0.055, 0.12, '#514e48');
  }
  bar(0, 0.095, 0, 0.51, 0.055, 0.052, red);
  bar(0, 3.105, 0, 0.582, 0.055, 0.078, red);
  bar(0, 2.82, 0, 0.505, 0.505, 0.055, '#4a5051');
  bar(0, 2.35, 0, 0.52, 0.39, 0.075, '#a32220');
  bar(0, 1.43, 0, 0.555, 0.70, 0.09, '#a2a5a2');
  bar(0, 1.77, 0, 0.575, 0.032, 0.12, '#b0b3b1');
  for (const side of [-1, 1]) bar(0.246, 1.43, side * 0.047, 0.013, 0.044, 0.006, '#565a59');
  const frame = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return frame;
}
const frameGeometry = makeFrame();
const frameMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.76, metalness: 0.12 });
// All three printed inserts share one atlas and draw, with legible type on BOTH faces.
const width = 320, height = 1024;
const panels = [
  { w: 0.485, h: 0.485, y: 2.82, z: 0.029, top: 0, bottom: 320 },
  { w: 0.491, h: 0.36, y: 2.35, z: 0.039, top: 326, bottom: 558 },
  { w: 0.496, h: 0.645, y: 1.43, z: 0.046, top: 566, bottom: 982 },
];
function makeInserts() {
  const parts = [];
  for (const p of panels) for (const side of [-1, 1]) {
    const part = new THREE.PlaneGeometry(p.w, p.h), uv = part.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (p.bottom - uv.getY(i) * (p.bottom - p.top)) / height);
    if (side < 0) part.rotateY(Math.PI);
    parts.push(part.translate(0, p.y, side * p.z));
  }
  const mesh = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return mesh;
}
const insertsGeometry = makeInserts();

function print(mode: StopMode, name: string, routes: StopRoute[], platform?: string) {
  const g = canvas(width, height);
  g.fillStyle = '#f3f1e9'; g.fillRect(0, 0, width, height);
  g.save(); g.scale(5, 5); pictogram(g, mode); g.restore();
  g.fillStyle = '#202728'; g.fillRect(0, 326, width, 64);
  g.fillStyle = '#fff'; g.font = 'bold 33px Arial, sans-serif'; g.textBaseline = 'middle';
  g.fillText(name, 10, 360, platform ? 249 : 300);
  if (platform) { g.fillStyle = '#f0e8cb'; g.fillRect(267, 337, 43, 42); g.fillStyle = '#222'; g.textAlign = 'center'; g.fillText(platform, 288, 359, 38); }
  g.textAlign = 'left';
  const refs = [...new Set(routes.map(r => r.ref))];
  const columns = Math.max(3, Math.ceil(refs.length / 3)), rows = Math.max(1, Math.ceil(refs.length / columns));
  const cw = (width - 12) / columns, ch = Math.min(71, 157 / rows);
  refs.forEach((ref, i) => {
    const x = 6 + (i % columns) * cw, y = 398 + Math.floor(i / columns) * ch;
    const night = /^9\d/.test(ref);
    g.fillStyle = night ? '#242c33' : '#dddcd6'; g.fillRect(x, y, cw - 4, ch - 4);
    g.fillStyle = night ? '#f6f4ed' : '#191b1c'; g.font = `bold ${Math.round(ch * 0.73)}px Arial, sans-serif`;
    g.textAlign = 'center'; g.fillText(ref, x + (cw - 4) / 2, y + ch * 0.51, cw - 9);
  });
  g.fillStyle = '#d1cfbf'; g.fillRect(0, 566, width, 416);
  if (refs.length === 1 && routes[0].to) {
    g.textAlign = 'left'; g.fillStyle = '#454947'; g.font = '15px Arial'; g.fillText('SMĚR', cw + 11, 414);
    g.font = 'bold 23px Arial'; g.fillText(routes[0].to, cw + 10, 446, width - cw - 18);
  }
  const sheets = routes.slice(0, 4), cols = sheets.length > 1 ? 2 : 1;
  const sheetW = (width - 12) / cols, sheetH = sheets.length > 2 ? 197 : 395;
  sheets.forEach((r, i) => {
    const x = 7 + i % cols * sheetW, y = 575 + Math.floor(i / cols) * 201, w = sheetW - 5;
    g.fillStyle = '#f8f6ec'; g.fillRect(x, y, w, sheetH);
    g.fillStyle = '#a32722'; g.fillRect(x + 5, y + 7, w - 10, 4);
    g.textAlign = 'left'; g.fillStyle = '#222825'; g.font = 'bold 26px Arial'; g.fillText(r.ref, x + 6, y + 30, 46);
    g.font = 'bold 13px Arial'; g.fillText(r.to, x + 51, y + 32, w - 56);
    g.fillStyle = '#d4d4c9'; g.fillRect(x + 5, y + 50, w - 10, 1.5);
    g.fillStyle = '#484d47'; g.font = 'bold 11px Arial'; g.fillText('TRASA LINKY', x + 7, y + 65);
    const sequence = [...r.preceding, name, ...r.following], current = r.preceding.length;
    const row = Math.min(26, (sheetH - 90) / Math.max(sequence.length, 1));
    g.fillRect(x + 12, y + 84, 1.3, Math.max(0, sequence.length - 1) * row);
    sequence.forEach((s, j) => {
      const lineY = y + 84 + j * row; g.fillStyle = j === current ? '#a32722' : '#707573';
      g.beginPath(); g.arc(x + 12.6, lineY, j === current ? 4 : 2.6, 0, 2 * Math.PI); g.fill();
      g.fillStyle = '#252a2b'; g.font = `${j === current ? 'bold ' : ''}12px Arial`; g.fillText(s, x + 22, lineY, w - 26);
    });
  });
  const sheen = g.createLinearGradient(0, 566, width, 982);
  sheen.addColorStop(0, 'rgba(221,235,237,.16)'); sheen.addColorStop(0.5, 'rgba(221,235,237,.02)');
  sheen.addColorStop(1, 'rgba(77,89,87,.07)'); g.fillStyle = sheen; g.fillRect(0, 566, width, 416);
  return new THREE.MeshLambertMaterial({ map: texture(g) });
}
const distant = { bus: print('bus', '', []), tram: print('tram', '', []) };

// A stop's sign is a post a car can knock over (posts.ts): its two thin steel posts go at
// about 15 km/h, and it falls flat the way the car was going, turning about its foot.
const STOP_POST = { r: 0.25, tough: 4, give: 0.1 };
const tilt = new THREE.Vector3();

export class StopSign extends THREE.Group {
  private post?: Post;
  private mapView = new THREE.Group();
  private streetView = new THREE.Group();
  private inserts: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private printed?: THREE.MeshLambertMaterial;
  constructor(private mode: StopMode, private stopName: string, angle: number, private routes: StopRoute[], private platform?: string) {
    super();
    routes.sort((a, b) => a.ref.localeCompare(b.ref, 'cs', { numeric: true }) || a.to.localeCompare(b.to, 'cs'));
    const tram = mode === 'tram', size = tram ? 2.2 : 1.9;
    const pole = new THREE.Mesh(mapPost, mapPole); pole.castShadow = true;
    const top = new THREE.Mesh(mapTop, symbols[mode]); top.position.y = 2.7; top.scale.set(size, 1, size); if (!tram) top.rotation.y = angle;
    const label = new THREE.Mesh(face, overheadName(stopName)); label.scale.set(tram ? 1.8 : 1.6, tram ? 0.34 : 0.30, 1);
    label.position.y = 2.35; label.rotation.y = angle;
    this.mapView.add(pole, top, label);
    const frame = new THREE.Mesh(frameGeometry, frameMaterial); frame.castShadow = frame.receiveShadow = true;
    this.inserts = new THREE.Mesh(insertsGeometry, distant[mode]); this.inserts.receiveShadow = true;
    this.streetView.add(frame, this.inserts); this.streetView.rotation.y = angle + Math.PI / 2;
    this.streetView.visible = false; this.add(this.mapView, this.streetView);
  }
  // Where it stands (game x, y, and the ground): a post there from now on, and if it has
  // been knocked over, turned down as far as it has fallen.
  stand(x: number, y: number, z: number) {
    let p = this.post;
    if (!p) {
      p = this.post = { x, y, z, ...STOP_POST, shades: false, down: null,
        knocked: (q, speed) => crash(q, null, speed * 0.6, 'post', q.x, q.y, 40) };
      posts.add(p);
    } else if (p.x !== x || p.y !== y) { posts.remove(p); Object.assign(p, { x, y, z }); posts.add(p); }
    if (p.down) {
      tilt.set(-Math.sin(p.down.ang), 0, -Math.cos(p.down.ang));
      this.quaternion.setFromAxisAngle(tilt, fall(p, performance.now()));
    } else this.quaternion.identity();
  }
  // Out of view: no post to hit (nothing's drawn there), and stood up again for when it's next seen.
  lift() { if (this.post) posts.remove(this.post); this.post = undefined; this.quaternion.identity(); }

  view(street: boolean, dx = Infinity, dy = Infinity) {
    if (!street && !this.streetView.visible) return;
    this.mapView.visible = !street; this.streetView.visible = street;
    // Hysteresis keeps a player walking near the threshold from repainting the case.
    const radius = this.printed ? 55 : 45;
    if (street && dx * dx + dy * dy < radius * radius) {
      this.inserts.material = this.printed ??= print(this.mode, this.stopName, this.routes, this.platform);
    } else if (this.printed) {
      this.inserts.material = distant[this.mode]; this.printed.map!.dispose(); this.printed.dispose(); this.printed = undefined;
    }
  }
}
