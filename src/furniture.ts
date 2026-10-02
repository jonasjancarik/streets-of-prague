import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cutAway } from './shading.ts';
import { sendInstances } from './gpu.ts';
import type { FurnitureInstances } from './map/furniture.ts';

// One colour material and reused geometry per kind, with one instance draw per
// populated kind/tile. No animation or placement work in the game loop.
let models: THREE.BufferGeometry[] | null = null;
let material: THREE.MeshStandardMaterial | null = null;
let depth: THREE.MeshDepthMaterial | null = null;
function geometry() {
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
  return [merge(bench), merge(bin), merge(planter)];
}

export function furnitureMeshes(instances: FurnitureInstances) {
  models ??= geometry();
  material ??= cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), 'furniture');
  depth ??= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  const meshes: THREE.InstancedMesh[] = [];
  for (let kind = 0; kind < 3; kind++) {
    const matrices = instances.matrices[kind], count = matrices.length / 16;
    if (!count) continue;
    const mesh = new THREE.InstancedMesh(models[kind], material, count);
    mesh.name = ['park benches', 'park bins', 'courtyard planters'][kind];
    mesh.userData.furniture = true; mesh.userData.kind = kind;
    mesh.instanceMatrix.array.set(matrices); sendInstances(mesh);
    mesh.customDepthMaterial = depth; mesh.castShadow = mesh.receiveShadow = true;
    mesh.computeBoundingBox(); mesh.computeBoundingSphere(); meshes.push(mesh);
  }
  return meshes;
}

// Shared model/material resources survive tile removal; only its instance buffers
// belong to the tile. InstancedMesh.dispose releases those renderer bindings.
export function disposeFurniture(meshes: THREE.InstancedMesh[]) { for (const mesh of meshes) mesh.dispose(); }
