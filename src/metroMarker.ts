// A four-sided entrance lantern is visible along either pavement. The smaller
// enamel case at reading height uses the station and stops from the metro map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAMP_ON } from './lamps.ts';
import type { MetroLine } from './metro.ts';

type Station = { name: string; lines: { line: MetroLine; i: number }[] };
function casing() {
  const pieces: THREE.BufferGeometry[] = [];
  const part = (g: THREE.BufferGeometry, tone: string) => {
    const c = new THREE.Color(tone), a = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3)c.toArray(a, i);
    g.setAttribute('color', new THREE.BufferAttribute(a, 3)); pieces.push(g);
  };
  const box = (w: number, h: number, d: number, y: number, tone: string, z = 0) =>
    part(new THREE.BoxGeometry(w, h, d).translate(0, y, z), tone);
  const shaft = (a: number, b: number, h: number, y: number, tone: string) =>
    part(new THREE.CylinderGeometry(a, b, h, 12).translate(0, y, 0), tone);
  shaft(.107, .153, .115, .06, '#636565'); shaft(.078, .095, 2.56, 1.38, '#586061');
  shaft(.094, .094, .058, .18, '#818383'); shaft(.10, .078, .13, 2.63, '#434c4c');
  box(.56, .55, .56, 2.96, '#4e5858'); box(.59, .038, .59, 3.242, '#a0a4a0');
  box(.574, .040, .574, 2.67, '#373f3e');
  box(.694, .21, .18, 2.37, '#555e5b'); box(.706, .024, .194, 2.476, '#a4a8a4');
  box(.505, .614, .219, 1.50, '#8e9593'); box(.528, .028, .245, 1.815, '#a4aba8');
  const g = mergeGeometries(pieces)!; pieces.forEach(p => p.dispose()); return g;
}
const frame = casing();
const steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .69, metalness: .16 });
const regions = [
  { w: .534, h: .522, y: 2.96, z: .282, top: 0, bot: 254, sides: 4 },
  { w: .666, h: .18, y: 2.37, z: .092, top: 260, bot: 329, sides: 2 },
  { w: .468, h: .571, y: 1.50, z: .112, top: 336, bot: 648, sides: 2 },
];
function faces() {
  const parts = [];
  for (const r of regions) for (let j = 0; j < r.sides; j++) {
    const g = new THREE.PlaneGeometry(r.w, r.h), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++)uv.setY(i, 1 - (r.bot - uv.getY(i) * (r.bot - r.top)) / 656);
    parts.push(g.translate(0, r.y, r.z).rotateY(j * 2 * Math.PI / r.sides));
  }
  const result = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return result;
}
const printGeometry = faces();
function print(st: Station, details: boolean) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 656;
  const g = c.getContext('2d'); if (!g) throw Error('Cannot paint a metro sign');
  const routes = st.lines, colour = (i: number) => routes[i].line.colour || '#687a69';
  g.fillStyle = '#eef0e8'; g.fillRect(0, 0, 256, 656);
  // An ordinary M and line letters, without a transport operator's emblem.
  g.fillStyle = '#293435'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 159px Arial'; g.fillText('M', 128, 92);
  g.font = 'bold 24px Arial'; g.fillText('METRO', 128, 172);
  const band = 256 / routes.length;
  for (let i = 0; i < routes.length; i++) {
    g.fillStyle = colour(i); g.fillRect(i * band, 202, band, 52);
    // Dark lettering on yellow and white on the other two line colours.
    g.fillStyle = routes[i].line.ref === 'B' ? '#252725' : '#fff'; g.font = 'bold 34px Arial';
    g.fillText(routes[i].line.ref, (i + .5) * band, 229, band - 8);
  }
  g.fillStyle = '#273133'; g.fillRect(0, 260, 256, 69); g.fillStyle = '#f0f0e8';
  g.font = 'bold 36px Arial'; g.fillText(details ? st.name : 'Metro', 128, 296, 239);
  g.fillStyle = '#f0eee4'; g.fillRect(0, 336, 256, 312);
  if (details) {
    g.textAlign = 'left'; g.fillStyle = '#223032'; g.font = 'bold 20px Arial'; g.fillText(st.name, 11, 361, 233);
    g.fillStyle = '#7a817d'; g.fillRect(10, 380, 236, 1);
    const block = Math.min(120, 244 / routes.length);
    for (let i = 0; i < routes.length; i++) {
      const { line, i: at } = routes[i], y = 394 + i * block;
      g.fillStyle = colour(i); g.fillRect(12, y, 29, 28);
      g.fillStyle = line.ref === 'B' ? '#252725' : '#fff'; g.textAlign = 'center'; g.font = 'bold 21px Arial'; g.fillText(line.ref, 26, y + 15);
      g.textAlign = 'left'; g.fillStyle = '#253132'; g.font = 'bold 14px Arial';
      g.fillText(line.stations[0].name + ' – ' + line.stations[line.stations.length - 1].name, 50, y + 15, 193);
      const stops = line.stations.slice(Math.max(0, at - 1), at + 2);
      g.fillStyle = colour(i); g.fillRect(25, y + 39, 2, Math.max(0, stops.length - 1) * 20);
      stops.forEach((s, k) => {
        const h = y + 40 + k * 20;
        g.fillStyle = colour(i); g.beginPath(); g.arc(26, h, s.name === st.name ? 5 : 3.5, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#303737'; g.font = (s.name === st.name ? 'bold ' : '') + '13px Arial'; g.fillText(s.name, 39, h, 201);
      });
    }
  }
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  // The lantern is opal acrylic; the map case below is printed paper.
  const light = document.createElement('canvas'); light.width = c.width; light.height = c.height;
  const night = light.getContext('2d')!; night.drawImage(c, 0, 0); night.fillStyle = 'rgba(0,0,0,.61)'; night.fillRect(0, 258, 256, 74);
  night.fillStyle = 'rgba(0,0,0,.74)'; night.fillRect(0, 332, 256, 324);
  const emissiveMap = new THREE.CanvasTexture(light); emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshLambertMaterial({ map: texture, emissiveMap, emissive: '#ffffff', emissiveIntensity: .04 });
}
const distant = new Map<string, THREE.MeshLambertMaterial>();
const nearby = new Map<Station, { material: THREE.MeshLambertMaterial; count: number }>();
export class MetroStreetMarker extends THREE.Group {
  private insert: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private generic: THREE.MeshLambertMaterial;
  private detailed = false;
  constructor(private station: Station, angle: number) {
    super(); const frameMesh = new THREE.Mesh(frame, steel); frameMesh.castShadow = frameMesh.receiveShadow = true;
    const key = station.lines.map(r => r.line.ref).join('/');
    let m = distant.get(key); if (!m) { m = print(station, false); distant.set(key, m); }
    this.generic = m; this.insert = new THREE.Mesh(printGeometry, m); this.insert.receiveShadow = true;
    this.rotation.y = angle; this.add(frameMesh, this.insert);
  }
  detail(on: boolean) {
    if (on !== this.detailed) {
      this.detailed = on;
      if (on) {
        let item = nearby.get(this.station);
        if (!item) { item = { material: print(this.station, true), count: 0 }; nearby.set(this.station, item); }
        item.count++; this.insert.material = item.material;
      } else {
        const item = nearby.get(this.station)!; this.insert.material = this.generic;
        if (--item.count === 0) { item.material.map!.dispose(); item.material.emissiveMap!.dispose(); item.material.dispose(); nearby.delete(this.station); }
      }
    }
    this.insert.material.emissiveIntensity = .025 + .43 * LAMP_ON.value;
  }
}
