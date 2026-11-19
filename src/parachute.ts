import * as THREE from 'three';

// Seven inflated cells across a curved ram-air wing, with a pale centre stripe.
export function parachute() {
  const group = new THREE.Group();
  const points: number[] = [], colours: number[] = [], lines: number[] = [];
  const cells = 7;
  const point = (across: number, along: number, puff: number) => [
    along + 0.3 * across * across, 3.9 - 0.8 * across * across + puff, across * 2.5,
  ];
  for (let i = 0; i < cells; i++) {
    const shade = new THREE.Color(i === 3 ? '#fff0d4' : i % 2 ? '#e85329' : '#ff8a3e');
    for (let half = 0; half < 2; half++) {
      const l = (i + half / 2) * 2 / cells - 1, r = l + 1 / cells;
      const a = point(l, -1, half * 0.24), b = point(l, 1, half * 0.24);
      const c = point(r, 1, (1 - half) * 0.24), d = point(r, -1, (1 - half) * 0.24);
      points.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let j = 0; j < 6; j++) colours.push(shade.r, shade.g, shade.b);
    }
  }
  for (const side of [-1, 1]) for (const end of [-1, 1]) {
    lines.push(0, 1.2, side * 0.2, ...point(side, end, 0));
  }
  const wing = new THREE.BufferGeometry();
  wing.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  wing.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  wing.computeVertexNormals();
  const canopy = new THREE.Mesh(wing, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  canopy.castShadow = true;
  const cords = new THREE.BufferGeometry();
  cords.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  group.add(canopy, new THREE.LineSegments(cords, new THREE.LineBasicMaterial({ color: '#484544' })));
  return group;
}
