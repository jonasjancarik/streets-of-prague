import * as THREE from 'three';
import proj4 from 'proj4';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapIndex } from './contracts.ts';
import { cutAway } from './shading.ts';

// Origin of the authored plan and a second point 100 m along its X axis.
// Project both so the same asset fits the praha and centrum survey grids.
const entrance = [14.41348669212441, 50.081278066926764];
const east = [14.414883831157802, 50.08127868567036];

export async function nationalTheatre(index: MapIndex) {
  const { scene } = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'national-theatre.glb');
  const [w, s, e, n] = index.bbox_wgs84;
  const crs = `+proj=tmerc +lat_0=${(s + n) / 2} +lon_0=${(w + e) / 2} +ellps=WGS84 +units=m`;
  const [x, y] = proj4('EPSG:4326', crs, entrance);
  const [ex, ey] = proj4('EPSG:4326', crs, east);
  scene.position.set(x, 190 - (index.iprRef ?? 180), -y);
  scene.rotation.y = Math.atan2(ey - y, ex - x);
  const mesh = scene.children[0] as THREE.Mesh;
  const original = mesh.material as THREE.MeshStandardMaterial;
  if (original.map) original.map.anisotropy = 4;
  mesh.material = cutAway(new THREE.MeshLambertMaterial({ map: original.map }), 'landmark-plain');
  original.dispose();
  mesh.castShadow = mesh.receiveShadow = true;
  return scene;
}
