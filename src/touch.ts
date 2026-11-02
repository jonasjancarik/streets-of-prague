import { clamp } from './network.ts';
import { onLang, t } from './i18n.ts';
import { turnOf } from './assist.ts';
import type { Car } from './car.ts';
import type { Chopper } from './helicopter.ts';

export interface TouchState {
  active: boolean; move: number; turn: number; aim: { h: number; mag: number } | null;
  brake: boolean; run: boolean; fast: boolean;
  update(options: { car: Car | Chopper | null; engine?: boolean; driving?: boolean; tram?: boolean; steal?: boolean; wait?: boolean; label?: string | null; canEnter: boolean; limit?: number | null }): void;
}

// On-screen controls for phones and tablets. They appear on touch screens (or with
// ?touch) and feed the same controls as the keyboard: the left thumb has a round
// stick, the right one the pedals and the buttons. Two fingers on the map zoom.
//
// The stick points where you want to go on screen: on foot you turn and walk that
// way (a full push runs); in the car you steer that way while the pedals set the speed.
// Put a thumb down away from the stick and the stick moves under it. Lane assist
// sits above the stick, since with it on the stick picks the next turn instead. The
// pedals are one surface, so a thumb can roll from gas to brake without lifting.
//
// Or, chosen in the settings, the stick alone drives a car, for one hand: how far you
// push is the gas, and pointing back against the way the car goes brakes, then backs
// up swinging the nose round to the stick and drives off that way (stickOnly). Letting
// go coasts. The pedals are hidden; the handbrake and the other buttons stay.

const RANGE = 48; // px of thumb travel for a full push
const DEAD = 0.12;
// Stick-only driving: pointing further than this from the way the car goes is "back".
// Going forward it takes a clear pull back (120°); reversing, anything ahead of 60° is
// forward again, so the car doesn't flick between the two along the edge.
const BACK_GOING = 2.1, BACK_REVERSING = 1.05;

export type TouchDrive = 'pedals' | 'stick';
let drive: TouchDrive = 'pedals';
try { if (localStorage.getItem('touchDrive') === 'stick') drive = 'stick'; } catch { /* not saved */ }
export const touchDrive = () => drive;
export function setTouchDrive(d: TouchDrive) {
  drive = d;
  try { localStorage.setItem('touchDrive', d); } catch { /* not saved */ }
  document.getElementById('touch')?.setAttribute('data-drive', d);
}

// Stick-only driving: the gas and the way to steer for a car, from where the stick
// points (also used by the test kit's t.thumb).
export function stickOnly(car: Car, aim: { h: number; mag: number }) {
  const reversing = car.forwardSpeed < -0.3;
  const back = Math.abs(turnOf(car.h, aim.h)) > (reversing ? BACK_REVERSING : BACK_GOING);
  // The stick points where you want to go, so backing up the nose swings round
  // toward it until the car can drive off forward (aimSteer turns the back of a
  // reversing car toward the aim, so it gets the opposite way). Were the back to
  // follow the stick, the car would go wherever you point, tail first, never
  // faster than its reverse. Braking while still going forward, the same aim
  // steers straight: a pull straight back brakes in a line before the car turns.
  return { move: back ? -aim.mag : aim.mag, aim: back || reversing ? { h: aim.h + Math.PI, mag: aim.mag } : aim };
}

// Keep getting a finger's moves after it slides off the control it started on.
const capture = (el: HTMLElement, e: PointerEvent) => { try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ } };
const dead = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

export function setupTouch({ action, backOnRoad, zoomBy, horn, steal, cannon, shoot, doors, jump, force }: {
  action: () => void; backOnRoad: () => void; zoomBy: (factor: number) => void;
  horn: (on: boolean) => void; steal: () => void; cannon: (on: boolean) => void; shoot: (on: boolean) => void; doors: () => void; jump: () => void; force: boolean;
}): TouchState {
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing touch control: ${id}`);
    return el;
  };
  // `aim` (on foot): { h, mag }, the way the stick points in world terms and how far.
  const state: TouchState = { active: false, move: 0, turn: 0, aim: null, brake: false, run: false, fast: false, update: () => {} };
  let inCar: Car | Chopper | null = null, assistOn = false;
  $('touch').dataset.drive = drive;

  const activate = () => {
    if (state.active) return;
    state.active = true;
    document.body.classList.add('touch');
  };
  if (force || matchMedia('(pointer: coarse)').matches) activate();
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') activate(); }, { capture: true });
  window.addEventListener('contextmenu', (e) => { if (state.active) e.preventDefault(); });

  // ---- Stick -------------------------------------------------------------
  const pad = $('t-steer'), stick = $('t-stick'), knob = $('t-knob');
  let stickId: number | null = null, ox = 0, oy = 0;
  const push = { x: 0, y: 0 }; // -1..1, y up
  const stickEnd = (e: PointerEvent) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    push.x = push.y = 0;
    stick.classList.remove('held');
    stick.style.transform = knob.style.transform = '';
  };
  const stickMove = (e: PointerEvent) => {
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const d = Math.hypot(dx, dy);
    if (d > RANGE) { dx *= RANGE / d; dy *= RANGE / d; }
    push.x = dx / RANGE;
    push.y = -dy / RANGE;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  pad.addEventListener('pointerdown', (e) => {
    if (stickId !== null) return;
    e.preventDefault();
    stickId = e.pointerId;
    capture(pad, e);
    const r = stick.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.top + r.height / 2;
    if (Math.hypot(e.clientX - ox, e.clientY - oy) > r.width / 2) {
      stick.style.transform = `translate(${e.clientX - ox}px, ${e.clientY - oy}px)`;
      ox = e.clientX;
      oy = e.clientY;
    }
    stick.classList.add('held');
    stickMove(e);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
  pad.addEventListener('pointerup', stickEnd);
  pad.addEventListener('pointercancel', stickEnd);
  pad.addEventListener('lostpointercapture', stickEnd);

// ---- Pedals ------------------------------------------------------------
  const pedals = $('t-pedals'), gas = $('t-gas'), brake = $('t-brake');
  const onPedal = new Map<number, number>(); // pointerId → 1 (gas), -1 (brake) or 0
  const within = (el: HTMLElement, e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const pedalsChanged = () => {
    const v = [...onPedal.values()];
    const g = v.includes(1), b = v.includes(-1);
    state.move = (g ? 1 : 0) - (b ? 1 : 0);
    gas.classList.toggle('down', g);
    brake.classList.toggle('down', b);
  };
  const pedalAt = (e: PointerEvent) => {
    onPedal.set(e.pointerId, within(gas, e) ? 1 : within(brake, e) ? -1 : 0);
    pedalsChanged();
  };
  pedals.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(pedals, e);
    pedalAt(e);
  });
  pedals.addEventListener('pointermove', (e) => { if (onPedal.has(e.pointerId)) pedalAt(e); });
  const pedalUp = (e: PointerEvent) => { onPedal.delete(e.pointerId); pedalsChanged(); };
  pedals.addEventListener('pointerup', pedalUp);
  pedals.addEventListener('pointercancel', pedalUp);
  // The pedals vanish when you leave the vehicle (a fall, say) while a thumb is still on
  // one, and the browser may never say that thumb lifted: let go of them ourselves.
  pedals.addEventListener('lostpointercapture', pedalUp);
  const releasePedals = () => { onPedal.clear(); pedalsChanged(); };

  // ---- Buttons -----------------------------------------------------------
  const tap = (el: HTMLElement, fn: () => void) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  const hand = $('t-hand');
  const handUp = () => { state.brake = false; hand.classList.remove('down'); };
  hand.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(hand, e);
    state.brake = true;
    hand.classList.add('down');
  });
  hand.addEventListener('pointerup', handUp);
  hand.addEventListener('pointercancel', handUp);
  hand.addEventListener('lostpointercapture', handUp);

  // On a tram, or at a stop waiting for one: hold to speed things up.
  const fast = $('t-fast');
  const fastUp = () => { state.fast = false; fast.classList.remove('down'); };
  fast.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(fast, e);
    state.fast = true;
    fast.classList.add('down');
  });
  fast.addEventListener('pointerup', fastUp);
  fast.addEventListener('pointercancel', fastUp);
  fast.addEventListener('lostpointercapture', fastUp);

  const toggle = $('t-toggle');
  tap(toggle, () => { assistOn = !assistOn; });
  tap($('t-action'), action);
  tap($('t-jump'), jump);
  tap($('t-road'), backOnRoad);
  tap($('t-steal'), steal);
  tap($('t-doors'), doors);
  // The water cannon of a fire engine sprays for as long as it's held.
  const cannonButton = $('t-cannon');
  const cannonUp = () => { cannon(false); cannonButton.classList.remove('down'); };
  cannonButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(cannonButton, e);
    cannon(true);
    cannonButton.classList.add('down');
  });
  cannonButton.addEventListener('pointerup', cannonUp);
  cannonButton.addEventListener('pointercancel', cannonUp);
  cannonButton.addEventListener('lostpointercapture', cannonUp);
  // The pistol fires again and again for as long as it's held, at the car ahead if there is one.
  const shootButton = $('t-shoot');
  const shootUp = () => { shoot(false); shootButton.classList.remove('down'); };
  shootButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(shootButton, e);
    shoot(true);
    shootButton.classList.add('down');
  });
  shootButton.addEventListener('pointerup', shootUp);
  shootButton.addEventListener('pointercancel', shootUp);
  shootButton.addEventListener('lostpointercapture', shootUp);
  // The horn (a tram's bell) sounds for as long as it's held.
  const hornButton = $('t-horn');
  const hornUp = () => { horn(false); hornButton.classList.remove('down'); };
  hornButton.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(hornButton, e);
    horn(true);
    hornButton.classList.add('down');
  });
  hornButton.addEventListener('pointerup', hornUp);
  hornButton.addEventListener('pointercancel', hornUp);
  hornButton.addEventListener('lostpointercapture', hornUp);

  // ---- Pinch to zoom -----------------------------------------------------
  const app = $('app'), fingers = new Map<number, { x: number; y: number }>();
  let spread = 0;
  const span = () => { const [a, b] = fingers.values(); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  app.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) spread = span();
  });
  app.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size !== 2) return;
    const s = span();
    if (spread > 0 && s > 0) zoomBy(spread / s);
    spread = s;
  });
  const lift = (e: PointerEvent) => { fingers.delete(e.pointerId); spread = fingers.size === 2 ? span() : 0; };
  app.addEventListener('pointerup', lift);
  app.addEventListener('pointercancel', lift);

  // Switching apps can swallow the pointer-up event. Nothing should stay held
  // when the player returns, including a pinch begun before the switch.
  const releaseAll = () => {
    stickId = null;
    push.x = push.y = 0;
    state.aim = null;
    stick.classList.remove('held');
    stick.style.transform = knob.style.transform = '';
    releasePedals();
    handUp();
    fastUp();
    hornUp();
    cannonUp();
    shootUp();
    fingers.clear();
    spread = 0;
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  // ---- Per frame -----------------------------------------------------------
  const shown: Record<string, string | boolean> = {};
  onLang(() => { for (const k of Object.keys(shown)) delete shown[k]; });
  const set = <T extends string | boolean>(key: string, value: T, apply: (value: T) => void) => { if (shown[key] !== value) { shown[key] = value; apply(value); } };
  // `tram`: riding one (or a taxi, funicular or ferry); `steal`: on a tram, which can be
  // taken over; `wait`: at a stop; `label`: what the main button does, when it isn't
  // getting in or out of a car; `limit`: the speed lane assist is keeping to.
  state.update = ({ car, engine = false, driving = false, tram = false, steal = false, wait = false, label = null, canEnter, limit = null }) => {
    if (!state.active) return;
    if (car !== inCar) {
      // Lane assist starts off in every car you take.
      if (car) assistOn = false;
      inCar = car;
    }
    // The stick points: screen up is north, the way the map is drawn.
    const mag = Math.min(1, Math.hypot(push.x, push.y));
    state.aim = mag > DEAD ? { h: Math.atan2(push.y, push.x), mag: dead(mag) } : null;
    state.run = !!inCar && assistOn;
    if (inCar && drive === 'stick') {
      if (!state.aim) state.move = 0;
      else if (!('forwardSpeed' in inCar)) state.move = state.aim.mag; // the helicopter flies the way it's pointed
      else Object.assign(state, stickOnly(inCar, state.aim));
    }
    const mode = inCar ? 'car' : driving ? 'drive' : tram ? 'tram' : wait ? 'stop' : 'foot';
    set('mode', mode, (m) => {
      $('touch').dataset.mode = m;
      fastUp();
      handUp();
      releasePedals();
      fast.textContent = m === 'stop' ? t('Hold to wait') : t('Hold to speed up');
    });
    set('horn', mode === 'drive', (drive) => { hornButton.textContent = t(drive ? 'Bell' : 'Horn'); });
    set('label', label || (mode === 'car' || mode === 'drive' ? 'Get out' : 'Get in'), (text) => { $('t-action').textContent = t(text); });
    set('engine', engine, (on) => { cannonButton.hidden = !on; if (!on) cannonUp(); });
    set('steal', steal, (on) => { $('t-steal').hidden = !on; });
    set('toggle', state.run, (on) => toggle.classList.toggle('on', on));
    set('limit', state.run && limit ? `Lane assist · ${limit}` : 'Lane assist', (text) => { toggle.textContent = text.replace('Lane assist', t('Lane assist')); });
    set('action', !!(inCar || driving || tram || canEnter), (v) => $('t-action').classList.toggle('off', !v));
  };
  return state;
}
