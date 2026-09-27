import * as THREE from 'three';
import { PATTERN, patterned } from './shading.js';

// A tile's ground as meshes, from the layers ground.js worked out (in a tile worker):
// procedural shaders for the surfaces, soft shading at shores and round buildings.
export class Surfaces {
  constructor(layers, { time = { value: 0 }, relief = null } = {}) {
    this.group = new THREE.Group();
    for (const l of layers) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(l.geometry.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(l.geometry.normal, 3));
      if (l.geometry.alpha) g.setAttribute('alpha', new THREE.BufferAttribute(l.geometry.alpha, 1));
      g.setIndex(new THREE.BufferAttribute(l.geometry.index, 1));
      const mat = surfaceMaterial(l, time, relief);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = l.order;
      if (l.shade === undefined) m.receiveShadow = true;
      this.group.add(m);
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}

function surfaceMaterial(l, time, relief) {
  if (l.shade !== undefined) {
    // Custom blending keeps it in the ordered ground pass, under buildings and cars.
    return new THREE.ShaderMaterial({
      blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
      uniforms: { opacity: { value: l.shade } },
      vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float opacity; varying float vA; void main() { gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
    });
  }
  const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[l.pattern], time, relief);
  if (l.blend !== null) { mat.blending = THREE.CustomBlending; mat.opacity = l.blend; }
  return mat;
}

// A mesh of every kind of ground, with and without hill shading: added to the scene
// while the game loads, to have all their shaders compiled up front (compiling one the
// first time a tile has, say, water would hold up that frame).
export function groundSamples(time) {
  const plane = () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]);
    return { position, normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), alpha: new Float32Array(3), index: new Uint32Array([0, 1, 2]) };
  };
  const texture = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  const relief = { texture, box: [0, 0, 1, 1] };
  const layers = Object.keys(PATTERN).map((pattern, order) => ({ order, geometry: plane(), color: '#ffffff', pattern, blend: null }));
  layers.push({ order: layers.length, geometry: plane(), shade: 0.5 });
  const flat = new Surfaces(layers, {}), shaded = new Surfaces(layers.map((l) => ({ ...l, geometry: plane() })), { relief });
  const group = new THREE.Group();
  group.add(flat.group, shaded.group);
  return { group, dispose: () => { flat.dispose(); shaded.dispose(); texture.dispose(); } };
}
