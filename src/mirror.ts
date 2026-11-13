// What the wet streets mirror (the "Full mirror" setting, Graphics.reflections): the scene drawn once more, at half the screen's
// resolution, from the camera reflected in the ground under the view (a plane at camGround,
// clipped there, as three.js's Reflector does). Only what stands up out of the street is
// drawn (objects marked `mirrored`: buildings and walls, trees, lamps, cars and trams); the
// ground, the weather and everything else is left out. The puddles read it in the ground's
// shader (shading.ts, webgpu.ts) where it covers their mirror of the sky, and add lamp heads
// and lit windows on top. Drawn only while the ground is wet.

import * as THREE from 'three';

export const MIRROR_LAYER = 3;
// The tier allows it (Graphics), and whether it was drawn for this frame (the shaders read that).
export const MIRROR_ON = { value: 0 };
export const MIRROR = { value: 0 };
// The map's x and z to the mirror texture's uv.
export const MIRROR_MATRIX = { value: new THREE.Matrix4() };
export const MIRROR_TARGET = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: true });
export const MIRROR_MAP = { value: MIRROR_TARGET.texture };
// How much of what's mirrored a puddle shows: as much as of the sky (SKY_REF is 0.06 of the
// sky's light), so trees and cars are dark against it. Lights are far brighter than the
// game's colours can say, so at night (with the lamps on) what's brighter than BRIGHT[0]
// shows BRIGHT[1] times more on top: the lamp heads, headlights and lit windows.
export const MIRROR_K = { value: 0.06 };
export const MIRROR_BRIGHT = { value: new THREE.Vector2(0.3, 0.5) };

export const mirrored = <T extends THREE.Object3D>(o: T) => { o.layers.enable(MIRROR_LAYER); return o; };
// A flat glow facing up, added to what's there: seen from below in the mirror, and added to
// the colour only, so that the mirror's alpha still says where something solid covers the sky.
export function mirroredGlow(o: THREE.Mesh) {
  mirrored(o);
  Object.assign(o.material as THREE.Material, {
    side: THREE.DoubleSide, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
}

const cam = new THREE.PerspectiveCamera();
cam.layers.set(MIRROR_LAYER);
const normal = new THREE.Vector3(0, 1, 0), point = new THREE.Vector3(), eye = new THREE.Vector3(), look = new THREE.Vector3();
const rotation = new THREE.Matrix4(), plane = new THREE.Plane(), clip = new THREE.Vector4(), q = new THREE.Vector4();
const size = new THREE.Vector2(), clearColour = new THREE.Color();

// Before the frame's own render, which then needn't bring the matrices up to date again
// (it returns whether it drew).
export function renderMirror(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, ground: number, wet: number) {
  MIRROR.value = MIRROR_ON.value > 0 && wet > 0.02 ? 1 : 0;
  if (!MIRROR.value) return false;
  const gpu = (renderer as unknown as { coordinateSystem: number }).coordinateSystem === THREE.WebGPUCoordinateSystem;
  renderer.getDrawingBufferSize(size);
  const w = Math.max(1, Math.round(size.x / 2)), h = Math.max(1, Math.round(size.y / 2));
  if (MIRROR_TARGET.width !== w || MIRROR_TARGET.height !== h) MIRROR_TARGET.setSize(w, h);

  // The camera reflected in the plane, looking at the reflection of what it looks at.
  point.set(0, ground, 0);
  eye.setFromMatrixPosition(camera.matrixWorld);
  rotation.extractRotation(camera.matrixWorld);
  look.set(0, 0, -1).applyMatrix4(rotation).add(eye);
  eye.y = 2 * ground - eye.y;
  look.y = 2 * ground - look.y;
  cam.coordinateSystem = camera.coordinateSystem;
  cam.position.copy(eye);
  cam.up.set(0, 1, 0).applyMatrix4(rotation).reflect(normal);
  cam.lookAt(look);
  cam.near = camera.near;
  cam.far = camera.far;
  cam.updateMatrixWorld();
  cam.projectionMatrix.copy(camera.projectionMatrix);
  // Where a point of the world falls in the texture (WebGPU's textures start at the top).
  MIRROR_MATRIX.value.set(0.5, 0, 0, 0.5, 0, gpu ? -0.5 : 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
    .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  // Nothing under the plane (Lengyel's oblique near plane).
  plane.setFromNormalAndCoplanarPoint(normal, point).applyMatrix4(cam.matrixWorldInverse);
  clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
  const p = cam.projectionMatrix.elements;
  q.set((Math.sign(clip.x) + p[8]) / p[0], (Math.sign(clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
  clip.multiplyScalar((gpu ? 1 : 2) / clip.dot(q));
  p[2] = clip.x; p[6] = clip.y; p[10] = gpu ? clip.z : clip.z + 1; p[14] = clip.w;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

  const before = renderer.getRenderTarget(), clear = renderer.getClearColor(clearColour).getHex(), alpha = renderer.getClearAlpha();
  const shadows = renderer.shadowMap.autoUpdate, background = scene.background;
  renderer.shadowMap.autoUpdate = false;
  // (And no sky, webgpu/dome.ts: what shows no scenery must stay empty, for the made-up sky to fill.)
  const sky = (scene as { backgroundNode?: unknown }).backgroundNode;
  (scene as { backgroundNode?: unknown }).backgroundNode = null;
  scene.background = null;
  // Put everything back even when the render throws (a lost GPU device).
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(MIRROR_TARGET);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
  } finally {
    renderer.setRenderTarget(before);
    renderer.setClearColor(clear, alpha);
    scene.background = background;
    (scene as { backgroundNode?: unknown }).backgroundNode = sky;
    renderer.shadowMap.autoUpdate = shadows;
  }
  return true;
}
