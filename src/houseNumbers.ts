// The house numbers beside the doors of the street façades drawn close up: the red
// conscription number (číslo popisné) above the blue street number (číslo orientační),
// as Prague's enamel plates are. The numbers are the address's own, from RÚIAN through
// OpenStreetMap (pipeline/build_addresses.py); which door of the wall they hang by, and
// where, is the game's (doorPlates in src/map/streetFacade.ts). A door no address ray
// reaches gets no plates rather than made-up numbers.
import * as THREE from 'three';
import { DOOR_PLATES } from './facades.ts';
import { RayGrid, type WallBox } from './rayGrid.ts';

interface Address { cp: string; co: string }
const [WIDE, LOW, HIGH] = DOOR_PLATES;
const TALL = .17;
// How far from a door the address's ray may meet the wall (m), and how far behind the
// wall the address point may be: RÚIAN puts it inside the building, often near its middle.
const NEAR_DOOR = 12, DEPTH = 30;
// Pixels per plate in a wall's texture.
const PX = [256, 174];

function plate(g: CanvasRenderingContext2D, y: number, text: string, red: boolean) {
  const [w, h] = PX;
  g.save(); g.translate(0, y);
  // The blue plate's top rises in a shallow arch; the red one is a plain rectangle.
  const outline = (inset: number) => {
    g.beginPath();
    g.moveTo(inset, h - inset);
    g.lineTo(w - inset, h - inset);
    if (red) { g.lineTo(w - inset, inset); g.lineTo(inset, inset); }
    else {
      g.lineTo(w - inset, 30 + inset);
      g.quadraticCurveTo(w / 2, -14 + inset * 1.6, inset, 30 + inset);
    }
    g.closePath();
  };
  g.fillStyle = '#f1ede4'; outline(2); g.fill();
  g.fillStyle = red ? '#b3261e' : '#1d3f8c'; outline(13); g.fill();
  g.fillStyle = '#f6f3ec'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const size = text.length > 4 ? 92 : 112;
  g.font = `bold ${size}px "Arial Narrow", Arial, sans-serif`;
  g.fillText(text, w / 2, red ? h / 2 + 6 : h / 2 + 18, w - 40);
  g.restore();
}

// Every set of plates on show, for tests (scripts/scene.mjs: import this module in the page).
const live = new Set<THREE.Mesh>();
export const platesOnShow = () => [...live].map(m => ({ texts: m.userData.houseNumbers as string[], at: m.geometry.attributes.position.array.slice(0, 3), normal: m.geometry.attributes.normal.array.slice(0, 3) }));

export class HouseNumbers {
  private rays = new RayGrid<Address>(DEPTH);
  private index?: Promise<{ cell: number; cells: Set<string> } | null>;
  private loaded = new Map<string, Promise<void>>();
  private shown = new Map<THREE.Mesh, THREE.Mesh>();
  private url: (file: string) => string;
  // `url`: a file of the area's data (dataUrl(area, file)).
  constructor(url: (file: string) => string) { this.url = url; }

  private cells(box: WallBox) {
    this.index ??= fetch(this.url('addresses.json')).then(r => (r.ok ? r.json() : null)).then(d =>
      d && Number.isFinite(d.cell) && Array.isArray(d.cells) ? { cell: d.cell as number, cells: new Set<string>(d.cells) } : null,
    ).catch(() => null);
    return this.index.then(index => {
      if (!index) return;
      const { cell, cells } = index, wait: Promise<void>[] = [];
      // A ray starts at its street, within 20 m of the walls it can meet (RayGrid.hits).
      for (let cx = Math.floor((box.x0 - 20) / cell); cx <= Math.floor((box.x1 + 20) / cell); cx++)
        for (let cy = Math.floor((-box.z1 - 20) / cell); cy <= Math.floor((-box.z0 + 20) / cell); cy++) {
          const key = cx + '_' + cy;
          if (!cells.has(key)) continue;
          let load = this.loaded.get(key);
          if (!load) {
            load = fetch(this.url(`addresses/${key}.json`)).then(r => (r.ok ? r.json() : [])).then((rows: unknown) => {
              if (Array.isArray(rows)) for (const row of rows) {
                if (!Array.isArray(row)) continue;
                const [sx, sy, px, py, cp, co] = row;
                this.rays.add(sx, sy, px, py, { cp: String(cp ?? ''), co: String(co ?? '') });
              }
            }).catch(() => {});
            this.loaded.set(key, load);
          }
          wait.push(load);
        }
      return Promise.all(wait).then(() => {});
    });
  }

  // `doors`: the wall's doorPlates. Plates appear once the addresses round it are loaded.
  add(wall: THREE.Mesh, box: WallBox, doors: Float32Array) {
    if (!doors.length) return;
    void this.cells(box).then(() => {
      if (!wall.parent || this.shown.has(wall)) return;
      const free = Array.from({ length: doors.length / 3 }, (_, i) => i), picked: [number, Address][] = [];
      for (const { x, z, data } of this.rays.hits(box)) {
        // (RÚIAN can have the same address twice, on the building and at its entrance.)
        if ((!data.cp && !data.co) || picked.some(([, d]) => d.cp === data.cp && d.co === data.co)) continue;
        let best = -1, near = NEAR_DOOR;
        for (const i of free) {
          const d = Math.hypot(doors[i * 3] - x, doors[i * 3 + 2] - z);
          if (d < near) { near = d; best = i; }
        }
        if (best < 0) continue;
        free.splice(free.indexOf(best), 1);
        picked.push([best, data]);
      }
      if (picked.length) this.show(wall, box, doors, picked);
    });
  }

  private show(wall: THREE.Mesh, box: WallBox, doors: Float32Array, picked: [number, Address][]) {
    const faces: { at: number; dy: number; text: string; red: boolean }[] = [];
    for (const [i, { cp, co }] of picked) {
      const both = !!cp && !!co, step = (HIGH - LOW - TALL) / 2;
      if (cp) faces.push({ at: i, dy: both ? step : 0, text: cp, red: true });
      if (co) faces.push({ at: i, dy: both ? -step : 0, text: co, red: false });
    }
    const c = document.createElement('canvas'); c.width = PX[0]; c.height = PX[1] * faces.length;
    const g = c.getContext('2d')!;
    const pos: number[] = [], uv: number[] = [], normal: number[] = [], index: number[] = [];
    // Along the wall as seen from the street, and a few millimetres off the plaster.
    const rx = box.nz, rz = -box.nx, off = .009;
    faces.forEach((face, k) => {
      plate(g, k * PX[1], face.text, face.red);
      const x = doors[face.at * 3] + box.nx * off, y = doors[face.at * 3 + 1] + face.dy, z = doors[face.at * 3 + 2] + box.nz * off;
      const v0 = 1 - (k + 1) / faces.length, v1 = 1 - k / faces.length, base = k * 4;
      for (const [sx, sy, u, v] of [[-1, -1, 0, v0], [1, -1, 1, v0], [1, 1, 1, v1], [-1, 1, 0, v1]]) {
        pos.push(x + rx * sx * WIDE / 2, y + sy * TALL / 2, z + rz * sx * WIDE / 2);
        uv.push(u, v); normal.push(box.nx, 0, box.nz);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setIndex(index);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const mesh = new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({ map, alphaTest: .5, specular: 0x50483e, shininess: 48 }));
    mesh.name = 'House numbers'; mesh.userData.houseNumbers = faces.map(f => f.text);
    mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
    wall.add(mesh); mesh.updateMatrixWorld(true);
    this.shown.set(wall, mesh); live.add(mesh);
  }

  remove(wall: THREE.Mesh) {
    const mesh = this.shown.get(wall);
    if (!mesh) return;
    this.shown.delete(wall); live.delete(mesh);
    mesh.removeFromParent();
    const material = mesh.material as THREE.MeshPhongMaterial;
    material.map?.dispose(); material.dispose(); mesh.geometry.dispose();
  }
}
