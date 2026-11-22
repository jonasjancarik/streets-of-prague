// Street cameras share the same look direction across mouse, touch and controller.
export interface Eyes { yaw: number; pitch: number; still?: number; third?: boolean; onFoot?: boolean }
// 'vr': through a phone in a headset (vr.ts). The page is then drawn with WebGL, which only
// a page load can switch to (renderer.ts), so choosing it, or leaving it for good, reloads.
export type PlayerView = 'overhead' | 'first' | 'third' | 'vr';

export type CarHandling = 'classic' | 'realistic';
export interface FirstPersonOptions { handling: CarHandling; fov: number; sensitivity: number; motion: 'device' | 'steady' | 'gentle'; vrShortView: boolean }
export const firstPersonOptions: FirstPersonOptions = { fov: 55, sensitivity: 100, motion: 'device', handling: 'classic', vrShortView: false };
export function setFirstPersonOptions(pick: Partial<FirstPersonOptions>, save = true) {
  if (typeof pick.vrShortView === 'boolean') firstPersonOptions.vrShortView = pick.vrShortView;
  if (pick.handling === 'classic' || pick.handling === 'realistic') firstPersonOptions.handling = pick.handling;
  if (typeof pick.fov === 'number' && Number.isFinite(pick.fov))
    firstPersonOptions.fov = Math.round(Math.min(80, Math.max(45, pick.fov)));
  if (typeof pick.sensitivity === 'number' && Number.isFinite(pick.sensitivity))
    firstPersonOptions.sensitivity = Math.round(Math.min(200, Math.max(25, pick.sensitivity)));
  if (pick.motion === 'device' || pick.motion === 'steady' || pick.motion === 'gentle') firstPersonOptions.motion = pick.motion;
  if (save) try { localStorage.setItem('firstPersonOptions', JSON.stringify(firstPersonOptions)); } catch { /* optional */ }
}
try { setFirstPersonOptions(JSON.parse(localStorage.getItem('firstPersonOptions') || '{}') ?? {}, false); } catch { /* defaults */ }

export function lookAround(eyes: Eyes, right: number, down: number) {
  const scale = eyes.onFoot ? firstPersonOptions.sensitivity / 100 : 1;
  const turn = eyes.yaw - right * scale;
  eyes.yaw = turn - 360 * Math.floor((turn + 180) / 360);
  const limit = eyes.onFoot ? 82 : 60;
  eyes.pitch = Math.max(-limit, Math.min(limit, eyes.pitch - down * scale));
  eyes.still = 0;
}

export function initialView(params: URLSearchParams): PlayerView {
  if (params.has('vr')) return 'vr';
  if (params.has('tps')) return 'third';
  if (params.has('fps')) return 'first';
  try {
    const view = localStorage.getItem('playerView');
    if (view === 'first' || view === 'third' || view === 'vr') return view;
  } catch { /* storage is optional */ }
  return 'overhead';
}

export function savePlayerView(view: PlayerView) {
  try { localStorage.setItem('playerView', view); } catch { /* storage is optional */ }
}

// Whether this phone and browser can show VR (Chrome on Android can, through Cardboard).
let vrAnswer: Promise<boolean> | null = null;
export function vrSupported(): Promise<boolean> {
  const xr = (navigator as { xr?: { isSessionSupported(mode: string): Promise<boolean> } }).xr;
  return vrAnswer ??= xr ? xr.isSessionSupported('immersive-vr').catch(() => false) : Promise.resolve(false);
}

export function eyesFor(view: PlayerView): Eyes | null {
  return view === 'overhead' ? null : { yaw: 0, pitch: 0, third: view === 'third' };
}

// A horizontal view cone expanded by a world-space margin. The margin keeps
// long vehicles, nearby shadows/headlights and the edge of a head turn in view.
export function inStreetCone(dx: number, dy: number, forwardX: number, forwardY: number, sinHalf: number, cosHalf: number, margin: number) {
  const ahead = dx * forwardX + dy * forwardY;
  const side = Math.abs(dy * forwardX - dx * forwardY);
  return ahead >= -margin && side * cosHalf - ahead * sinHalf <= margin;
}

// One cycle per planted foot. Advance from distance actually walked, so leaning
// into a wall or turning on the spot cannot drum out steps or shake the camera.
export class WalkingGait {
  phase = 0;
  strength = 0;
  landing = 0;
  private air = 0;
  private foot = 0;

  reset() { this.phase = this.strength = this.landing = this.air = this.foot = 0; }

  advance(dt: number, metres: number, airborne: boolean) {
    if (dt <= 0) return null;
    const speed = airborne ? 0 : Math.min(8, metres / dt);
    this.strength += (Math.min(1, speed / 5) - this.strength) * (1 - Math.exp(-12 * dt));
    this.landing *= Math.exp(-13 * dt);
    if (airborne) { this.air += dt; return null; }
    if (this.air > 0.12) {
      this.landing = Math.min(0.075, this.air * 0.07);
      this.air = this.phase = 0;
      return 'land';
    }
    this.air = 0;
    if (speed < 0.12) return null;
    this.phase += speed * dt / (0.8 + 0.2 * speed);
    if (this.phase < 1) return null;
    this.phase %= 1;
    this.foot ^= 1;
    return 'step';
  }

  get rise() { return -Math.cos(this.phase * 2 * Math.PI) * this.strength * 0.025 - this.landing; }
  get sway() { return Math.sin((this.phase + this.foot) * Math.PI) * this.strength * 0.014; }
}
