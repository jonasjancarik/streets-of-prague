// What the cars near the middle of the view mirror on Ultra (plan 037 phase 3): the real
// street round them, drawn into a small cube map from a point 2 m above the street at the
// middle of the view, one face a frame. Only what stands up out of the street is drawn
// (MIRROR_LAYER, as for the wet streets' mirror: buildings, walls, trees, lamps and trams,
// but not the cars, which read the cube while it's drawn: `hide`); where nothing is, the cube stays clear and the car keeps its made-up sky and
// street (car.ts). Cars further than PROBE_NEAR from the point fade to the strips.

import * as THREE from 'three';
import { MIRROR_LAYER } from './mirror.ts';

export const PROBE_SIZE = 128;
// The tier allows it (graphics.ts: Ultra), and once all six faces are drawn: where the
// point is (xyz, three's world) and whether to use it (w).
export const PROBE_ON = { value: 0 };
export const PROBE_AT = { value: new THREE.Vector4(0, 0, 0, 0) };
// How much of what's drawn a car mirrors (the cube holds the scene's light before the
// exposure and the tone curve, about as bright as STREET_REF), and from how far (m) to how
// near the cars fade to it.
export const PROBE_K = { value: 1.2 };
export const PROBE_NEAR = { value: new THREE.Vector2(70, 35) };
const HEIGHT = 2, FAR = 150; // m above the street; how far it sees
// A face every EVERY frames (each costs a render of the scene's lists on the main thread).
export const PROBE_EVERY = { value: 3 };
// WebGPU lights only what shares a layer with the camera: the sun and the sky's light join
// this one, which only the probe's cameras see besides MIRROR_LAYER (so nothing else is drawn).
export const LIGHT_LAYER = 4;

type CubeTarget = THREE.RenderTarget & { texture: THREE.CubeTexture };
// WebGPU brings its own kind of cube target (webgpu.ts); WebGL takes three's.
let target: CubeTarget | null = null;
export function setProbeTarget(t: CubeTarget) { target = t; PROBE_MAP.value = t.texture; }
// (For checks: scripts read the faces back.)
export const probeTarget = () => target;
const options = { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
export const PROBE_OPTIONS = options;
export const PROBE_MAP: { value: THREE.Texture } = { value: new THREE.CubeTexture() };

let camera: THREE.CubeCamera | null = null;
let face = 0, drawn = 0, tick = 0;
const clearColour = new THREE.Color(), hidden: THREE.Object3D[] = [];

// Before the frame's own render: one face of the cube from 2 m above the street at (x,
// ground, z) in three's world. Returns whether it drew.
export function renderProbe(renderer: THREE.WebGLRenderer, scene: THREE.Scene, x: number, ground: number, z: number, hide: Iterable<THREE.Object3D>) {
  if (!PROBE_ON.value) { PROBE_AT.value.w = 0; drawn = 0; return false; }
  if (++tick % PROBE_EVERY.value) return false;
  if (!target) setProbeTarget(new THREE.WebGLCubeRenderTarget(PROBE_SIZE, options) as unknown as CubeTarget);
  if (!camera) {
    camera = new THREE.CubeCamera(0.5, FAR, target! as unknown as THREE.WebGLCubeRenderTarget);
    for (const c of camera.children) { c.layers.set(MIRROR_LAYER); c.layers.enable(LIGHT_LAYER); }
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(LIGHT_LAYER); });
  }
  const system = (renderer as unknown as { coordinateSystem: THREE.CoordinateSystem }).coordinateSystem;
  if (camera.coordinateSystem !== system) { camera.coordinateSystem = system; camera.updateCoordinateSystem(); }
  // (Faces drawn while driving lag by a few frames, a metre or so: not worth starting over.)
  camera.position.set(x, ground + HEIGHT, z);
  camera.updateMatrixWorld();

  const before = renderer.getRenderTarget(), clear = renderer.getClearColor(clearColour).getHex(), alpha = renderer.getClearAlpha();
  const shadows = renderer.shadowMap.autoUpdate, background = scene.background;
  renderer.shadowMap.autoUpdate = false;
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(target as unknown as THREE.WebGLRenderTarget, face);
  renderer.clear(true, true, false);
  hidden.length = 0;
  for (const o of hide) if (o.visible) { o.visible = false; hidden.push(o); }
  renderer.render(scene, camera.children[face] as THREE.PerspectiveCamera);
  for (const o of hidden) o.visible = true;
  renderer.setRenderTarget(before);
  renderer.setClearColor(clear, alpha);
  scene.background = background;
  renderer.shadowMap.autoUpdate = shadows;
  face = (face + 1) % 6;
  drawn = Math.min(6, drawn + 1);
  // (Used once every face has been drawn since it was switched on.)
  PROBE_AT.value.set(x, ground + HEIGHT, z, drawn === 6 ? 1 : 0);
  return true;
}
