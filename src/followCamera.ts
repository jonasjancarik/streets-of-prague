import * as THREE from 'three';
import { shoulderFraming } from './streetView.ts';

// The street views' cameras that follow you from behind: the chase camera behind a car or
// the helicopter (in first and third person alike) and, on foot in third person, the
// camera over your shoulder.
//
// Everything here eases with critically damped springs. A spring like that reaches its
// target without overshooting, starts and stops gently instead of jumping into motion,
// and comes out the same at 20 frames a second as at 120 (moving a fixed share of the
// way each frame, as the camera used to, eases faster on a slow phone than on a desktop).

const turnOf = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A value easing towards a target; `omega` is how briskly (about 4/omega s to settle). */
export class Spring {
  x = 0;
  v = 0;
  omega: number;
  constructor(omega: number) { this.omega = omega; }
  reset(x: number) { this.x = x; this.v = 0; }
  // (The closed-form step of a critically damped spring, Game Programming Gems 4, 1.10.)
  to(target: number, dt: number, omega = this.omega) {
    if (dt <= 0) return this.x;
    const k = omega * dt, e = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
    const change = this.x - target, temp = (this.v + omega * change) * dt;
    this.v = (this.v - omega * temp) * e;
    this.x = target + (change + temp) * e;
    return this.x;
  }
  /** The same for an angle: the short way round. */
  turn(target: number, dt: number, omega = this.omega) { return this.to(this.x + turnOf(this.x, target), dt, omega); }
}

export interface Followed { x: number; y: number; h: number; vx: number; vy: number }
export interface ChaseOptions {
  ground: number; // the road under the vehicle (the helicopter: its height)
  len: number; tall: number; car: boolean;
  forwardSpeed: number;
  slide: boolean; // whether the car has the street handling, which lets it slide
  yaw: number; pitch: number; // looking round, in radians
  blocked?: (x: number, y: number) => boolean; // a wall between the vehicle and the camera
}
export interface FootOptions {
  base: number; // eye height: the ground, what you stand on, 1.75 m
  yaw: number; pitch: number;
  blocked?: (x: number, y: number) => boolean;
}

// Driving: how far behind and above the car (metres), and how the view widens with speed.
const CAR_BACK = 5.5, CAR_UP = 1.9, HELI_BACK = 10, HELI_UP = 4;
const FOV = 55, FOV_FAST = 7, STRETCH = 1.2; // up to 7° wider and 1.2 m further back by 100 km/h
// On foot: a few metres back, a little above the head and a little to the right of it.
const FOOT_BACK = 3.6, SHOULDER = 0.35;

export class FollowCamera {
  readonly position = new THREE.Vector3(); // in three.js's axes (y up, z south)
  readonly target = new THREE.Vector3();
  fov = FOV;
  private chased: Followed | null = null;
  private mode: 'chase' | 'foot' | null = null;
  // The chase camera's heading, the height it rides at and how far back it hangs.
  private heading = new Spring(5);
  private height = new Spring(7);
  private reach = new Spring(3);
  private wide = new Spring(2);
  private slip = 0;
  private lastX = 0;
  private lastY = 0;
  // On foot: the height (kerbs and steps eased out) and the distance a wall lets it keep.
  private footHeight = new Spring(10);
  private footBack = new Spring(5);
  private shoulder = new Spring(5);
  // Changing between the two (getting in or out), the old view blends into the new one.
  private fromPos = new THREE.Vector3();
  private fromTarget = new THREE.Vector3();
  private blend = 0;
  private lookYaw = new Spring(6);
  private lookPitch = new Spring(6);

  /** Leave the street view (from above, the free camera, first person on foot). */
  rest() { this.mode = null; this.chased = null; this.blend = 0; }

  /** Driving, let go of the mouse and the view swings back behind the vehicle: soon, and
   * smoothly, starting slowly rather than at full speed. (Degrees, as in `Eyes`.) */
  recentre(eyes: { yaw: number; pitch: number; still?: number }, dt: number) {
    eyes.still = (eyes.still ?? 1) + dt;
    if (eyes.still <= 0.4) { this.lookYaw.reset(eyes.yaw); this.lookPitch.reset(eyes.pitch); return; }
    // (Picked up from where looking round left the view, in case it changed meanwhile.)
    if (this.lookYaw.x !== eyes.yaw) this.lookYaw.reset(eyes.yaw);
    if (this.lookPitch.x !== eyes.pitch) this.lookPitch.reset(eyes.pitch);
    eyes.yaw = Math.abs(eyes.yaw) < 0.05 ? 0 : this.lookYaw.to(0, dt);
    eyes.pitch = Math.abs(eyes.pitch) < 0.05 ? 0 : this.lookPitch.to(0, dt);
    if (!eyes.yaw) this.lookYaw.reset(0);
    if (!eyes.pitch) this.lookPitch.reset(0);
  }

  private begin(mode: 'chase' | 'foot', camera: THREE.Camera) {
    if (this.mode === mode) return false;
    // (Getting in or out, from where the camera was; from any other view, a clean start.)
    if (this.mode) {
      this.fromPos.copy(camera.position);
      camera.getWorldDirection(this.fromTarget).multiplyScalar(8).add(camera.position);
      this.blend = 1;
    } else this.blend = 0;
    this.mode = mode;
    return true;
  }

  chase(dt: number, v: Followed, o: ChaseOptions, camera: THREE.Camera) {
    const moved = Math.hypot(v.x - this.lastX, v.y - this.lastY);
    this.lastX = v.x; this.lastY = v.y;
    const fresh = this.begin('chase', camera) || this.chased !== v || moved > 30;
    const speed = Math.hypot(v.vx, v.vy);
    // In a slide, the car turns across the view with the road ahead still in sight. (It
    // fades in from walking pace, so starting off or stopping doesn't flick the view.)
    const sliding = o.slide ? THREE.MathUtils.smoothstep(o.forwardSpeed, 2, 5) : 0;
    const slip = sliding > 0 ? clamp(turnOf(v.h, Math.atan2(v.vy, v.vx)), -.85, .85) * sliding : 0;
    const back0 = o.len / 2 + (o.car ? CAR_BACK : HELI_BACK);
    if (fresh) {
      // (A new vehicle, or after a teleport, starts straight behind it.)
      this.chased = v;
      this.heading.reset(v.h);
      this.height.reset(o.ground);
      this.reach.reset(back0);
      this.wide.reset(0);
      this.slip = slip;
    }
    // A jump in height (a lift, a teleport, a ramp onto another level) isn't eased.
    if (Math.abs(o.ground - this.height.x) > 5) this.height.reset(o.ground);
    this.slip += (slip - this.slip) * (1 - Math.exp(-6 * dt));
    // It swings round after the car as it turns, a little faster the faster you go, so the
    // car doesn't twist far across the picture in a fast bend.
    const h = this.heading.turn(v.h + .55 * this.slip, dt, 5 + clamp(speed / 10, 0, 2.5));
    this.height.to(o.ground, dt);
    const fast = o.car ? clamp(speed / 28, 0, 1) : 0;
    this.wide.to(fast, dt);
    const up = o.tall + (o.car ? CAR_UP : HELI_UP);
    let back = back0 + STRETCH * this.wide.x;
    const aim = h + o.yaw;
    const ca = Math.cos(aim), sa = Math.sin(aim);
    // A wall behind the car brings the camera in at once; it eases back out afterwards.
    if (o.blocked) {
      for (let d = o.len / 2 + 0.5; d <= back; d += 0.5) {
        if (o.blocked(v.x - ca * d, v.y - sa * d)) { back = Math.max(o.len / 2 + 1, d - 0.8); break; }
      }
    }
    if (back < this.reach.x) this.reach.reset(back);
    else this.reach.to(back, dt);
    back = this.reach.x;
    const z = this.height.x;
    this.position.set(v.x - ca * back, z + up, -(v.y - sa * back));
    // Looking over the roof at the road a little ahead, and a little further into a bend
    // than the camera has turned yet, so you see where the road goes. (By how fast the
    // camera itself is turning, which is smooth; the car's own heading twitches.)
    const into = clamp(this.heading.v * 0.12, -.3, .3);
    const look = aim + into;
    this.target.set(v.x + Math.cos(look) * o.len, z + o.tall * 0.5 + Math.tan(o.pitch) * (back + o.len), -(v.y + Math.sin(look) * o.len));
    this.fov = FOV + FOV_FAST * this.wide.x;
    this.apply(dt, camera);
  }

  foot(dt: number, me: { x: number; y: number; h: number }, o: FootOptions, camera: THREE.Camera) {
    const fresh = this.begin('foot', camera);
    this.chased = null;
    if (fresh) { this.footHeight.reset(o.base); this.footBack.reset(FOOT_BACK); this.shoulder.reset(SHOULDER); }
    if (Math.abs(o.base - this.footHeight.x) > 3) this.footHeight.reset(o.base);
    const aim = me.h + o.yaw, ca = Math.cos(aim), sa = Math.sin(aim);
    // A wall behind you brings the camera in at once (it mustn't look through it); when
    // you step away it eases back out instead of jumping.
    let back = FOOT_BACK, side = SHOULDER;
    if (o.blocked) {
      for (let d = 0.3; d <= FOOT_BACK; d += 0.1) {
        if (o.blocked(me.x - ca * d, me.y - sa * d)) { back = Math.max(0.6, d - 0.4); break; }
      }
      // (And a wall on your right keeps it behind your head.)
      if (o.blocked(me.x - ca * back + sa * (SHOULDER + .3), me.y - sa * back - ca * (SHOULDER + .3))) side = 0;
    }
    if (back < this.footBack.x) this.footBack.reset(back);
    else this.footBack.to(back, dt);
    back = this.footBack.x;
    side = this.shoulder.to(side * clamp(back / FOOT_BACK, 0, 1), dt);
    const z = this.footHeight.to(o.base, dt);
    const up = shoulderFraming.rise(back);
    // (Right of the way you face: one side of you is the shoulder the camera looks over.)
    const sx = sa * side, sy = -ca * side;
    this.position.set(me.x - ca * back + sx, z + up, -(me.y - sa * back + sy));
    const ahead = shoulderFraming.ahead;
    this.target.set(me.x + ca * ahead + sx, z - shoulderFraming.drop + Math.tan(o.pitch) * (back + ahead), -(me.y + sa * ahead + sy));
    this.fov = FOV;
    this.apply(dt, camera);
  }

  private apply(dt: number, camera: THREE.Camera) {
    if (this.blend > 0) {
      // Half a second from the old view to the new, easing in and out.
      this.blend = Math.max(0, this.blend - dt / 0.5);
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      if (this.fromPos.distanceToSquared(this.position) > 30 ** 2) this.blend = 0; // a teleport: cut
      else {
        this.position.lerp(this.fromPos, k);
        this.target.lerp(this.fromTarget, k);
      }
    }
    camera.position.copy(this.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.target);
  }
}
