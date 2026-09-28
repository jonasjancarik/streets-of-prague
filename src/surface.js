import * as THREE from 'three';
import { PATTERN, patterned } from './shading.js';

// A tile's ground as meshes, from the layers ground.js worked out (in a tile worker):
// procedural shaders for the surfaces, soft shading at shores and round buildings,
// and the bridge decks above the ground (`mask`: { texture, box }, where they are).
export class Surfaces {
  constructor(layers, { time = { value: 0 }, relief = null, mask = null } = {}) {
    this.group = new THREE.Group();
    this.mask = mask?.texture || null;
    for (const l of layers) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(l.geometry.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(l.geometry.normal, 3));
      if (l.geometry.alpha) g.setAttribute('alpha', new THREE.BufferAttribute(l.geometry.alpha, 1));
      g.setIndex(new THREE.BufferAttribute(l.geometry.index, 1));
      const mat = surfaceMaterial(l, time, relief, mask);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = l.order;
      if (l.shade === undefined) m.receiveShadow = true;
      if (l.slab) m.castShadow = true;
      this.group.add(m);
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    this.mask?.dispose();
  }
}

function surfaceMaterial(l, time, relief, mask) {
  // A bridge deck's slab is solid: drawn with depth, so what's under it is hidden
  // (except round the player, see CUTAWAY), and it casts a shadow.
  if (l.slab) return patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide }), PATTERN[l.pattern], time, null, { mask: null });
  // What's on a deck is drawn over its slab, only where there is a deck, and hidden
  // behind anything in front of it (a higher deck, a parapet).
  if (l.deck) {
    const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false }), PATTERN[l.pattern], time, null, { mask: mask.texture, box: mask.box });
    Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    return mat;
  }
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
  // And the bridge decks' kinds.
  const decks = [
    ...Object.keys(PATTERN).map((pattern, order) => ({ order, geometry: plane(), color: '#ffffff', pattern, blend: null, deck: true })),
    { order: 0, geometry: plane(), color: '#ffffff', pattern: 'concrete', blend: null, slab: true },
  ];
  const mask = { texture: new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType), box: [0, 1, 1, 0] };
  mask.texture.needsUpdate = true;
  const flat = new Surfaces(layers, {}), shaded = new Surfaces(layers.map((l) => ({ ...l, geometry: plane() })), { relief });
  const decked = new Surfaces(decks, { mask });
  const group = new THREE.Group();
  group.add(flat.group, shaded.group, decked.group);
  return { group, dispose: () => { flat.dispose(); shaded.dispose(); decked.dispose(); texture.dispose(); } };
}
