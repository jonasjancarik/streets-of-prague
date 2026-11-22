import * as THREE from 'three';

export type Point3 = [number, number, number];

// A straight length of tubing between two mounting points, in vehicle coordinates.
export function strut(a: Point3, b: Point3, radius: number, sides = 8) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
  const axis = end.clone().sub(start);
  const g = new THREE.CylinderGeometry(radius, radius, axis.length(), sides);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
  return g.translate(...start.lerp(end, .5).toArray());
}

export function pane(a: Point3, b: Point3, c: Point3, d: Point3) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  g.userData.cabWindow = true;
  return g;
}

// River craft and funicular compartments share the same geometry across copies.
// Change just the geometry and material of the existing moving mesh.
const nearGeometry = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>();
const glazing = new THREE.MeshPhongMaterial({
  color: '#9db7be', transparent: true, opacity: .32,
  specular: '#aebfc2', shininess: 75, depthWrite: false, side: THREE.DoubleSide
});
glazing.forceSinglePass = true;
export class StreetVehicleMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]> {
  private detailed = false;
  private finishes: THREE.Material[];
  constructor(private simple: THREE.BufferGeometry, private finish: THREE.Material,
    private build: () => THREE.BufferGeometry, glass: THREE.Material = glazing) {
    super(simple, finish);
    this.finishes = [finish, glass];
  }
  showDetail(near: boolean) {
    if (near === this.detailed) return;
    this.detailed = near;
    let g = this.simple;
    if (near) {
      let close = nearGeometry.get(g);
      if (!close) { close = this.build(); nearGeometry.set(g, close); }
      g = close;
    }
    this.geometry = g;
    this.material = g.groups.length && near ? this.finishes : this.finish;
  }
}

export function tint(g: THREE.BufferGeometry, colour: string) {
  const c = new THREE.Color(colour), count = g.attributes.position.count;
  const colours = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  for (let i = 0; i < count; i++) colours.setXYZ(i, c.r, c.g, c.b);
  g.setAttribute('color', colours);
  g.deleteAttribute('uv');
  return g;
}

// Successive elliptical sections along +x: position, centre height, half height,
// half width. A higher power flattens the deck while keeping a rounded shoulder.
export function loftSections(sections: [number, number, number, number][], power = 2, sides = 20) {
  const positions: number[] = [], indices: number[] = [];
  const profile = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / power);
  for (const [x, y, h, w] of sections) {
    for (let i = 0; i < sides; i++) {
      const angle = i * Math.PI * 2 / sides;
      positions.push(x, y + h * profile(Math.sin(angle)), w * profile(Math.cos(angle)));
    }
  }
  for (let row = 1; row < sections.length; row++) for (let i = 0; i < sides; i++) {
    const a = (row - 1) * sides + i, b = (row - 1) * sides + (i + 1) % sides;
    indices.push(a, a + sides, b + sides, a, b + sides, b);
  }
  for (let i = 1; i < sides - 1; i++) {
    const end = (sections.length - 1) * sides;
    indices.push(0, i, i + 1, end, end + i + 1, end + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
