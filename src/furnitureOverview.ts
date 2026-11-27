import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Small silhouettes for the normal overhead camera.
export function furnitureOverview() {
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: string) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); g.deleteAttribute('uv'); g.translate(x, y, z);
    const c = new THREE.Color(color), col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) c.toArray(col, i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); return g;
  };
  const merge = (parts: THREE.BufferGeometry[]) => { const g = mergeGeometries(parts, false)!; parts.forEach(p => p.dispose()); return g; };
  const wood = '#8d7655', iron = '#30423b';
  const bench = [];
  for (const x of [-0.7, 0.7]) {
    bench.push(box(0.09, 0.48, 0.5, x, 0.24, 0, iron));
    bench.push(box(0.07, 0.48, 0.07, x, 0.69, 0.23, iron));
  }
  for (const z of [-0.18, 0, 0.18]) bench.push(box(1.9, 0.06, 0.14, 0, 0.47, z, wood));
  for (const y of [0.69, 0.86]) bench.push(box(1.9, 0.12, 0.06, 0, y, 0.26, wood));
  const bin = [box(0.54, 0.77, 0.54, 0, 0.405, 0, '#435349'), box(0.62, 0.07, 0.62, 0, 0.82, 0, iron), box(0.36, 0.012, 0.27, 0, 0.862, 0, '#151c18')];
  const planter = [box(1.3, 0.49, 1.3, 0, 0.265, 0, '#a8977b'), box(1.16, 0.03, 1.16, 0, 0.525, 0, '#514335')];
  // Small dense evergreen clumps instead of extra seasonal tree pages/materials.
  for (const [x, z, h] of [[-0.3, -0.2, 0.48], [0.25, -0.15, 0.6], [0, 0.28, 0.4]]) {
    const g = new THREE.IcosahedronGeometry(0.45, 0); g.deleteAttribute('uv'); g.scale(0.85, h / 0.45, 0.8); g.translate(x, 0.55 + h * 0.45, z);
    const c = new THREE.Color('#567148'), col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) c.toArray(col, i);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); planter.push(g);
  }
  // The mapped street furniture, as blocks of its colour (CONTAINER_COLOURS in
  // furnitureModels.ts for the containers).
  const stand = [box(0.05, 0.74, 0.05, 0, 0.37, -0.36, '#a7aca9'), box(0.05, 0.74, 0.05, 0, 0.37, 0.36, '#a7aca9'), box(0.05, 0.05, 0.77, 0, 0.74, 0, '#a7aca9')];
  const machine = [box(0.42, 1.24, 0.3, 0, 0.62, 0, '#8b9194'), box(0.34, 0.34, 0.04, 0, 1.58, 0, '#1f4f9c')];
  const post = [box(0.17, 0.86, 0.17, 0, 0.43, 0, '#2d3130')];
  const box2 = [box(0.06, 0.92, 0.06, 0, 0.46, 0, '#6b6f6e'), box(0.34, 0.46, 0.22, 0, 1.13, 0, '#e7862a')];
  const colours = ['#2f6b3a', '#e6e6dc', '#2a5aa8', '#e8c22a', '#e27a24', '#7b8180'];
  const bells = colours.slice(0, 2).map(c => [box(1.3, 1.1, 1.3, 0, 0.6, 0, c), box(0.8, 0.35, 0.8, 0, 1.33, 0, c)]);
  const bins = colours.slice(2).map(c => [box(1.3, 1.12, 1.0, 0, 0.6, 0, c), box(1.36, 0.14, 1.06, 0, 1.2, 0, c)]);
  return [merge(bench), merge(bin), merge(planter), merge(stand), merge(machine), merge(post), merge(box2),
    ...bells.map(merge), ...bins.map(merge), merge([box(0.34, 0.46, 0.22, 0, 1.13, 0, '#e7862a')]), merge([box(0.1, 0.05, 0.1, 0, 0.03, 0, '#b8933f')]),
    merge([box(0.8, 1.2, 0.36, 0, 0.6, 0, '#9a9b94')]), merge([box(1.15, 2.7, 1.15, 0, 1.35, 0, '#a9785a'), box(1.25, 0.4, 1.25, 0, 2.9, 0, '#2f4a3c')]),
    merge([box(1.2, 1.9, 0.14, 0, 1.15, 0, '#565c5e')]), merge([box(0.35, 1.0, 0.35, 0, 0.5, 0, '#3a3f3f')]), merge([box(1.2, 0.05, 1.2, 0, 0.03, 0, '#2c2e2c')])];
}
