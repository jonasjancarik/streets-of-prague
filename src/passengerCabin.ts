// Trim visible through the near street model's windows. Dimensions and seat
// positions come from the same Blender interior that sets the door apertures.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sendInstances } from './gpu.ts';
import { mirrored } from './mirror.ts';
import { cutAway } from './shading.ts';

const LINING = 13; // matte interior, above the seven plate character tags

export function passengerCabin(type: string, layout: number[]) {
  const [front, back, half, floor, belt, roof, roofFront, roofBack, roofHalf] = layout;
  const seats = layout.slice(9), parts: THREE.BufferGeometry[] = [];
  const fabric = type === 'taxi' || type === 'police' ? '#3d403f' : '#484b49';
  const insert = type === 'van' ? '#51565a' : '#555858';
  const trim = '#343735', plastic = '#505350', chrome = '#959995';

  function finish(g: THREE.BufferGeometry, marker: number) {
    const n = g.attributes.position.count, hinge = new Float32Array(n * 3);
    for (let i = 2; i < hinge.length; i += 3) hinge[i] = marker;
    g.setAttribute('hinge', new THREE.BufferAttribute(hinge, 3));
    g.setAttribute('painted', new THREE.BufferAttribute(new Float32Array(n), 1));
    parts.push(g);
  }
  function add(colour: string, geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
    geometry.deleteAttribute('uv');
    const g = geometry.index ? geometry : mergeVertices(geometry);
    g.translate(x, y, z);
    const c = new THREE.Color(colour), rgb = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < rgb.length; i += 3) rgb.set([c.r, c.g, c.b], i);
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    finish(g, LINING);
  }
  function cushion(colour: string, x: number, y: number, z: number,
    length: number, height: number, width: number, radius: number, recline = 0) {
    const g = new RoundedBoxGeometry(length, height, width, 1, radius);
    if (recline) g.rotateZ(recline);
    add(colour, g, x, y, z);
  }
  function box(colour: string, x: number, y: number, z: number, length: number, height: number, width: number) {
    add(colour, new THREE.BoxGeometry(length, height, width), x, y, z);
  }

  for (let i = 0; i < seats.length; i += 3) {
    const [x, blenderY, width] = seats.slice(i, i + 3), z = -blenderY;
    const bench = width > 0.85;
    const squab = floor + 0.095, shoulder = Math.min(roof - 0.23, floor + 0.72);
    cushion(fabric, x, squab, z, 0.49, 0.15, width, 0.064);
    cushion(insert, x + 0.018, squab + 0.069, z, 0.41, 0.048, width * 0.76, 0.023);
    const height = shoulder - squab;
    cushion(fabric, x - 0.225, squab + height * 0.56, z, 0.134, height, width, 0.060, 0.145);
    cushion(insert, x - 0.164, squab + height * 0.56, z, 0.027, height * 0.76, width * 0.69, 0.012, 0.145);
    for (const side of [-1, 1]) {
      cushion(fabric, x - 0.164, squab + height * 0.50, z + side * width * 0.423, 0.096, height * 0.79, width * 0.13, 0.029, 0.145);
      cushion(fabric, x + 0.014, squab + 0.057, z + side * width * 0.416, 0.403, 0.077, width * 0.15, 0.031);
    }
    const rests = bench ? [-width * 0.31, width * 0.31] : [0];
    for (const offset of rests) {
      for (const post of [-0.069, 0.069]) box(chrome, x - 0.25, shoulder + 0.052, z + offset + post, 0.014, 0.10, 0.014);
      cushion(fabric, x - 0.25, shoulder + 0.137, z + offset, 0.125, 0.155, 0.237, 0.055, 0.11);
    }
  }

  // Leave space to see over the instrument hood through the bottom of the screen.
  const driverX = seats[0], driverZ = -seats[1], dashTop = belt - 0.015;
  cushion(trim, front - 0.13, dashTop - 0.072, 0, 0.36, 0.146, 2 * half - 0.14, 0.064);
  cushion(plastic, front - 0.27, dashTop - 0.15, 0, 0.12, 0.125, 2 * half - 0.24, 0.054);
  cushion('#252a2b', front - 0.26, dashTop + 0.015, driverZ, 0.22, 0.114, 0.325, 0.050);
  for (const z of [-half * 0.78, 0, half * 0.78]) {
    box('#242728', front - 0.337, dashTop - 0.11, z, 0.019, 0.056, 0.15);
    for (const h of [-0.013, 0.011]) box('#646866', front - 0.348, dashTop - 0.11 + h, z, 0.008, 0.008, 0.131);
  }
  const wheelX = Math.min(front - 0.32, driverX + 0.33), wheelY = Math.max(belt - 0.055, floor + 0.46);
  const hub = new THREE.Vector3(wheelX, wheelY, driverZ);
  const column = new THREE.Vector3(front - 0.24, dashTop - 0.13, driverZ).sub(hub);
  const shaft = new THREE.CylinderGeometry(0.033, 0.049, column.length(), 10);
  shaft.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), column.clone().normalize()));
  add(trim, shaft, hub.x + column.x / 2, hub.y + column.y / 2, hub.z);
  const ring = new THREE.TorusGeometry(0.157, 0.018, 7, 28).rotateY(Math.PI / 2).rotateZ(-0.35);
  add('#2c3031', ring, hub.x, hub.y, hub.z);
  for (const a of [Math.PI * 0.48, Math.PI * 1.52, Math.PI]) {
    const dy = Math.cos(a) * 0.142, dz = Math.sin(a) * 0.142;
    const axis = new THREE.Vector3(-dy * 0.34, dy, dz);
    const g = new THREE.CylinderGeometry(0.011, 0.015, axis.length(), 7);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()));
    add(trim, g, hub.x + axis.x / 2, hub.y + dy / 2, hub.z + dz / 2);
  }
  cushion(trim, hub.x, hub.y, hub.z, 0.069, 0.094, 0.128, 0.030);
  cushion(plastic, driverX + 0.12, floor + 0.12, 0, 0.59, 0.20, 0.16, 0.048);
  cushion(trim, driverX + 0.23, floor + 0.25, 0, 0.065, 0.12, 0.060, 0.024);
  // Rear-view mirror and its short mounting stem, on the cabin side of the screen.
  box(trim, roofFront + 0.035, roof - 0.105, 0, 0.027, 0.10, 0.026);
  cushion(trim, roofFront + 0.006, roof - 0.153, 0, 0.051, 0.067, 0.211, 0.021);
  box('#899396', roofFront - 0.022, roof - 0.152, 0, 0.007, 0.044, 0.182);
  for (const side of [-1, 1]) {
    cushion('#696b65', roofFront - 0.060, roof - 0.049, side * roofHalf * 0.54, 0.116, 0.025, 0.279, 0.011);
  }
  // A recessed centre stack faces back towards the seats: screen above the
  // climate controls. Avoid self-lit white markings in a parked car at night.
  cushion('#282d2e', front - 0.314, belt - 0.179, 0, 0.079, 0.193, 0.250, 0.031, -0.12);
  box('#3a4546', front - 0.356, belt - 0.15, 0, 0.008, 0.076, 0.167);
  for (const z of [-0.065, 0.065]) add('#676d6c', new THREE.CylinderGeometry(0.018, 0.018, 0.017, 10)
    .rotateZ(Math.PI / 2), front - 0.363, belt - 0.223, z);
  // Rear parcel shelf on cars with a boot; vans retain their sealed cargo partition.
  if (type !== 'van' && back < roofBack - 0.35) {
    box(fabric, (back + roofBack) * 0.5, belt - 0.048, 0, roofBack - back, 0.048, 2 * roofHalf - 0.08);
  }

  return parts;
}

// The real driver meshes are a single baked seated pose of the same Rocketbox
// people used on foot. Only occupied close cars draw one. Cars of the same
// driver kind share their instance pages, including across different body types.
let seatedSource: Promise<THREE.Object3D> | undefined;
export function seatedPeople() {
  return seatedSource ??= new GLTFLoader().loadAsync('car-drivers.glb').then(gltf => gltf.scene).catch(error => {
    seatedSource = undefined; throw error;
  });
}
type DriverKind = { geometry: THREE.BufferGeometry; height: number; pages: THREE.InstancedMesh[]; count: number };
export class SeatedDrivers {
  private kinds: DriverKind[] = [];
  private scene: THREE.Scene;
  private material = cutAway(new THREE.MeshLambertMaterial({ vertexColors: true, color: new THREE.Color().setScalar(0.78) }), 'rocketbox');
  private local = new THREE.Matrix4();
  private world = new THREE.Matrix4();
  private scale = new THREE.Vector3();
  private loading = false;
  private retryAt = 0;
  constructor(scene: THREE.Scene) { this.scene = scene; }
  private async load() {
    this.loading = true;
    try {
      const source = await seatedPeople();
      if (!this.prepare(source)) throw new Error('Car driver meshes missing');
    } catch (e) {
      this.retryAt = performance.now() + 60000;
      console.warn('Seated drivers could not load', e);
    } finally { this.loading = false; }
  }
  private prepare(source: THREE.Object3D) {
    const meshes = ['seated_driver_0', 'seated_driver_1', 'seated_driver_police'].map(
      name => source.getObjectByName(name) as THREE.Mesh | undefined);
    if (meshes.some(node => !node?.isMesh || !node.geometry.hasAttribute('color'))) return false;
    for (const node of meshes as THREE.Mesh[]) {
      const geometry = node.geometry;
      geometry.computeBoundingBox();
      const kind = { geometry, height: geometry.boundingBox!.max.y, pages: [], count: 0 };
      this.kinds.push(kind);
      this.page(kind);
    }
    return this.kinds.length > 0;
  }
  private page(kind: DriverKind) {
    const mesh = mirrored(new THREE.InstancedMesh(kind.geometry, this.material, 64));
    mesh.count = 0; mesh.visible = false; mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.userData.sharedMatrices = true;
    this.scene.add(mesh);
    kind.pages.push(mesh);
  }
  *meshes() { for (const k of this.kinds) yield* k.pages; }
  begin() { for (const k of this.kinds) k.count = 0; }
  put(layout: readonly number[], plate: number, officer: boolean, matrix: THREE.Matrix4) {
    this.putAt(layout[9] - .14, layout[3] + .205, -layout[10], layout[5], plate, officer, matrix);
  }
  putAt(x: number, pelvis: number, z: number, roof: number, variant: number, officer: boolean, matrix: THREE.Matrix4) {
    if (!this.kinds.length) {
      if (!this.loading && performance.now() >= this.retryAt) void this.load();
      return;
    }
    const k = this.kinds[officer && this.kinds[2] ? 2 : variant % 2];
    if (!k) return;
    const size = Math.min(1.01, (roof - 0.115 - pelvis) / k.height);
    this.local.makeTranslation(x, pelvis, z).scale(this.scale.setScalar(size));
    const i = k.count++, batch = Math.floor(i / 64);
    if (!k.pages[batch]) this.page(k);
    k.pages[batch].setMatrixAt(i % 64, this.world.multiplyMatrices(matrix, this.local));
  }
  end() {
    for (const k of this.kinds) for (let i = 0; i < k.pages.length; i++) {
      const mesh = k.pages[i];
      mesh.count = Math.max(0, Math.min(64, k.count - i * 64));
      mesh.visible = mesh.count > 0;
      if (mesh.count) sendInstances(mesh);
    }
  }
}
