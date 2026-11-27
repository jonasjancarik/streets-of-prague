import * as THREE from 'three';
import { cutAway } from './shading.ts';
import { sendInstances } from './gpu.ts';
import { furnitureAtlas, furnitureModels } from './furnitureModels.ts';
import { furnitureOverview } from './furnitureOverview.ts';
import type { FurnitureInstances } from './map/furniture.ts';

let overview: ReturnType<typeof furnitureOverview> | undefined;
let street: ReturnType<typeof prepareStreet> | undefined;
const mapMaterial = cutAway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), 'furniture');
const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
function prepareStreet() {
  const models = furnitureModels();
  const map = furnitureAtlas();
  const solid = cutAway(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.86 }), 'furniture');
  const shrub = cutAway(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: 0.96, alphaTest: 0.42, side: THREE.DoubleSide }), 'furniture-leaves');
  const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.42, side: THREE.DoubleSide });
  return { models, solid, shrub, leafDepth };
}
const names = ['benches', 'bins', 'courtyard planters', 'bike stands', 'parking machines', 'bollards', 'post boxes',
  'glass bells', 'clear glass bells', 'paper containers', 'plastic containers', 'carton containers', 'metal containers', 'post boxes on walls', 'Stolpersteine',
  'street cabinets', 'advertising columns', 'poster cases', 'drinking fountains', 'tree grates'];

function changeModel(body: THREE.InstancedMesh, fromStreet: boolean) {
  const kind: number = body.userData.kind;
  if (fromStreet) {
    const { models, solid, shrub, leafDepth } = street ??= prepareStreet();
    body.geometry = models[kind]; body.material = kind === 2 ? shrub : solid;
    body.customDepthMaterial = kind === 2 ? leafDepth : depth;
  } else {
    body.geometry = (overview ??= furnitureOverview())[kind]; body.material = mapMaterial; body.customDepthMaterial = depth;
  }
  body.computeBoundingBox(); body.computeBoundingSphere();
}

export function furnitureView(meshes: THREE.InstancedMesh[], fromStreet: boolean) {
  for (const mesh of meshes) changeModel(mesh, fromStreet);
}
export function furnitureMeshes(instances: FurnitureInstances, fromStreet = false) {
  const meshes: THREE.InstancedMesh[] = [];
  for (let kind = 0; kind < names.length; kind++) {
    const matrices = instances.matrices[kind], count = (matrices?.length ?? 0) / 16;
    if (!count) continue;
    const body = new THREE.InstancedMesh((overview ??= furnitureOverview())[kind], mapMaterial, count);
    body.name = names[kind]; body.userData.furniture = true; body.userData.kind = kind;
    body.instanceMatrix.array.set(matrices); sendInstances(body);
    body.castShadow = body.receiveShadow = true; changeModel(body, fromStreet); meshes.push(body); made.add(body);
  }
  return meshes;
}

export function disposeFurniture(meshes: THREE.InstancedMesh[]) {
  for (const mesh of meshes) { mesh.dispose(); made.delete(mesh); }
}

// For tests (scene.mjs, importing this module in the page): every furniture mesh made so
// far that is still in the scene, by name, with its instances' positions.
const made = new Set<THREE.InstancedMesh>();
export function furnitureCounts() {
  const out: Record<string, number[][]> = {};
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const mesh of made) {
    if (!mesh.parent) continue;
    const list = out[mesh.name] ??= [];
    for (let i = 0; i < mesh.count; i++) { mesh.getMatrixAt(i, m); v.setFromMatrixPosition(m); list.push([Math.round(v.x * 10) / 10, Math.round(-v.z * 10) / 10]); }
  }
  return out;
}
