import { clamp } from './network.ts';
import { onLang, t } from './i18n.ts';
import type { Car } from './car.ts';
import type { Chopper } from './helicopter.ts';

export interface TouchState {
  active: boolean; move: number; turn: number; aim: { h: number; mag: number } | null;
  brake: boolean; run: boolean; fast: boolean;
  update(options: { car: Car | Chopper | null; driving?: boolean; tram?: boolean; wait?: boolean; label?: string | null; canEnter: boolean; limit?: number | null }): void;
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

const RANGE = 48; // px of thumb travel for a full push
const DEAD = 0.12;

// Keep getting a finger's moves after it slides off the control it started on.
const capture = (el: HTMLElement, e: PointerEvent) => { try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ } };
const dead = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

export function setupTouch({ action, backOnRoad, zoomBy, horn, steal, force }: {
  action: () => void; backOnRoad: () => void; zoomBy: (factor: number) => void;
  horn: (on: boolean) => void; steal: () => void; force: boolean;
}): TouchState {
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing touch control: ${id}`);
    return el;
  };
  // `aim` (on foot): { h, mag }, the way the stick points in world terms and how far.
  const state: TouchState = { active: false, move: 0, turn: 0, aim: null, brake: false, run: false, fast: false, update: () => {} };
  let inCar: Car | Chopper | null = null, assistOn = false;

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

  const toggle = $('t-toggle');
  tap(toggle, () => { assistOn = !assistOn; });
  tap($('t-action'), action);
  tap($('t-road'), backOnRoad);
  tap($('t-steal'), steal);
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

  // ---- Per frame -----------------------------------------------------------
  const shown: Record<string, string | boolean> = {};
  onLang(() => { for (const k of Object.keys(shown)) delete shown[k]; });
  const set = <T extends string | boolean>(key: string, value: T, apply: (value: T) => void) => { if (shown[key] !== value) { shown[key] = value; apply(value); } };
  // `tram`: riding one; `wait`: at a stop; `label`: what the main button does, when it
  // isn't getting in or out of a car; `limit`: the speed lane assist is keeping to.
  state.update = ({ car, driving = false, tram = false, wait = false, label = null, canEnter, limit = null }) => {
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
    const mode = inCar ? 'car' : driving ? 'drive' : tram ? 'tram' : wait ? 'stop' : 'foot';
    set('mode', mode, (m) => {
      $('touch').dataset.mode = m;
      fastUp();
      fast.textContent = m === 'stop' ? t('Hold to wait') : t('Hold to speed up');
    });
    set('horn', mode === 'drive', (drive) => { hornButton.textContent = t(drive ? 'Bell' : 'Horn'); });
    set('label', label || (mode === 'car' || mode === 'drive' ? 'Get out' : 'Get in'), (text) => { $('t-action').textContent = t(text); });
    set('toggle', state.run, (on) => toggle.classList.toggle('on', on));
    set('limit', state.run && limit ? `Lane assist · ${limit}` : 'Lane assist', (text) => { toggle.textContent = text.replace('Lane assist', t('Lane assist')); });
    set('action', !!(inCar || driving || tram || canEnter), (v) => $('t-action').classList.toggle('off', !v));
  };
  return state;
}
