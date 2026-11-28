import type * as THREE from 'three';

// What is done to the finished picture on High and Ultra (webgpu/post.ts): light that spills round
// what is brighter than the screen can show (lamps, headlights, lit windows, the sun's
// glints), and the corners of the picture a little darker. It needs the scene drawn to a
// target of its own first. ?post=on|off overrides the tier for one visit.
const query = new URLSearchParams(globalThis.location?.search ?? '');
const asked = query.get('post');
// ?ao (or ?ao=on) and ?ao=off override the tier's ambient shading for one visit.
const aoAsked = query.has('ao') ? (query.get('ao') === 'off' ? 'off' : 'on') : null;
export const POST = {
  // Whether the tier wants it (graphics.ts).
  value: 0,
  // How dark it is (Sky.dark): at night far more of the picture glows.
  night: 0,
  // Wet ground glints more.
  wet: 0,
  // Whether the tier wants ambient shading from the picture's depth (graphics.ts: Ultra).
  aoValue: false,
  // Ambient shading from the picture's depth (webgpu/post.ts), with the post-processing.
  get ao() { return aoAsked === 'on' || (aoAsked !== 'off' && this.aoValue); },
  // Motion blur while driving, seen from the street: how much of it (0 below about 20 km/h, 1 from
  // about 60).
  blur: 0,
  // Which way and how fast that vehicle goes (m/s, in the scene's coordinates): the camera goes with it.
  going: [0, 0, 0] as [number, number, number],
  // The player's vehicle, which keeps sharp: its middle (in the scene's coordinates; a last
  // value below 0 for none), and its half length, width and height with its heading (radians).
  car: [0, 0, 0, -1] as [number, number, number, number],
  box: [0, 0, 0, 0] as [number, number, number, number],
  // The nearest other vehicles under way (up to OTHERS): each is smeared by how it moves
  // against the camera, so a police car on your tail at your speed stays as sharp as yours.
  // Each is its middle, its half length, width and height with its heading, and its
  // velocity (m/s), in the scene's coordinates as above.
  others: [] as { mid: [number, number, number]; box: [number, number, number, number]; going: [number, number, number] }[],
  get on() { return asked === 'on' || (asked !== 'off' && this.value > 0); },
};

export const OTHERS = 4;

type Draw = (scene: THREE.Scene, camera: THREE.Camera) => void;
let draw: Draw | null = null, target: () => THREE.RenderTarget | null = () => null;
export const setPost = (d: Draw, sceneTarget?: () => THREE.RenderTarget | null) => { draw = d; if (sceneTarget) target = sceneTarget; };

// The target the scene is drawn into before the post-processing, while that's on (null
// where the scene is drawn straight to the screen, or nothing has been drawn through it
// yet): shaders compiled ahead have to be for it (main.ts, warmStreetView).
export const postTarget = () => (draw && POST.on ? target() : null);

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
// How strong the blur is, for trying it out (dev panel, Driving): 1 is the game as it ships;
// 2 smears twice as far.
export const BLUR_TUNE = { strength: 1 };
// How dark the corners get, as a multiple of what the game ships with (dev.ts).
export const VIGNETTE_TUNE = { strength: 1 };
export function setMotionBlur(enabled: boolean) {
  blurOn = enabled;
  try { localStorage.setItem('motionBlur', enabled ? 'on' : 'off'); } catch { /* not saved */ }
}
