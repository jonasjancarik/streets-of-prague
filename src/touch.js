import { clamp } from './network.js';

// On-screen controls for phones and tablets. They appear on touch screens (or with
// ?touch) and feed the same controls as the keyboard: the left thumb steers, the
// right one works the pedals and the buttons. Two fingers on the map zoom.
//
// Steering is a floating stick: put a thumb down anywhere in the lower left and slide
// it sideways; how far you slide is how hard you steer. The pedals are one surface, so
// a thumb can roll from gas to brake without lifting.

const STEER_RANGE = 55; // px of thumb travel for full lock
const DEAD = 0.1;

// Keep getting a finger's moves after it slides off the control it started on.
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ } };

export function setupTouch({ action, backOnRoad, zoomBy, force }) {
  const $ = (id) => document.getElementById(id);
  const state = { active: false, move: 0, turn: 0, brake: false, run: false };
  let inCar = null, assistOn = false, runOn = false;

  const activate = () => {
    if (state.active) return;
    state.active = true;
    document.body.classList.add('touch');
  };
  if (force || matchMedia('(pointer: coarse)').matches) activate();
  addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') activate(); }, { capture: true });
  addEventListener('contextmenu', (e) => { if (state.active) e.preventDefault(); });

  // ---- Steering ----------------------------------------------------------
  const pad = $('t-steer'), stick = $('t-stick'), knob = $('t-knob');
  let steerId = null, x0 = 0;
  const steerEnd = (e) => {
    if (e.pointerId !== steerId) return;
    steerId = null;
    state.turn = 0;
    stick.classList.remove('held');
    stick.style.transform = knob.style.transform = '';
  };
  pad.addEventListener('pointerdown', (e) => {
    if (steerId !== null) return;
    e.preventDefault();
    steerId = e.pointerId;
    capture(pad, e);
    x0 = e.clientX;
    const r = stick.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    stick.style.transform = `translate(${dx}px, ${dy}px)`;
    stick.classList.add('held');
  });
  pad.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steerId) return;
    const d = clamp((e.clientX - x0) / STEER_RANGE, -1, 1);
    // Left is positive, as with the A key.
    state.turn = Math.abs(d) < DEAD ? 0 : -Math.sign(d) * (Math.abs(d) - DEAD) / (1 - DEAD);
    knob.style.transform = `translateX(${d * STEER_RANGE}px)`;
  });
  pad.addEventListener('pointerup', steerEnd);
  pad.addEventListener('pointercancel', steerEnd);

  // ---- Pedals ------------------------------------------------------------
  const pedals = $('t-pedals'), gas = $('t-gas'), brake = $('t-brake');
  const onPedal = new Map(); // pointerId → 1 (gas), -1 (brake) or 0
  const within = (el, e) => {
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
  const pedalAt = (e) => {
    onPedal.set(e.pointerId, within(gas, e) ? 1 : within(brake, e) ? -1 : 0);
    pedalsChanged();
  };
  pedals.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    capture(pedals, e);
    pedalAt(e);
  });
  pedals.addEventListener('pointermove', (e) => { if (onPedal.has(e.pointerId)) pedalAt(e); });
  const pedalUp = (e) => { onPedal.delete(e.pointerId); pedalsChanged(); };
  pedals.addEventListener('pointerup', pedalUp);
  pedals.addEventListener('pointercancel', pedalUp);

  // ---- Buttons -----------------------------------------------------------
  const tap = (el, fn) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
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

  const toggle = $('t-toggle');
  tap(toggle, () => { if (inCar) assistOn = !assistOn; else runOn = !runOn; });
  tap($('t-action'), action);
  tap($('t-road'), backOnRoad);

  // ---- Pinch to zoom -----------------------------------------------------
  const app = $('app'), fingers = new Map();
  let spread = 0;
  const span = () => { const [a, b] = fingers.values(); return Math.hypot(a.x - b.x, a.y - b.y); };
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
  const lift = (e) => { fingers.delete(e.pointerId); spread = fingers.size === 2 ? span() : 0; };
  app.addEventListener('pointerup', lift);
  app.addEventListener('pointercancel', lift);

  // ---- Per frame -----------------------------------------------------------
  const shown = {};
  const set = (key, value, apply) => { if (shown[key] !== value) { shown[key] = value; apply(value); } };
  state.update = ({ car, canEnter, tripped }) => {
    if (!state.active) return;
    if (car !== inCar) {
      // Lane assist starts off in every car you take.
      if (car) assistOn = false;
      inCar = car;
    }
    state.run = inCar ? assistOn : runOn;
    const mode = inCar ? 'car' : 'foot';
    set('mode', mode, (m) => {
      $('touch').dataset.mode = m;
      gas.textContent = m === 'car' ? 'Gas' : 'Walk';
      brake.textContent = m === 'car' ? 'Brake' : 'Back';
      $('t-action').textContent = m === 'car' ? 'Get out' : 'Get in';
      toggle.textContent = m === 'car' ? 'Lane assist' : 'Run';
    });
    set('toggle', state.run, (on) => toggle.classList.toggle('on', on));
    set('tripped', !!(inCar && assistOn && tripped), (t) => toggle.classList.toggle('tripped', t));
    set('action', !!(inCar || canEnter), (v) => $('t-action').classList.toggle('off', !v));
  };
  return state;
}
