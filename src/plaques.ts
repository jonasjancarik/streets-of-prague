// Memorial plaques on the street walls drawn close up, where OpenStreetMap maps one
// (plaqueMounts in map/streetFacade.ts). The game doesn't know what a plaque says: each is
// a stone or bronze tablet with an engraved border and lines that read as an inscription
// from the pavement, not a made-up one.
import * as THREE from 'three';
import { PLAQUE } from './facades.ts';

let material: THREE.MeshPhongMaterial | undefined;
// Two tablets side by side: pale stone with dark-filled lines, and cast bronze.
function tablets() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 192;
  const g = c.getContext('2d')!;
  const rng = (n: number) => { let s = n; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  for (const [i, ground, ink, edge] of [[0, '#c9c2b4', '#4b443c', '#a59d8e'], [1, '#6f5a33', '#c7a25a', '#4d3d22']] as const) {
    const x0 = i * 256, r = rng(7 + i);
    g.fillStyle = edge; g.fillRect(x0, 0, 256, 192);
    g.fillStyle = ground; g.fillRect(x0 + 10, 10, 236, 172);
    g.strokeStyle = ink; g.lineWidth = 2; g.strokeRect(x0 + 18, 18, 220, 156);
    // A heading, then lines of smaller "text" broken into words, centred.
    g.fillStyle = ink;
    for (let row = 0, y = 38; row < 6; row++, y += row === 1 ? 26 : 20) {
      const h = row === 0 ? 9 : 5, span = row === 0 ? 120 : 150 + r() * 40;
      let x = x0 + 128 - span / 2;
      while (x < x0 + 128 + span / 2 - 8) {
        const w = Math.min(10 + r() * 28, x0 + 128 + span / 2 - x);
        g.fillRect(x, y, w, h); x += w + 6;
      }
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  return new THREE.MeshPhongMaterial({ map, specular: 0x3a3226, shininess: 26 });
}

// One mesh for a wall's plaques (x y z per plaque, the wall's outward normal nx, nz), or null.
export function plaqueMesh(mounts: Float32Array, nx: number, nz: number, seed = 0) {
  if (!mounts.length) return null;
  const [hw, hh] = PLAQUE, rx = nz, rz = -nx, off = .012, pos: number[] = [], uv: number[] = [], normal: number[] = [], index: number[] = [];
  for (let i = 0, k = 0; i + 2 < mounts.length; i += 3, k++) {
    const x = mounts[i] + nx * off, y = mounts[i + 1], z = mounts[i + 2] + nz * off, u0 = (seed + k) % 2 ? .5 : 0, base = k * 4;
    for (const [sx, sy, u, v] of [[-1, -1, u0, 0], [1, -1, u0 + .5, 0], [1, 1, u0 + .5, 1], [-1, 1, u0, 1]]) {
      pos.push(x + rx * sx * hw, y + sy * hh, z + rz * sx * hw); uv.push(u, v); normal.push(nx, 0, nz);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  const mesh = new THREE.Mesh(geometry, material ??= tablets());
  mesh.name = 'Memorial plaques'; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
  return mesh;
}
