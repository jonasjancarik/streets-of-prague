import * as THREE from 'three';
import { PATTERN, patterned, held, DIG, roadRasterEnabled, cutAway } from './shading.ts';
import type { RoadRaster } from './roadRaster.ts';

// A tile's ground as meshes, from the layers ground.ts worked out (in a tile worker):
// procedural shaders for the surfaces, soft shading at shores and round buildings,
// and the bridges above the ground and tunnels below it (`masks`: { texture, box }
// per level, where it is).
export interface GroundLayer {
  order: number;
  // `hold`: thin paint that keeps a width in pixels from high up (see held in shading.ts).
  geometry: { position: Float32Array; normal: Float32Array; index: Uint32Array; alpha?: Float32Array; hold?: Float32Array };
  color?: string;
  pattern?: string;
  blend?: number | null;
  shade?: number;
  slab?: boolean;
  deck?: boolean;
  topOnly?: boolean;
  tunnel?: boolean;
  level?: number;
  base?: boolean; // the plain ground under everything (see `photo`)
  raster?: RoadRaster;
  wall?: boolean; // the walls at the ground's steps: upright, drawn from their lower side only
}

interface SurfaceTexture { texture: THREE.DataTexture; box: number[]; sky?: { texture: THREE.Texture; box: number[] } | null }
// `photo`: prototype (?ortho): the tile's painted aerial photograph on the plain ground.
interface SurfaceOptions {
  time?: { value: number }; relief?: SurfaceTexture | null; masks?: Map<number, SurfaceTexture>;
  photo?: { texture: THREE.Texture; box: number[] } | null;
}

// The ground in depth alone, for first person (main.ts turns it on there). The layers
// write no depth (see below), which from above costs nothing: nothing is ever behind the
// ground. From street level everything behind a crest or down a slope would be drawn
// over the ground in front of it, and a road far off over the grass at your feet. So
// before the layers, each tile's plain ground (which covers all of it, cut at the steps
// like the rest) goes into the depth, a little lower than it is: the layers lie on it,
// triangulated differently, and must stay in front. The hole round you in a tunnel is
// cut in it too.
export const GROUND_DEPTH = cutAway(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }), 'ground-depth');
GROUND_DEPTH.visible = false;
const GROUND_DEPTH_DROP = 0.3; // m

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
      const raster = l.raster ? this.coverageTexture(l.raster) : null;
      const mat = surfaceMaterial(l, time, relief, l.level === undefined ? null : masks.get(l.level) ?? null, l.base ? photo : null, raster);
      const m = new THREE.Mesh(g, mat);
      if (l.geometry.hold) {
        g.setAttribute('hold', new THREE.BufferAttribute(l.geometry.hold, 3));
        held(mat as THREE.MeshLambertMaterial, m);
      }
      m.renderOrder = l.order;
      // The ground's layers cover each other in their order, not by depth, and write
      // none. But looking over a wall from above it, the ground at its foot is behind
      // it: the walls' backs go into the depth first, and the layers are tested against
      // that (so is everything else: a boat by the quay is hidden from the street).
      if (!l.slab && !l.deck && !l.tunnel) mat.depthTest = true;
      if (l.base) {
        const depth = new THREE.Mesh(g, GROUND_DEPTH);
        depth.position.y = -GROUND_DEPTH_DROP;
        depth.renderOrder = -3001;
        this.group.add(depth);
      }
      if (l.wall) {
        const back = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide }));
        back.renderOrder = -3000;
        this.group.add(back);
      }
      if (!l.slab && !l.deck && !l.tunnel && l.order >= -1000 && l.order < -800) onceAPixel(m, l);
      if (l.shade === undefined && !l.tunnel) m.receiveShadow = true;
      if (l.slab) m.castShadow = true;
      this.group.add(m);
    }
  }

  private coverageTexture({ cells, w, h }: RoadRaster) {
    const texture = new THREE.DataTexture(cells, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    texture.unpackAlignment = 1;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.masks.push(texture);
    return texture;
  }

  dispose() {
    this.group.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); if (o.material !== GROUND_DEPTH) o.material.dispose(); } });
    for (const m of this.masks) m.dispose();
  }
}

// The ground's layers (numbered from -1000 up, see ground.ts) cover each other, and
// their patterns are the costliest part of a frame, so each pixel is shaded once, by
// the top layer there, on GPUs that would otherwise shade every layer drawn over it
// (most outside Apple's, which skip what's drawn over on their own). The stencil keeps
// the rank of the layer that drew a pixel: the solid layers are drawn from the top
// down, each only where nothing above it has been (where its rank is greater than the
// one there, which is 0 until one has). Then the see-through ones (soft shading, the
// bridges' shadows) go over them from the bottom up, each only where the solid layer
// underneath is lower than it. (Needs a renderer with a stencil buffer, see main.ts.)
function onceAPixel(m: THREE.Mesh, l: GroundLayer) {
  const rank = l.order + 1001;
  const solid = l.shade === undefined && (l.blend === null || l.blend === undefined);
  m.renderOrder = solid ? -1000 - rank : -900 + rank;
  Object.assign(m.material as THREE.Material, {
    stencilWrite: true, stencilRef: rank, stencilFunc: THREE.GreaterStencilFunc,
    stencilZPass: solid ? THREE.ReplaceStencilOp : THREE.KeepStencilOp, stencilWriteMask: solid ? 0xff : 0,
  });
}

// The WebGPU trial's own version of the soft shading's material (webgpu/soft.ts).
let softShadeBy: ((opacity: number) => THREE.Material) | null = null;
export const setSoftShade = (f: (opacity: number) => THREE.Material) => { softShadeBy = f; };
// The same soft dark shading for something that isn't a ground layer (the cars' contact shade), where there is one.
export const softShade = (opacity: number) => softShadeBy?.(opacity) ?? null;

function surfaceMaterial(l: GroundLayer, time: { value: number }, relief: SurfaceTexture | null, mask: SurfaceTexture | null, photo: { texture: THREE.Texture; box: number[] } | null = null, raster: THREE.Texture | null = null) {
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
    const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: l.topOnly ? THREE.FrontSide : THREE.DoubleSide, depthWrite: false }), PATTERN[l.pattern ?? 'flat'], time, null, { mask: mask.texture, box: mask.box });
    Object.assign(mat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    return mat;
  }
  if (l.shade !== undefined) {
    if (softShadeBy) return softShadeBy(l.shade);
    // Custom blending keeps it in the ordered ground pass, under buildings and cars.
    return new THREE.ShaderMaterial({
      blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
      // (Not on the bare earth round you in a tunnel: see DIG.)
      uniforms: { opacity: { value: l.shade }, uDig: DIG },
      vertexShader: 'attribute float alpha; varying float vA; varying vec2 vXZ; void main() { vA = alpha; vXZ = (modelMatrix * vec4(position, 1.0)).xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float opacity; uniform vec4 uDig; varying float vA; varying vec2 vXZ; void main() { if (distance(vXZ, uDig.xy) < uDig.z) discard; gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
    });
  }
  const mat = patterned(new THREE.MeshLambertMaterial({ color: l.color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[l.pattern ?? 'flat'], time, relief, null, true, photo, false, true,
    raster && l.raster ? { texture: raster, box: l.raster.box } : null);
  if (l.blend !== null && l.blend !== undefined) { mat.blending = THREE.CustomBlending; mat.opacity = l.blend; }
  // Seen from behind, a wall would be drawn over the ground above it.
  if (l.wall) mat.side = THREE.FrontSide;
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
  const texture = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(1)]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
  const relief = { texture, box: [0, 0, 1, 1] };
  const layers: GroundLayer[] = Object.keys(PATTERN).map((pattern, order) => ({ order, geometry: plane(), color: '#ffffff', pattern, blend: null }));
  layers.push({ order: layers.length, geometry: plane(), shade: 0.5 });
  if (roadRasterEnabled()) {
    const raster: RoadRaster = { box: [0, 1, 1, 0], w: 1, h: 1, cells: new Uint8Array([255]) };
    layers.push({ order: layers.length, geometry: plane(), color: '#ffffff', pattern: 'asphalt', raster });
  }
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
