import type * as THREE from 'three';

// What is done to the finished picture on High and Ultra (webgpu/post.ts): light that spills round
// what is brighter than the screen can show (lamps, headlights, lit windows, the sun's
// glints), and the corners of the picture a little darker. It needs the scene drawn to a
// target of its own first. ?post=on|off overrides the tier for one visit.
const asked = new URLSearchParams(globalThis.location?.search ?? '').get('post');
export const POST = {
  // Whether the tier wants it (graphics.ts).
  value: 0,
  // How dark it is (Sky.dark): at night far more of the picture glows.
  night: 0,
  // Wet ground glints more.
  wet: 0,
  // A trial (?ao): ambient shading from the picture's depth (webgpu/post.ts).
  ao: new URLSearchParams(globalThis.location?.search ?? '').has('ao'),
  // Motion blur while driving, seen from the street: how much of it (0 below 30 km/h, 1 from
  // about 100), and the player's vehicle, which keeps sharp (its middle and reach, in the scene's
  // coordinates; a reach below 0 for none).
  blur: 0,
  // Which way and how fast that vehicle goes (m/s, in the scene's coordinates): the camera goes with it.
  going: [0, 0, 0] as [number, number, number],
  car: [0, 0, 0, -1] as [number, number, number, number],
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

// The player's choice (Settings): some people feel sick with motion blur.
let blurOn = true;
try { blurOn = localStorage.getItem('motionBlur') !== 'off'; } catch { /* no storage: stay on */ }
// (?motionblur=off for one visit, to compare; =full is its full strength at any speed, to time it.)
const blurAsked = new URLSearchParams(globalThis.location?.search ?? '').get('motionblur');
export const motionBlurOn = () => blurOn && blurAsked !== 'off';
export const motionBlurFull = blurAsked === 'full';
export function setMotionBlur(enabled: boolean) {
  blurOn = enabled;
  try { localStorage.setItem('motionBlur', enabled ? 'on' : 'off'); } catch { /* not saved */ }
}
