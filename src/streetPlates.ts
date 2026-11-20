// At a mapped street junction, the plate reads along the street it names.
// Positions are inferred from the façades; the map does not survey individual plates.
import * as THREE from 'three';
import { insideDistrict } from './districts.ts';
import { clamp, type RawStreetEdge, type StreetNames } from './network.ts';

interface Corner { street: string; key: string; distance: number }
interface Offer extends Corner { wall: THREE.Mesh; x: number; y: number; z: number; nx: number; nz: number }

// Query only when a detailed wall enters view. The street must face the wall
// and share a node with another named street. This excludes parallel back
// streets, flyovers and walls that happen to be behind a nearby junction.
export function streetCorner(index: StreetNames, x: number, y: number, nx: number, ny: number): Corner | null {
  const cx = Math.floor(x / index.cell), cy = Math.floor(y / index.cell);
  const edges = new Set<RawStreetEdge>();
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const s of index.map.get(`${cx + i},${cy + j}`) ?? []) {
      if (!s.e.bridge && !s.e.tunnel && !s.e.level && s.e.hw !== 'steps') edges.add(s.e);
    }
  }
  let best: Corner | null = null;
  for (const e of edges) for (const start of [true, false]) {
    const first = start ? 0 : e.pts.length - 1, dir = start ? 1 : -1;
    const node = start ? e.u : e.v, corner = e.pts[first], next = e.pts[first + dir];
    if (!next || !e.name) continue;
    const dx = next[0] - corner[0], dy = next[1] - corner[1], len = Math.hypot(dx, dy);
    if (len < .1 || Math.abs(dx * nx + dy * ny) > .48 * len) continue;
    const vx = x - corner[0], vy = y - corner[1], along = (vx * dx + vy * dy) / len;
    const lateral = (dx * vy - dy * vx) / len;
    const d = Math.hypot(vx, vy);
    if (along < -1 || along > 12 || d > Math.min(20, Math.max(12, e.width / 2 + 9))) continue;
    const t = clamp(along / len, 0, 1);
    if ((dx * t - vx) * nx + (dy * t - vy) * ny < 1 || (best && best.distance <= d)) continue;
    let junction = false;
    for (const other of edges) if (other.name && other.name !== e.name && (other.u === node || other.v === node)) {
      junction = true; break;
    }
    if (junction) best = { street: e.name, distance: d, key: [node, e.name, Math.round(Math.atan2(dy, dx) / (Math.PI / 2)), Math.sign(lateral)].join('|') };
  }
  return best;
}

// The lip turns back against the wall. A slightly bowed face catches light at
// its edges, as pressed enamel does. Every plaque uses this one small mesh.
function plateGeometry() {
  const g = new THREE.PlaneGeometry(.8, .4, 12, 6), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) / .4, v = p.getY(i) / .2;
    p.setZ(i, .007 + .014 * (1 - u ** 4) * (1 - v ** 4));
  }
  g.computeVertexNormals();
  return g;
}
const plate = plateGeometry();

function paint(street: string, district: string) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  // The white and navy bands thread together at the corners of the red panel.
  g.fillStyle = '#172549'; g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#eee9de'; g.fillRect(5, 5, 502, 246);
  g.fillStyle = '#a52b24'; g.fillRect(21, 21, 470, 214);
  g.strokeStyle = '#24345a'; g.lineWidth = 4;
  g.strokeRect(12, 12, 488, 232);
  for (const right of [false, true]) for (const bottom of [false, true]) {
    g.save(); g.translate(right ? 512 : 0, bottom ? 256 : 0); g.scale(right ? -1 : 1, bottom ? -1 : 1);
    g.fillStyle = '#eee9de';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(64, 16); g.lineTo(54, 27); g.lineTo(27, 27);
    g.lineTo(27, 54); g.lineTo(16, 64); g.closePath(); g.fill();
    g.fillStyle = '#24345a'; g.fillRect(7, 17, 46, 4); g.fillRect(17, 7, 4, 46); g.restore();
  }
  g.fillStyle = '#fff5e7'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const title = street.toLocaleUpperCase('cs'), words = title.split(' ');
  g.font = 'bold 78px Impact, "Arial Narrow", sans-serif';
  if (g.measureText(title).width > 540 && words.length > 1) {
    let split = 1;
    for (let i = 2; i < words.length; i++) {
      if (Math.abs(words.slice(0, i).join(' ').length - title.length / 2) <
          Math.abs(words.slice(0, split).join(' ').length - title.length / 2)) split = i;
    }
    g.font = 'bold 56px Impact, "Arial Narrow", sans-serif';
    g.fillText(words.slice(0, split).join(' '), 256, 81, 440);
    g.fillText(words.slice(split).join(' '), 256, 139, 440);
  } else g.fillText(title, 256, 115, 440);
  g.font = 'bold 37px Impact, "Arial Narrow", sans-serif';
  g.fillText(district.toLocaleUpperCase('cs'), 256, 189, 432);
  for (const x of [14, 498]) for (const y of [15, 241]) {
    g.fillStyle = '#483d39'; g.beginPath(); g.arc(x, y, 4, 0, 2 * Math.PI); g.fill();
    g.fillStyle = '#ad9b86'; g.fillRect(x - 2, y - 2, 3, 1);
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  return new THREE.MeshPhongMaterial({ map, specular: 0x50483e, shininess: 48 });
}

export class StreetPlates {
  private corners = new Map<string, Offer[]>();
  private visible = new Map<string, { offer: Offer; mesh: THREE.Mesh<typeof plate, THREE.MeshPhongMaterial> }>();
  private boroughs?: { box: number[]; rings: number[][] }[];
  private loading = false;
  constructor(private names: StreetNames, private district: (x: number, y: number) => string | null,
    private ground: (x: number, y: number) => number, private toLonLat: (x: number, y: number) => [number, number]) {}

  add(wall: THREE.Mesh, mounts: Float32Array, nx: number, nz: number) {
    for (let i = 0; i < mounts.length; i += 3) {
      const x = mounts[i], y = mounts[i + 1], z = mounts[i + 2], above = y - this.ground(x + nx * .5, -z - nz * .5);
      if (above < 2 || above > 4) continue;
      const corner = streetCorner(this.names, x, -z, nx, -nz);
      if (!corner) continue;
      const list = this.corners.get(corner.key) ?? [];
      list.push({ ...corner, wall, x, y, z, nx, nz });
      this.corners.set(corner.key, list);
      this.update(corner.key, list);
    }
  }
  remove(wall: THREE.Mesh) {
    for (const [key, list] of this.corners) {
      const kept = list.filter(o => o.wall !== wall);
      if (kept.length === list.length) continue;
      this.update(key, kept);
      if (kept.length) this.corners.set(key, kept); else this.corners.delete(key);
    }
  }
  private update(key: string, offers: Offer[]) {
    const best = offers.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z)[0];
    const prior = this.visible.get(key);
    if (prior?.offer === best) return;
    if (prior) {
      prior.mesh.removeFromParent();
      prior.mesh.material.map?.dispose(); prior.mesh.material.dispose(); this.visible.delete(key);
    }
    if (!best) return;
    if (!this.boroughs) {
      if (!this.loading) {
        this.loading = true;
        void import('./map/pragueBoroughs.json').then(m => m.default, () => []).then(rows => {
          this.boroughs = rows;
          for (const [id, list] of this.corners) this.update(id, list);
        });
      }
      return;
    }
    const { x, y, z, nx, nz, wall, street } = best;
    const district = this.district(x, -z);
    if (!district) return;
    const [lon, lat] = this.toLonLat(x, -z);
    const number = this.boroughs.findIndex(b => insideDistrict(b, lon, lat)) + 1;
    const caption = number ? `${district} – Praha ${number}` : district;
    const mesh = new THREE.Mesh(plate, paint(street, caption));
    mesh.name = 'Street name plate'; mesh.userData.street = street; mesh.userData.caption = caption;
    mesh.position.set(x, y, z); mesh.rotation.y = Math.atan2(nx, nz);
    mesh.receiveShadow = true; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    wall.add(mesh); mesh.updateMatrixWorld(true);
    this.visible.set(key, { offer: best, mesh });
  }
}
