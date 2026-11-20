// Street cameras share the same look direction across mouse, touch and controller.
export interface Eyes { yaw: number; pitch: number; still?: number; third?: boolean }
export type PlayerView = 'overhead' | 'first' | 'third';

export function lookAround(eyes: Eyes, right: number, down: number) {
  const turn = eyes.yaw - right;
  eyes.yaw = turn - 360 * Math.floor((turn + 180) / 360);
  eyes.pitch = Math.max(-60, Math.min(60, eyes.pitch - down));
  eyes.still = 0;
}

export function initialView(params: URLSearchParams): PlayerView {
  if (params.has('tps')) return 'third';
  if (params.has('fps')) return 'first';
  try {
    const view = localStorage.getItem('playerView');
    if (view === 'first' || view === 'third') return view;
  } catch { /* storage is optional */ }
  return 'overhead';
}

export function eyesFor(view: PlayerView): Eyes | null {
  return view === 'overhead' ? null : { yaw: 0, pitch: 0, third: view === 'third' };
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
