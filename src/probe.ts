// What the cars near the middle of the view mirror on Ultra (plan 037 phase 3): the real
// street round them, drawn into a small cube map from a point 2 m above the street at the
// middle of the view, one face at a time. Only what stands up out of the street is drawn
// (MIRROR_LAYER, as for the wet streets' mirror: buildings, walls, trees, lamps and trams,
// but not the cars, which read the cube while it's drawn: `hide`); where nothing is, the
// cube stays clear and the car keeps its strip and made-up sky (car.ts). Cars further than
// PROBE_NEAR from the point fade to the strips.
//
// Three cubes take turns: the cars see the last two finished ones, fading from the older
// to the newer while the next is drawn, so what they mirror moves on smoothly instead of a
// face at a time (which showed as a jerky reflection on parked cars).
//
// The cube is drawn with the lamps off (their light, heads and glows): it is seen from one
// point, so with the view's middle under a lamp every car round it mirrored that lamp right
// overhead and lit up, and dimmed again a few metres on. Each car mirrors the lamps' light
// where it stands instead (lampLight in the cars' gloss).

import * as THREE from 'three';
import { MIRROR_LAYER } from './mirror.ts';
import { LAMP_ON } from './lamps.ts';

export const PROBE_SIZE = 128;
// The tier allows it (graphics.ts: Ultra), and once two cubes are finished: where the
// newer one was drawn from (xyz, three's world) and whether to use it (w).
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
const options = { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
export const PROBE_OPTIONS = options;
// WebGPU brings its own kind of cube target (webgpu.ts); WebGL takes three's.
let make: () => CubeTarget = () => new THREE.WebGLCubeRenderTarget(PROBE_SIZE, options) as unknown as CubeTarget;
export function setProbeTargets(f: () => CubeTarget) { make = f; }
// The newer finished cube, the older one, and how far the cars have faded to the newer (0..1).
export const PROBE_MAP: { value: THREE.Texture } = { value: new THREE.CubeTexture() };
export const PROBE_PREV: { value: THREE.Texture } = { value: new THREE.CubeTexture() };
export const PROBE_MIX = { value: 1 };
// A shader that holds the textures itself (TSL) hears of each swap here.
const listeners: (() => void)[] = [];
export function onProbe(f: () => void) { listeners.push(f); }

// [0] the newer finished cube, [1] the older, [2] the one being drawn.
let targets: CubeTarget[] = [];
// (For checks: scripts read the faces back.)
export const probeTarget = () => targets[0] ?? null;
let camera: THREE.CubeCamera | null = null;
let face = 0, done = 0, tick = 0;
const at = new THREE.Vector3(), clearColour = new THREE.Color(), hidden: THREE.Object3D[] = [];

// Before the frame's own render: one face of the cube being drawn, from 2 m above the
// street at (x, ground, z) in three's world. Returns whether it drew.
export function renderProbe(renderer: THREE.WebGLRenderer, scene: THREE.Scene, x: number, ground: number, z: number, hide: Iterable<THREE.Object3D>) {
  if (!PROBE_ON.value) { PROBE_AT.value.w = 0; done = 0; face = 0; return false; }
  const every = PROBE_EVERY.value;
  // The fade to the newer cube runs while the next one is drawn (6 faces, `every` frames each),
  // and is complete on the frame before the swap.
  PROBE_MIX.value = Math.min(1, PROBE_MIX.value + 1 / (6 * every - 1));
  if (++tick % every) return false;
  if (!targets.length) targets = [make(), make(), make()];
  if (!camera) {
    camera = new THREE.CubeCamera(0.5, FAR, targets[2] as unknown as THREE.WebGLCubeRenderTarget);
    for (const c of camera.children) { c.layers.set(MIRROR_LAYER); c.layers.enable(LIGHT_LAYER); }
    scene.traverse((o) => { if ((o as THREE.Light).isLight) o.layers.enable(LIGHT_LAYER); });
  }
  const system = (renderer as unknown as { coordinateSystem: THREE.CoordinateSystem }).coordinateSystem;
  if (camera.coordinateSystem !== system) { camera.coordinateSystem = system; camera.updateCoordinateSystem(); }
  // A cube is drawn from where the view was when it began.
  if (face === 0) at.set(x, ground + HEIGHT, z);
  camera.position.copy(at);
  camera.updateMatrixWorld();

  const before = renderer.getRenderTarget(), clear = renderer.getClearColor(clearColour).getHex(), alpha = renderer.getClearAlpha();
  const shadows = renderer.shadowMap.autoUpdate, background = scene.background, lamps = LAMP_ON.value;
  renderer.shadowMap.autoUpdate = false;
  LAMP_ON.value = 0;
  // (And no sky, webgpu/dome.ts: what shows no scenery must stay empty, for the made-up sky to fill.)
  const sky = (scene as { backgroundNode?: unknown }).backgroundNode;
  (scene as { backgroundNode?: unknown }).backgroundNode = null;
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(targets[2] as unknown as THREE.WebGLRenderTarget, face);
  renderer.clear(true, true, false);
  hidden.length = 0;
  for (const o of hide) if (o.visible) { o.visible = false; hidden.push(o); }
  renderer.render(scene, camera.children[face] as THREE.PerspectiveCamera);
  for (const o of hidden) o.visible = true;
  renderer.setRenderTarget(before);
  renderer.setClearColor(clear, alpha);
  scene.background = background;
  (scene as { backgroundNode?: unknown }).backgroundNode = sky;
  renderer.shadowMap.autoUpdate = shadows;
  LAMP_ON.value = lamps;

  if (++face === 6) {
    // Finished: it becomes the newer, the newer the older, and the older is drawn over next.
    face = 0;
    targets = [targets[2], targets[0], targets[1]];
    done++;
    PROBE_MAP.value = targets[0].texture;
    PROBE_PREV.value = (done > 1 ? targets[1] : targets[0]).texture;
    PROBE_MIX.value = 0;
    PROBE_AT.value.set(at.x, at.y, at.z, done > 1 ? 1 : 0);
    for (const f of listeners) f();
  }
  return true;
}
