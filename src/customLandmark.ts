import * as THREE from 'three';
import proj4 from 'proj4';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapIndex } from './contracts.ts';
import { cutAway } from './shading.ts';

// Geographic origin, a point 100 m along local +X, and base elevation in metres.
const models = new Map([
  ['divadlo', { file: 'national-theatre.glb', elevation: 190,
    origin: [14.41348669212441, 50.081278066926764], axis: [14.414883831157802, 50.08127868567036] }],
  ['hus', { file: 'jan-hus.glb', elevation: 192.12,
    origin: [14.4211398634, 50.0877093323], axis: [14.4224351617, 50.0880465985] }],
]);

export function customLandmark(name: string, index: MapIndex) {
  const model = models.get(name);
  return model && load(model, index);
}

async function load(model: { file: string; elevation: number; origin: number[]; axis: number[] }, index: MapIndex) {
  const { scene } = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + model.file);
  const [w, s, e, n] = index.bbox_wgs84;
  const crs = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +ellps=WGS84 +units=m`;
  const [x, y] = proj4('EPSG:4326', crs, model.origin);
  const [ex, ey] = proj4('EPSG:4326', crs, model.axis);
  scene.position.set(x, model.elevation - (index.iprRef ?? 180), -y);
  scene.rotation.y = Math.atan2(ey - y, ex - x);
  const mesh = scene.children[0] as THREE.Mesh;
  const original = mesh.material as THREE.MeshStandardMaterial;
  if (original.map) original.map.anisotropy = 4;
  mesh.material = cutAway(new THREE.MeshLambertMaterial({ map: original.map }), 'landmark-plain');
  original.dispose();
  mesh.castShadow = mesh.receiveShadow = true;
  return scene;
}
