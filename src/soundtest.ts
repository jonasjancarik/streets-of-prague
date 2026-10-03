import { Engine, RecordedEngine, Tyres, ENGINES, PETROL, RECORDED, SPORTY, TYRE, noiseBuffer } from './audio.ts';
import type { Drivetrain, EngineSpec, Surface } from './audio.ts';
import type { Car } from './car.ts';

// A page for listening to the engines and tyres on their own (sound-test.html, on the
// dev server only): the game's own Engine and Tyres, driven by a pedal instead of a car,
// with a slider for every number of the sound.

const CARS: Record<string, { name: string; spec: EngineSpec; vmax: number; accel: number }> = {
  kona: { name: 'Recorded petrol car', spec: RECORDED, vmax: 42, accel: 10 },
  petrol: { name: 'Most cars', spec: PETROL, vmax: 42, accel: 10 },
  threecyl: { name: 'Schade Vima', spec: ENGINES.threecyl!, vmax: 33, accel: 6 },
  diesel: { name: 'Diesel', spec: ENGINES.diesel!, vmax: 40, accel: 9 },
  van: { name: 'Van', spec: ENGINES.van!, vmax: 31, accel: 6.5 },
  v8: { name: 'V8 pickup', spec: ENGINES.v8!, vmax: 38, accel: 8 },
  moto: { name: 'Motorbike', spec: ENGINES.moto!, vmax: 48, accel: 12 },
  electric: { name: 'Electric', spec: ENGINES.electric!, vmax: 45, accel: 12 },
  sporty: { name: 'Sporty (unused)', spec: { ...PETROL, rough: 0.02, voice: SPORTY }, vmax: 55, accel: 14 },
};

// One slider: a number in the sound's settings (`i`: which one, when it's a list).
interface Field { path: string; i?: number; label: string; hint?: string; min: number; max: number; step: number }
interface Group { title: string; note?: string; fields: Field[] }
const NTH = ['', 'The note itself', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const ENGINE_GROUPS: Group[] = [
  { title: 'Loudness', fields: [
    { path: 'voice.level', i: 0, label: 'Always', min: 0, max: 0.2, step: 0.001 },
    { path: 'voice.level', i: 1, label: 'Extra with the pedal down', min: 0, max: 0.2, step: 0.001 },
    { path: 'voice.level', i: 2, label: 'Extra at high revs', min: 0, max: 0.1, step: 0.001 },
  ] },
  { title: 'Brightness', note: 'Low is muffled, as heard through a wall. High lets the buzz through.', fields: [
    { path: 'voice.tone', i: 0, label: 'Always', hint: 'Hz', min: 40, max: 800, step: 5 },
    { path: 'voice.tone', i: 1, label: 'Rising with the revs', min: 0, max: 6, step: 0.1 },
    { path: 'voice.tone', i: 2, label: 'Extra with the pedal down', hint: 'Hz', min: 0, max: 3000, step: 10 },
  ] },
  { title: 'Character', fields: [
    { path: 'voice.drive', label: 'Distortion', hint: 'clean to harsh', min: 0.1, max: 3, step: 0.05 },
    { path: 'voice.sub', label: 'Deep note underneath', hint: 'an octave below', min: 0, max: 1, step: 0.01 },
    { path: 'rough', label: 'Uneven running', hint: 'smooth to lumpy', min: 0, max: 0.05, step: 0.001 },
  ] },
  { title: 'Overtones', note: 'How much of each higher note is mixed in. More of them sounds buzzier.',
    fields: NTH.slice(1).map((label, n) => ({ path: 'voice.harmonics', i: n + 1, label, min: 0, max: 1, step: 0.01 })) },
  { title: 'Intake noise', note: 'The breathy roar of air being sucked in.', fields: [
    { path: 'voice.roar', i: 0, label: 'Always', min: 0, max: 0.2, step: 0.001 },
    { path: 'voice.roar', i: 1, label: 'Extra with the pedal down', min: 0, max: 0.5, step: 0.005 },
    { path: 'voice.roar', i: 2, label: 'Pitch', hint: 'against the engine note', min: 1, max: 8, step: 0.1 },
  ] },
  { title: 'Revs and gears', fields: [
    { path: 'idle', label: 'Idle', hint: 'rpm', min: 400, max: 1600, step: 10 },
    { path: 'redline', label: 'Top revs', hint: 'rpm', min: 3000, max: 11000, step: 100 },
    { path: 'cylinders', label: 'Cylinders', hint: 'more gives a higher note', min: 1, max: 12, step: 1 },
    { path: 'voice.shift', i: 0, label: 'Shifts up when easing along', hint: 'share of the rev range', min: 0.1, max: 1, step: 0.01 },
    { path: 'voice.shift', i: 1, label: 'Shifts up with the pedal down', hint: 'share of the rev range', min: 0.1, max: 1, step: 0.01 },
    { path: 'voice.clutch', label: 'Revs rise when pulling away', hint: 'rpm', min: 0, max: 3000, step: 50 },
    { path: 'voice.blip', label: 'Blip of throttle on a downshift', hint: 'none to keen', min: 0, max: 1.5, step: 0.05 },
  ] },
];
const HUM_GROUP: Group = { title: 'Warning hum for people on foot', note: 'Electric cars must hum below 20 km/h. It fades out by 30.', fields: [
  { path: 'voice.avas', i: 0, label: 'Loudness', min: 0, max: 0.08, step: 0.001 },
  { path: 'voice.avas', i: 1, label: 'Pitch standing still', hint: 'Hz', min: 80, max: 800, step: 5 },
  { path: 'voice.avas', i: 2, label: 'Pulse', hint: 'steady to throbbing', min: 0, max: 1, step: 0.05 },
] };
// A recorded engine has no overtones or intake to set, and its filter works higher up.
const RECORDED_GROUPS: Group[] = [
  { title: 'Loudness', fields: [
    { path: 'voice.level', i: 0, label: 'Always', min: 0, max: 0.6, step: 0.005 },
    { path: 'voice.level', i: 1, label: 'Extra with the pedal down', min: 0, max: 0.6, step: 0.005 },
    { path: 'voice.level', i: 2, label: 'Extra at high revs', min: 0, max: 0.6, step: 0.005 },
  ] },
  { title: 'Brightness', note: 'Low is muffled, as heard through a wall. High is the recording as it is.', fields: [
    { path: 'voice.tone', i: 0, label: 'Always', hint: 'Hz', min: 100, max: 8000, step: 50 },
    { path: 'voice.tone', i: 1, label: 'Rising with the revs', min: 0, max: 100, step: 1 },
    { path: 'voice.tone', i: 2, label: 'Extra with the pedal down', hint: 'Hz', min: 0, max: 12000, step: 100 },
  ] },
  ENGINE_GROUPS[5],
];
const TYRE_GROUPS: Group[] = [
  { title: 'Road noise', note: 'Heard on every road.', fields: [
    { path: 'level', label: 'Loudness', hint: 'at 108 km/h', min: 0, max: 0.5, step: 0.005 },
    { path: 'power', label: 'Grows with speed', hint: 'evenly to only when fast', min: 0.5, max: 3, step: 0.05 },
    { path: 'tone', i: 0, label: 'Brightness', hint: 'Hz', min: 50, max: 800, step: 5 },
    { path: 'tone', i: 1, label: 'Brighter when faster', min: 0, max: 60, step: 1 },
    { path: 'texture', label: 'Wavering', hint: 'steady to restless', min: 0, max: 1, step: 0.01 },
  ] },
  { title: 'Stones', note: 'The rumble on setts and paving stones. Choose one of them under Road.', fields: [
    { path: 'rumble', label: 'Loudness', min: 0, max: 1.5, step: 0.01 },
    { path: 'rumbleTone', i: 0, label: 'Brightness', hint: 'Hz', min: 40, max: 300, step: 5 },
    { path: 'rumbleTone', i: 1, label: 'Brighter when faster', min: 0, max: 20, step: 0.5 },
    { path: 'rumbleTone', i: 2, label: 'Boom', hint: 'flat to ringing', min: 0.3, max: 5, step: 0.1 },
  ] },
];
const TYRE_WAS = structuredClone(TYRE);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string) => +$<HTMLInputElement>(id).value;
const car = { forwardSpeed: 0, speed: 0, vx: 0, vy: 0, h: 0, two: false, spec: { vmax: 42 } };
let key = 'kona', spec: EngineSpec = structuredClone(CARS[key].spec);
const clips: Record<string, AudioBuffer> = {};
let ctx: AudioContext | null = null, engine: Drivetrain | null = null, tyres: Tyres | null = null;
let noise: AudioBuffer, engineBus: GainNode, tyreBus: GainNode;
let problem = ''; // what to say when the engine can't be started
let gas = false, brake = false, dragging = false; // dragging: the speed is being set by hand

function start() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    // As in the game: every sound through the master volume and one compressor.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp).connect(ctx.destination);
    engineBus = ctx.createGain();
    tyreBus = ctx.createGain();
    engineBus.connect(master);
    tyreBus.connect(master);
    noise = noiseBuffer(ctx);
    tyres = new Tyres(ctx, noise, tyreBus);
    Object.assign(window, { __sound: { ctx, engineBus, tyreBus, get engine() { return engine; } } }); // for measuring from the console
  }
  ctx.resume();
  if (!engine) rebuild();
}

function rebuild() {
  if (!ctx) return;
  engine?.stop();
  engine = null;
  problem = '';
  const names = (spec.voice.loops ?? []).map(([name]) => name), built = spec;
  if (!names.length) { engine = new Engine(ctx, noise, engineBus, car as unknown as Car, spec); return; }
  // A recorded engine starts once its recordings are in.
  Promise.all(names.filter((n) => !clips[n]).map(async (n) => {
    const r = await fetch(`audio/${n}.wav`);
    if (!r.ok) throw new Error(`${n}: ${r.status}`);
    clips[n] = await ctx!.decodeAudioData(await r.arrayBuffer());
  })).then(() => {
    if (spec === built && !engine) engine = new RecordedEngine(ctx!, clips, engineBus, car as unknown as Car, spec);
  }).catch((e) => {
    if (spec === built) problem = 'This car\u2019s recordings could not be loaded. Check that the dev server is running, then pick the car again.';
    console.warn(e);
  });
}

function silence() {
  engine?.stop();
  engine = null;
  ctx?.suspend();
}

const at = (root: object, path: string) => {
  const keys = path.split('.'), last = keys.pop()!;
  return [keys.reduce((o: any, k) => o[k], root), last] as [any, string];
};
const read = (root: object, f: Field): number => {
  const [o, k] = at(root, f.path);
  return (f.i === undefined ? o[k] : o[k][f.i]) ?? 0;
};
function write(root: object, f: Field, v: number) {
  const [o, k] = at(root, f.path);
  if (f.i === undefined) { o[k] = v; return; }
  while (o[k].length <= f.i) o[k].push(0);
  o[k][f.i] = v;
}
const show = (f: Field, v: number) => v.toFixed(Math.max(0, -Math.floor(Math.log10(f.step) + 1e-9)));

// The cards of sliders for `root`, each marked when it differs from `base`.
function render(box: HTMLElement, groups: Group[], root: object, base: object, changed: () => void) {
  box.textContent = '';
  for (const g of groups) {
    const card = el('div', 'card'), head = el('div', 'head'), reset = el('button', 'link', 'Reset');
    head.append(el('h3', '', g.title), reset);
    card.append(head);
    if (g.note) { const p = el('p', '', g.note); p.style.margin = '-6px 0 8px'; card.append(p); }
    const rows: (() => void)[] = [];
    for (const f of g.fields) {
      const row = el('div', 'param'), label = el('label', '', f.label), input = el('input') as HTMLInputElement;
      const out = el('output'), undo = el('button', 'undo', '↺');
      if (f.hint) label.append(el('small', '', f.hint));
      input.type = 'range';
      // A value outside the usual range (the sporty voice) still fits on its slider.
      input.min = String(Math.min(f.min, read(base, f)));
      input.max = String(Math.max(f.max, read(base, f)));
      input.step = String(f.step);
      undo.title = 'Back to the original value';
      const sync = () => {
        const v = read(root, f);
        input.value = String(v);
        out.textContent = show(f, v);
        row.classList.toggle('changed', Math.abs(v - read(base, f)) > f.step / 2);
      };
      const put = (v: number) => { write(root, f, v); sync(); changed(); showSettings(); };
      input.addEventListener('input', () => put(+input.value));
      undo.addEventListener('click', () => put(read(base, f)));
      rows.push(() => put(read(base, f)));
      sync();
      row.append(label, input, out, undo);
      card.append(row);
    }
    reset.addEventListener('click', () => rows.forEach((r) => r()));
    box.append(card);
  }
}
function el(tag: string, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function showSettings() {
  const { voice, ...rest } = spec;
  $<HTMLTextAreaElement>('out').value = `${CARS[key].name}\nvoice: ${JSON.stringify(voice)}\nengine: ${JSON.stringify(rest)}\ntyres: ${JSON.stringify(TYRE)}`;
}

function choose(k: string) {
  key = k;
  spec = structuredClone(CARS[k].spec);
  car.spec.vmax = CARS[k].vmax;
  car.forwardSpeed = car.speed = 0;
  for (const b of $('cars').children) b.classList.toggle('on', (b as HTMLElement).dataset.k === k);
  render($('engine'), spec.voice.loops ? RECORDED_GROUPS : spec.voice.avas ? [HUM_GROUP, ...ENGINE_GROUPS] : ENGINE_GROUPS, spec, CARS[k].spec, () => engine?.revoice());
  showSettings();
  if (engine) rebuild();
}

for (const [k, c] of Object.entries(CARS)) {
  const b = el('button', '', c.name);
  b.dataset.k = k;
  b.addEventListener('click', () => { choose(k); start(); });
  $('cars').append(b);
}
render($('tyre'), TYRE_GROUPS, TYRE, TYRE_WAS, () => {});

const hold = (id: string, on: (down: boolean) => void) => {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); start(); on(true); b.classList.add('on'); });
  for (const up of ['pointerup', 'pointercancel']) b.addEventListener(up, () => { on(false); b.classList.remove('on'); });
};
hold('gas', (d) => (gas = d));
hold('brake', (d) => (brake = d));
const keys = (down: boolean) => (e: KeyboardEvent) => {
  const up = e.key === 'ArrowUp' || e.key === 'w', dn = e.key === 'ArrowDown' || e.key === 's';
  if (!up && !dn) return;
  e.preventDefault();
  if (down) start();
  if (up) { gas = down; $('gas').classList.toggle('on', down); }
  else { brake = down; $('brake').classList.toggle('on', down); }
};
addEventListener('keydown', keys(true));
addEventListener('keyup', keys(false));

$('stop').addEventListener('click', silence);
$('copy').addEventListener('click', () => {
  navigator.clipboard.writeText($<HTMLTextAreaElement>('out').value);
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});
$('speed').addEventListener('input', () => { car.forwardSpeed = car.speed = num('speed') * car.spec.vmax; });
$('speed').addEventListener('pointerdown', () => { dragging = true; start(); });
addEventListener('pointerup', () => { dragging = false; });

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const c = CARS[key], pedal = num('pedal');
  // Standing still, the game's brake is reverse: here it does nothing.
  const throttle = brake ? (car.forwardSpeed > 0.5 ? -pedal : 0) : gas ? pedal : 0;
  // Roughly how the game's cars pick up speed, coast and brake.
  let v = car.forwardSpeed;
  if (throttle > 0) v += throttle * c.accel * (1 - v / c.vmax) * dt;
  if (!gas && !dragging) v -= (0.4 + v * 0.03) * dt;
  if (brake) v -= 15 * pedal * dt;
  car.forwardSpeed = car.speed = v = Math.max(0, Math.min(c.vmax, v));
  if (engine && ctx?.state === 'running') {
    engine.update(dt, throttle);
    engineBus.gain.value = num('vol');
    tyreBus.gain.value = num('tyreVol');
    tyres!.update(car as unknown as Car, $<HTMLSelectElement>('tyres').value as Surface);
    $('dash').textContent = `${Math.round(engine.rpm / 10) * 10} rpm`;
    const pips = $('gears');
    if (pips.children.length !== spec.gears.length) pips.replaceChildren(...spec.gears.map((_, i) => el('b', '', String(i + 1))));
    [...pips.children].forEach((b, i) => b.classList.toggle('on', i === engine!.gear));
    $('revs').style.width = `${Math.min(100, (engine.rpm / spec.redline) * 100)}%`;
  } else {
    $('dash').textContent = problem || (ctx?.state === 'running' && !engine ? 'Loading the recordings…' : 'Pick a car to start the sound');
    $('revs').style.width = '0';
    $('gears').replaceChildren();
  }
  if (!dragging) $<HTMLInputElement>('speed').value = String(v / c.vmax);
  $('kmh').textContent = String(Math.round(v * 3.6));
  $('speedOut').textContent = `${Math.round(v * 3.6)} km/h`;
  for (const id of ['pedal', 'vol', 'tyreVol']) $(`${id}Out`).textContent = `${Math.round(num(id) * 100)} %`;
  requestAnimationFrame(frame);
}
choose(key);
requestAnimationFrame(frame);
