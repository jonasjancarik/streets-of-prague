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
      let mat;
      if (l.shade !== undefined) {
        // Custom blending keeps it in the ordered ground pass, under buildings and cars.
        mat = new THREE.ShaderMaterial({
          blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
          uniforms: { opacity: { value: l.shade } },
          vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'uniform float opacity; varying float vA; void main() { gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
        });
      } else {
        mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[l.pattern], time, relief);
        if (l.blend !== null) { mat.blending = THREE.CustomBlending; mat.opacity = l.blend; }
      }
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
