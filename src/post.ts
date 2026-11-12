import type * as THREE from 'three';

// What is done to the finished picture on Ultra (webgpu/post.ts): light that spills round
// what is brighter than the screen can show (lamps, headlights, lit windows, the sun's
// glints), and the corners of the picture a little darker. It needs the scene drawn to a
// target of its own first, which is why it is Ultra's: ?post=on|off overrides the tier for
// one visit.
const asked = new URLSearchParams(globalThis.location?.search ?? '').get('post');
export const POST = {
  // Whether the tier wants it (graphics.ts).
  value: 0,
  // How dark it is (Sky.dark): at night far more of the picture glows.
  night: 0,
  // Wet ground glints more.
  wet: 0,
  get on() { return asked === 'on' || (asked !== 'off' && this.value > 0); },
};

type Draw = (scene: THREE.Scene, camera: THREE.Camera) => void;
let draw: Draw | null = null;
export const setPost = (d: Draw) => { draw = d; };

// Draws the frame through the post-processing where it's on and there is any (WebGPU);
// false where the caller should draw it plainly.
export function drawPost(scene: THREE.Scene, camera: THREE.Camera) {
  if (!draw || !POST.on) return false;
  draw(scene, camera);
  return true;
}
