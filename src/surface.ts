import * as THREE from 'three';
import { PATTERN, patterned, DIG } from './shading.ts';

// A tile's ground as meshes, from the layers ground.ts worked out (in a tile worker):
// procedural shaders for the surfaces, soft shading at shores and round buildings,
// and the bridges above the ground and tunnels below it (`masks`: { texture, box }
// per level, where it is).
export interface GroundLayer {
  order: number;
  geometry: { position: Float32Array; normal: Float32Array; index: Uint32Array; alpha?: Float32Array };
  color?: string;
  pattern?: string;
  blend?: number | null;
  shade?: number;
  slab?: boolean;
  deck?: boolean;
  tunnel?: boolean;
  level?: number;
  base?: boolean; // the plain ground under everything (see `photo`)
}

interface SurfaceTexture { texture: THREE.DataTexture; box: number[] }
// `photo`: prototype (?ortho): the tile's painted aerial photograph on the plain ground.
interface SurfaceOptions {
  time?: { value: number }; relief?: SurfaceTexture | null; masks?: Map<number, SurfaceTexture>;
  photo?: { texture: THREE.Texture; box: number[] } | null;
}

export class Surfaces {
  group: THREE.Group;
  masks: THREE.DataTexture[];

  constructor(layers: GroundLayer[], { time = { value: 0 }, relief = null, masks = new Map(), photo = null }: SurfaceOptions = {}) {
    this.group = new THREE.Group();
    this.masks = [...masks.values()].map((m) => m.texture);
    for (const l of layers) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(l.geometry.position, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(l.geometry.normal, 3));
      if (l.geometry.alpha) g.setAttribute('alpha', new THREE.BufferAttribute(l.geometry.alpha, 1));
      g.setIndex(new THREE.BufferAttribute(l.geometry.index, 1));
      const mat = surfaceMaterial(l, time, relief, l.level === undefined ? null : masks.get(l.level) ?? null, l.base ? photo : null);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = l.order;
      if (l.shade === undefined && !l.tunnel) m.receiveShadow = true;
      if (l.slab) m.castShadow = true;
      this.group.add(m);
    }
  }

  dispose() {
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); o.material.dispose(); } });
    for (const m of this.masks) m.dispose();
  }
}

function surfaceMaterial(l: GroundLayer, time: { value: number }, relief: SurfaceTexture | null, mask: SurfaceTexture | null, photo: { texture: THREE.Texture; box: number[] } | null = null) {
  // A bridge deck's slab is solid: drawn with depth, so what's under it is hidden
  // (except round the player, see CUTAWAY), and it casts a shadow.
  if (l.slab) return patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide }), PATTERN[l.pattern ?? 'flat'], time, null, { mask: null });
  // What's on a deck is drawn over its slab, only where there is a deck, and hidden
  // behind anything in front of it (a higher deck, a parapet).
  // A tunnel is solid too, and under the ground (see TileWorld's depth-only ground):
  // it shows only round you, when you're in it. Its paint lies on its floor.
  if (l.tunnel) {
    const paint = l.pattern === 'flat';
    const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: !paint }), PATTERN[l.pattern ?? 'flat'], time, null, null, false, null, true);
    if (paint) Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    return mat;
  }
  if (l.deck) {
    if (!mask) throw new Error('Deck surface requires a mask');
    const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false }), PATTERN[l.pattern ?? 'flat'], time, null, { mask: mask.texture, box: mask.box });
    Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    return mat;
  }
  if (l.shade !== undefined) {
    // Custom blending keeps it in the ordered ground pass, under buildings and cars.
    return new THREE.ShaderMaterial({
      blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
      // (Not on the bare earth round you in a tunnel: see DIG.)
      uniforms: { opacity: { value: l.shade }, uDig: DIG },
      vertexShader: 'attribute float alpha; varying float vA; varying vec2 vXZ; void main() { vA = alpha; vXZ = (modelMatrix * vec4(position, 1.0)).xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float opacity; uniform vec4 uDig; varying float vA; varying vec2 vXZ; void main() { if (distance(vXZ, uDig.xy) < uDig.z) discard; gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
    });
  }
  const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[l.pattern ?? 'flat'], time, relief, null, true, photo);
  if (l.blend !== null && l.blend !== undefined) { mat.blending = THREE.CustomBlending; mat.opacity = l.blend; }
  return mat;
}

// A mesh of every kind of ground, with and without hill shading: added to the scene
// while the game loads, to have all their shaders compiled up front (compiling one the
// first time a tile has, say, water would hold up that frame).
export function groundSamples(time: { value: number }) {
  const plane = () => {
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]);
    return { position, normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), alpha: new Float32Array(3), index: new Uint32Array([0, 1, 2]) };
  };
  const texture = new THREE.DataTexture(new Uint8Array([128]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  const relief = { texture, box: [0, 0, 1, 1] };
  const layers: GroundLayer[] = Object.keys(PATTERN).map((pattern, order) => ({ order, geometry: plane(), color: '#ffffff', pattern, blend: null }));
  layers.push({ order: layers.length, geometry: plane(), shade: 0.5 });
  // And the bridge decks' kinds.
  const decks: GroundLayer[] = [
    ...Object.keys(PATTERN).map((pattern, order) => ({ order, geometry: plane(), color: '#ffffff', pattern, blend: null, deck: true, level: 1 })),
    { order: 0, geometry: plane(), color: '#ffffff', pattern: 'concrete', blend: null, slab: true, level: 1 },
  ];
  const mask = { texture: new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType), box: [0, 1, 1, 0] };
  mask.texture.needsUpdate = true;
  const flat = new Surfaces(layers, {}), shaded = new Surfaces(layers.map((l) => ({ ...l, geometry: plane() })), { relief });
  const decked = new Surfaces(decks, { masks: new Map([[1, mask]]) });
  const group = new THREE.Group();
  group.add(flat.group, shaded.group, decked.group);
  return { group, dispose: () => { flat.dispose(); shaded.dispose(); decked.dispose(); texture.dispose(); } };
}
