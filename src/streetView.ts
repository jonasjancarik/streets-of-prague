// Street cameras share the same look direction across mouse, touch and controller.
export interface Eyes { yaw: number; pitch: number; still?: number; third?: boolean; onFoot?: boolean }
// At full distance the camera sees the player's feet. When a wall brings it
// in to shoulder distance, lower the lens with it so the head stays in view.
export const shoulderFraming = {
  ahead: 4,
  drop: .55,
  rise(back: number) {
    const t = Math.max(0, Math.min(1, (back - .6) / 3));
    return .035 + .79 * t * t * (3 - 2 * t);
  },
};
// 'vr': through a phone in a headset (vr.ts). The page is then drawn with WebGL, which only
// a page load can switch to (renderer.ts), so choosing it, or leaving it for good, reloads.
export type PlayerView = 'overhead' | 'first' | 'third' | 'vr';

export type CarHandling = 'classic' | 'realistic' | 'physical';
export interface FirstPersonOptions { handling: CarHandling; fov: number; sensitivity: number; motion: 'device' | 'steady' | 'gentle'; vrShortView: boolean }
export const firstPersonOptions: FirstPersonOptions = { fov: 55, sensitivity: 100, motion: 'device', handling: 'physical', vrShortView: false };
export function setFirstPersonOptions(pick: Partial<FirstPersonOptions>, save = true) {
  if (typeof pick.vrShortView === 'boolean') firstPersonOptions.vrShortView = pick.vrShortView;
  // (The handling of all three street views at once, as scenarios set it: setCarHandling.)
  if (isHandling(pick.handling)) for (const view of ['first', 'third', 'vr'] as const) setCarHandling(view, pick.handling, save);
  if (typeof pick.fov === 'number' && Number.isFinite(pick.fov))
    firstPersonOptions.fov = Math.round(Math.min(80, Math.max(45, pick.fov)));
  if (typeof pick.sensitivity === 'number' && Number.isFinite(pick.sensitivity))
    firstPersonOptions.sensitivity = Math.round(Math.min(200, Math.max(25, pick.sensitivity)));
  if (pick.motion === 'device' || pick.motion === 'steady' || pick.motion === 'gentle') firstPersonOptions.motion = pick.motion;
  if (save) try { const { handling: _, ...rest } = firstPersonOptions; localStorage.setItem('firstPersonOptions', JSON.stringify(rest)); } catch { /* optional */ }
}
// The car handling of each view (Settings → Car handling sets the one you're in): Classic
// from above, Physical in the street. (`firstPersonOptions.handling` is first person's.)
export const carHandling: Record<PlayerView, CarHandling> = { overhead: 'classic', first: 'physical', third: 'physical', vr: 'physical' };
const isHandling = (h: unknown): h is CarHandling => h === 'classic' || h === 'realistic' || h === 'physical';
export function setCarHandling(view: PlayerView, handling: CarHandling, save = true) {
  carHandling[view] = handling;
  if (view === 'first') firstPersonOptions.handling = handling;
  if (save) try { localStorage.setItem(`${HANDLING_KEY}.${view}`, handling); } catch { /* optional */ }
}
// Each view's handling is kept under a key of its own, saved only when picked. Before each
// view had its own, one pick (`carHandling`) served the three street views, and stands
// for them until they're picked again. (Until Realistic became the default, every saved
// set of options held 'classic', picked or not, so that old copy is left unread.)
const HANDLING_KEY = 'carHandling';
try {
  const { handling: _, ...rest } = (JSON.parse(localStorage.getItem('firstPersonOptions') || '{}') ?? {}) as Partial<FirstPersonOptions>;
  setFirstPersonOptions(rest, false);
  const street = localStorage.getItem(HANDLING_KEY);
  for (const view of Object.keys(carHandling) as PlayerView[]) {
    const own = localStorage.getItem(`${HANDLING_KEY}.${view}`) ?? (view === 'overhead' ? null : street);
    if (isHandling(own)) setCarHandling(view, own, false);
  }
} catch { /* defaults */ }

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
