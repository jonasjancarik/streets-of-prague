import * as THREE from 'three';

// A small white card of unbranded plate characters. Each nearby car has a
// stable number; seven quads select their glyphs in the close-body shader.
let numbers: THREE.CanvasTexture | undefined;
export function registrationAtlas() {
  if (numbers) return numbers;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 512, 64);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 53px Arial, sans-serif';
  ctx.fillStyle = '#192027';
  [...'0123456789A'].forEach((c, i) => ctx.fillText(c, 16 + i * 32, 34, 25));
  numbers = new THREE.CanvasTexture(canvas);
  numbers.colorSpace = THREE.SRGBColorSpace;
  numbers.anisotropy = 4;
  return numbers;
}

export function registrationFaces(plates: THREE.BufferGeometry) {
  const at = plates.attributes.position, pos: number[] = [], hinge: number[] = [], normals: number[] = [];
  const indices: number[] = [];
  for (const end of [-1, 1]) {
    let x = 0, bottom = Infinity, top = -Infinity;
    for (let i = 0; i < at.count; i++) if (at.getX(i) * end > 0) {
      x = at.getX(i); bottom = Math.min(bottom, at.getY(i)); top = Math.max(top, at.getY(i));
    }
    if (bottom > top) continue;
    const mid = (bottom + top) / 2;
    for (let digit = 0; digit < 7; digit++) {
      const first = pos.length / 3, offset = -0.207 + digit * 0.061 + (digit >= 3 ? 0.015 : 0);
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        pos.push(x + end * 0.002, mid + (v - 0.5) * 0.093, -end * (offset + u * 0.055));
        normals.push(end, 0, 0);
        hinge.push(u, v, 5 + digit);
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(indices);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('hinge', new THREE.Float32BufferAttribute(hinge, 3));
  const n = pos.length / 3, colour = new THREE.Color('#e3e5e0'), rgb = new Float32Array(n * 3);
  for (let i = 0; i < rgb.length; i += 3) rgb.set([colour.r, colour.g, colour.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
  g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n), 1));
  return g;
}
