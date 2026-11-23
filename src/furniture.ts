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
  const glass = cutAway(new THREE.MeshStandardMaterial({ color: '#abc5c4', opacity: 0.16, transparent: true, depthWrite: false,
    roughness: 0.19, metalness: 0.10, side: THREE.DoubleSide, forceSinglePass: true }), 'kiosk-glass');
  const leafDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: 0.42, side: THREE.DoubleSide });
  return { models, solid, shrub, glass, leafDepth };
}
const names = ['park benches', 'park bins', 'courtyard planters', 'hydrants', 'phone boxes'];

function changeModel(body: THREE.InstancedMesh, fromStreet: boolean) {
  const kind: number = body.userData.kind;
  if (fromStreet) {
    const { models, solid, shrub, glass, leafDepth } = street ??= prepareStreet();
    body.geometry = models.bodies[kind]; body.material = kind === 2 ? shrub : solid;
    body.customDepthMaterial = kind === 2 ? leafDepth : depth;
    if (kind === 4 && !body.children.length) {
      const panes = new THREE.InstancedMesh(models.glass, glass, body.count);
      panes.name = 'phone box glass';
      panes.instanceMatrix.array.set(body.instanceMatrix.array); sendInstances(panes);
      panes.computeBoundingBox(); panes.computeBoundingSphere(); body.add(panes);
    }
  } else {
    body.geometry = (overview ??= furnitureOverview())[kind]; body.material = mapMaterial; body.customDepthMaterial = depth;
  }
  if (body.children.length) body.children[0].visible = fromStreet;
  body.computeBoundingBox(); body.computeBoundingSphere();
}

export function furnitureView(meshes: THREE.InstancedMesh[], fromStreet: boolean) {
  for (const mesh of meshes) changeModel(mesh, fromStreet);
}
export function furnitureMeshes(instances: FurnitureInstances, fromStreet = false) {
  const meshes: THREE.InstancedMesh[] = [];
  for (let kind = 0; kind < names.length; kind++) {
    const matrices = instances.matrices[kind], count = matrices.length / 16;
    if (!count) continue;
    const body = new THREE.InstancedMesh((overview ??= furnitureOverview())[kind], mapMaterial, count);
    body.name = names[kind]; body.userData.furniture = true; body.userData.kind = kind;
    body.instanceMatrix.array.set(matrices); sendInstances(body);
    body.castShadow = body.receiveShadow = true; changeModel(body, fromStreet); meshes.push(body);
  }
  return meshes;
}

export function disposeFurniture(meshes: THREE.InstancedMesh[]) {
  for (const mesh of meshes) {
    for (const panes of mesh.children) (panes as THREE.InstancedMesh).dispose();
    mesh.dispose();
  }
}
