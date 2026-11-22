import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { strut, tint } from './vehicleFittings.ts';

let cockpit: THREE.BufferGeometry | undefined;
const interior = new THREE.MeshLambertMaterial({ vertexColors: true });
const canopy = new THREE.MeshPhongMaterial({
  color: '#849ca9', transparent: true, opacity: .33,
  depthWrite: false, specular: '#b3c8d2', shininess: 85, side: THREE.DoubleSide
});
canopy.forceSinglePass = true;

function instruments() {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, c: string) => parts.push(tint(g, c));
  const box = (x: number, y: number, z: number, l: number, h: number, w: number, c: string) =>
    add(new THREE.BoxGeometry(l, h, w).translate(x, y, z), c);
  box(.64, .88, 0, 2.50, .11, 1.32, '#414548');
  for (const z of [-.40, .40]) {
    for (const x of [-.28, 1.02]) {
      box(x, 1.05, z, .48, .22, .42, '#4b5154');
      add(new THREE.BoxGeometry(.12, .61, .43).rotateZ(.12).translate(x - .22, 1.42, z), '#454d55');
      box(x - .25, 1.78, z, .14, .20, .28, '#40464c');
      for (const side of [-1, 1]) {
        add(strut([x - .19, 1.69, z + side * .10], [x - .14, 1.21, z + side * .18], .018), '#252729');
      }
    }
    add(strut([1.35, .95, z], [1.45, 1.33, z], .022), '#5e6262');
    add(strut([1.45, 1.33, z], [1.39, 1.42, z], .029), '#343638');
    box(1.72, .98, z, .16, .065, .18, '#757a7a');
  }
  add(new THREE.BoxGeometry(.44, .37, 1.30).rotateZ(-.12).translate(1.88, 1.39, 0), '#313637');
  for (const z of [-.50, -.33, .33, .50]) {
    add(new THREE.CylinderGeometry(.067, .067, .027, 16).rotateZ(Math.PI / 2).translate(1.65, 1.43, z), '#b1b4ac');
    add(new THREE.CircleGeometry(.052, 16).rotateY(-Math.PI / 2).translate(1.633, 1.43, z), '#25292c');
    box(1.632, 1.446, z, .008, .033, .008, '#dbd4b8');
  }
  box(1.64, 1.43, 0, .048, .19, .32, '#374f59');
  return mergeGeometries(parts);
}

export function cockpitView(group: THREE.Group, windows: THREE.Mesh[]) {
  const original = windows.map(m => m.material);
  let cabin: THREE.Mesh | undefined, detailed = false;
  return (near: boolean) => {
    if (near === detailed) return;
    detailed = near;
    if (!cabin) {
      cabin = new THREE.Mesh(cockpit ??= instruments(), interior);
      group.add(cabin);
    }
    cabin.visible = near;
    windows.forEach((m, i) => { m.material = near ? canopy : original[i]; });
  };
}
