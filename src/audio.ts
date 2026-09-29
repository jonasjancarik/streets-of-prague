import { clamp } from './network.ts';
import { BOGIES, frontOf } from './trams.ts';
import { AMBIENCE, ambienceGains } from './soundmix.ts';
import { Radio, radioOn, setRadioSaved } from './radio.ts';
import type { Station } from './radio.ts';
import type { Car } from './car.ts';
import type { TramVehicle } from './trams.ts';

// Sound, with the Web Audio API. The engine of whatever you're driving is made here
// (its note follows the revs through the gears), and so are its tyres (a hiss on
// asphalt, a rumble over setts, a squeal in a slide). The trams near you are
// recordings of Prague trams (public/audio, cut by pipeline/build_audio.py): their
// rumble, the motors' whine, the wheels squealing in tight curves, pulling away from a
// stop and pulling in, and the bell when something's on the track; the bogies clicking
// over rail joints are made here, and so is the weather: rain hissing and pattering,
// the tyres louder in the wet, thunder after lightning, a wind while it snows. Under it
// all, the city's own sound, from recordings too: crowds where the streets are busy,
// traffic in the distance by day and a low hum by night, and birds where it's quiet
// (see Ambience and src/soundmix.ts). Browsers only start sound after a key press or
// a tap; M turns it off and on.

export type Surface = 'asphalt' | 'setts' | 'pavers' | 'pavement';

// How an engine sounds: the overtones of its note, the sub-octave under it, how hard
// it's driven into distortion, the filter over it (`tone`: base + per Hz of the note +
// with the pedal down), the intake's roar (base, pedal down, pitch in notes), how loud
// (base, pedal down, share of the redline), where it shifts up (a share of the rev
// range: easing along, pedal down) and how far the clutch lets the revs rise pulling
// away.
interface EngineVoice {
  harmonics: number[]; sub: number; drive: number; tone: [number, number, number];
  roar: [number, number, number]; level: [number, number, number]; shift: [number, number]; clutch: number;
}
interface EngineSpec { idle: number; redline: number; cylinders: number; gears: number[]; rough: number; voice: EngineVoice }
// An everyday car heard from outside: a quiet, smooth hum under the tyres, a little
// fuller with the pedal down, shifting up early as in town. No sub-octave and no
// intake: between them they make an engine lope and splutter.
const EVERYDAY: EngineVoice = {
  harmonics: [0, 1, 0.25, 0.06, 0.02], sub: 0, drive: 0.3, tone: [120, 1.2, 200],
  roar: [0, 0, 3], level: [0.03, 0.012, 0.01], shift: [0.28, 0.5], clutch: 1100,
};
// A tuned sports car: a buzzing note over a deep sub-octave, uneven firing, the
// intake roaring and every gear taken nearly to the redline. Not on any car yet;
// meant for faster ones (use with `rough` about 0.02).
export const SPORTY: EngineVoice = {
  harmonics: [0, 1, 0.75, 0.45, 0.55, 0.25, 0.3, 0.15, 0.18, 0.08, 0.1, 0.05, 0.06], sub: 0.6, drive: 2.2,
  tone: [250, 3, 2200], roar: [0.05, 0.35, 4], level: [0.2, 0.14, 0.06], shift: [0.92, 0.92], clutch: 2200,
};
// A turbo diesel: a fuller, lower note with a bit of clatter, shifting up early.
const DIESEL: EngineVoice = {
  harmonics: [0, 1, 0.55, 0.3, 0.12, 0.05], sub: 0, drive: 0.6, tone: [110, 1.4, 220],
  roar: [0.005, 0.02, 3], level: [0.035, 0.014, 0.01], shift: [0.2, 0.4], clutch: 800,
};
// An electric motor: a thin whine that rises with speed, silent when standing, a single
// gear (so no shifts) and no clutch or irregular firing.
const ELECTRIC_VOICE: EngineVoice = {
  harmonics: [0, 1, 0, 0.25, 0, 0.08], sub: 0, drive: 0.2, tone: [300, 2, 500],
  roar: [0, 0, 3], level: [0, 0.01, 0.022], shift: [1, 1], clutch: 0,
};
const ELECTRIC: EngineSpec = { idle: 600, redline: 9000, cylinders: 8, gears: [1.02], rough: 0, voice: ELECTRIC_VOICE };
// A big V8 pickup: low and burbling, taken easy.
const V8_VOICE: EngineVoice = {
  harmonics: [0, 1, 0.6, 0.35, 0.15, 0.06], sub: 0.35, drive: 1, tone: [140, 1.6, 300],
  roar: [0.01, 0.06, 3], level: [0.05, 0.03, 0.015], shift: [0.3, 0.55], clutch: 1200,
};
const PETROL: EngineSpec = { idle: 850, redline: 6200, cylinders: 4, gears: [0.18, 0.33, 0.5, 0.72, 1.02], rough: 0.006, voice: EVERYDAY };
const ENGINES: Record<string, EngineSpec | null> = {
  // By variant (see VARIANTS in car.ts), before the type.
  model3: ELECTRIC,
  modely: ELECTRIC,
  enyaq: ELECTRIC,
  f150: { idle: 650, redline: 5500, cylinders: 8, gears: [0.16, 0.28, 0.42, 0.58, 0.78, 1.02], rough: 0.015, voice: V8_VOICE },
  fabia: { idle: 900, redline: 5500, cylinders: 3, gears: [0.18, 0.33, 0.5, 0.72, 1.02], rough: 0.02, voice: EVERYDAY },
  octavia: { idle: 800, redline: 4500, cylinders: 4, gears: [0.16, 0.3, 0.46, 0.68, 1.02], rough: 0.012, voice: DIESEL },
  van: { idle: 750, redline: 4200, cylinders: 4, gears: [0.2, 0.38, 0.58, 0.8, 1.02], rough: 0.02, voice: EVERYDAY },
  moto: { idle: 1300, redline: 10500, cylinders: 2, gears: [0.14, 0.26, 0.4, 0.55, 0.75, 1.02], rough: 0.025, voice: EVERYDAY },
  bike: null,
};
// How much each surface rumbles, and how far apart its bumps are (m).
const SURFACES: Record<Surface, { rumble: number; spacing: number }> = {
  asphalt: { rumble: 0, spacing: 1 },
  setts: { rumble: 1, spacing: 0.14 },
  pavers: { rumble: 0.45, spacing: 0.2 },
  pavement: { rumble: 0.6, spacing: 0.5 },
};
const SETTS = new Set(['sett', 'cobblestone', 'unhewn_cobblestone']);
export const surfaceOf = (tag: string | undefined | null): Surface => (SETTS.has(tag ?? '') ? 'setts' : tag === 'paving_stones' ? 'pavers' : 'asphalt');

const TRAM_VOICES = 4, TRAM_RANGE = 170; // the nearest trams you can hear, as far as this (m)
const JOINT = 24; // m between the rail joints
const SMOOTH = 0.06; // s: how quickly a sound follows what it's following
const LOOPS = ['roll', 'motor', 'squeal'], ONCE = ['bell-1', 'bell-2', 'bell-3', 'depart-1', 'depart-2', 'arrive'];
const MOTOR_SPEED = 12; // m/s at which the recorded whine plays at its own pitch
const BRAKE = 1.2; // m/s²: a tram braking for a stop (as in trams.ts)

export interface SoundState {
  x: number; y: number; // where you are
  car: Car | null; throttle: number; surface: Surface;
  trams: TramVehicle[];
  quiet: boolean; // in the metro
  rain?: number; wet?: number; snow?: number; // the weather, 0–1 each (weather.ts)
  strikes?: number; // lightning so far: each new one thunders a moment later
  busy?: number; // how busy the streets around you are, 0 (the edge of town) to 1 (the Old Town)
  hour?: number; // the time of day, in hours (13.5 is half past one)
}

export class Sound {
  ctx: AudioContext | null = null;
  on: boolean;
  master!: GainNode;
  noise!: AudioBuffer;
  clack!: AudioBuffer;
  clips: Record<string, AudioBuffer> = {};
  engine: Engine | null = null;
  tyres: Tyres | null = null;
  weather: WeatherSound | null = null;
  ambience: Ambience | null = null;
  radio: Radio | null = null;
  onRadioFail: (station: Station) => void = () => {};
  private strikes = -1;
  voices: TramVoice[] = [];

  constructor() {
    let saved = '';
    try { saved = localStorage.getItem('sound') ?? ''; } catch {}
    this.on = saved !== 'off';
    const start = () => {
      this.start();
      if (this.ctx?.state === 'running') for (const k of ['keydown', 'pointerdown'] as const) removeEventListener(k, start);
    };
    for (const k of ['keydown', 'pointerdown'] as const) addEventListener(k, start);
    // The game stops in a hidden tab, so the sound does too.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.on) this.ctx.resume();
    });
  }

  // The car radio, on or off; works before the sound has started (a browser only allows it after a key press).
  get radioOn() { return this.radio ? !!this.radio.station : radioOn(); }
  setRadio(on: boolean) {
    if (this.radio) this.radio.set(on);
    else setRadioSaved(on);
  }

  toggle() {
    this.on = !this.on;
    try { localStorage.setItem('sound', this.on ? '' : 'off'); } catch {}
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.on ? 0.8 : 0, this.ctx.currentTime, 0.05);
    if (this.on) this.ctx.resume();
  }

  // Only once the player has pressed something (the browser's rule).
  private start() {
    if (this.ctx) { if (this.on && this.ctx.state !== 'running') this.ctx.resume(); return; }
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.8 : 0;
    this.master.connect(comp).connect(ctx.destination);
    this.noise = noiseBuffer(ctx);
    this.clack = clackBuffer(ctx);
    this.tyres = new Tyres(ctx, this.noise, this.master);
    this.weather = new WeatherSound(ctx, this.noise, this.master);
    this.radio = new Radio(ctx, this.noise, this.master);
    this.radio.onFail = (station) => this.onRadioFail(station);
    // The trams are heard once their recordings are in.
    Promise.all([...LOOPS, ...ONCE].map(async (name) => {
      const r = await fetch(`audio/${name}.${LOOPS.includes(name) ? 'wav' : 'm4a'}`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      this.clips[name] = await ctx.decodeAudioData(await r.arrayBuffer());
    })).then(() => {
      for (let i = 0; i < TRAM_VOICES; i++) this.voices.push(new TramVoice(this, this.master));
    }).catch((e) => console.warn('The tram sounds could not be loaded', e));
    // And the city around you, once its recordings are in.
    Promise.all(Object.keys(AMBIENCE).map(async (name) => {
      const r = await fetch(`audio/amb-${name}.m4a`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return [name, await ctx.decodeAudioData(await r.arrayBuffer())] as const;
    })).then((clips) => {
      this.ambience = new Ambience(ctx, Object.fromEntries(clips), this.master);
    }).catch((e) => console.warn('The city sounds could not be loaded', e));
  }

  // One of the clips whose names start with `name`, at random.
  pick(name: string) {
    const all = ONCE.filter((n) => n.startsWith(name));
    return this.clips[all[Math.floor(Math.random() * all.length)]];
  }

  update(dt: number, s: SoundState) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) { this.radio?.update(false); return; }
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(s.quiet ? 0 : 0.8, t, 0.2);

    // Your engine: a new one each time you get in, faded out when you get out.
    const car = s.car;
    if (this.engine && this.engine.car !== car) { this.engine.stop(); this.engine = null; }
    if (car && !this.engine) {
      const id = car.variant && car.variant.id in ENGINES ? car.variant.id : car.type;
      const spec = id in ENGINES ? ENGINES[id] : PETROL;
      if (spec) this.engine = new Engine(ctx, this.noise, this.master, car, spec);
    }
    this.engine?.update(dt, s.throttle);
    this.radio?.update(!!car && !car.two && !s.quiet);
    this.tyres!.update(car, s.surface, s.wet ?? 0);
    this.weather!.update(s.rain ?? 0, s.snow ?? 0);
    this.ambience?.update(s.busy ?? 0.5, s.hour ?? 12, Math.max(s.rain ?? 0, s.snow ?? 0));
    if (s.strikes !== undefined) {
      if (this.strikes >= 0 && s.strikes > this.strikes) this.weather!.thunder(t + 0.6 + Math.random() * 3.5);
      this.strikes = s.strikes;
    }

    // The nearest trams, each keeping its voice while it's among them.
    const near: { v: TramVehicle; d: number; dx: number }[] = [];
    for (const v of s.trams) {
      let d = Infinity, dx = 0;
      for (const p of v.parts) {
        const e = Math.hypot(p.x - s.x, p.y - s.y);
        if (e < d) { d = e; dx = p.x - s.x; }
      }
      if (d < TRAM_RANGE) near.push({ v, d, dx });
    }
    near.sort((a, b) => a.d - b.d);
    near.length = Math.min(near.length, TRAM_VOICES);
    for (const voice of this.voices) if (voice.v && !near.some((n) => n.v === voice.v)) voice.release();
    for (const n of near) {
      const voice = this.voices.find((x) => x.v === n.v) ?? this.voices.find((x) => !x.v);
      voice?.update(dt, n.v, n.d, n.dx);
    }
  }

  // A gunshot d m away, dx of it to the east: a crack with a thump under it, and its
  // echo off the houses a moment later.
  shot(d: number, dx: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) return;
    const t = ctx.currentTime, loud = 20 / (20 + d), pan = ctx.createStereoPanner();
    pan.pan.value = clamp(dx / 45, -0.85, 0.85);
    pan.connect(this.master);
    for (const [at, level, top] of [[0, 1, 6000 - Math.min(d, 200) * 22], [0.07 + Math.random() * 0.1, 0.25, 1400]]) {
      const src = loop(ctx, this.noise, 0.9 + Math.random() * 0.3), lp = filter(ctx, 'lowpass', top), g = gain(ctx, 0);
      g.gain.setValueAtTime(loud * level, t + at);
      g.gain.exponentialRampToValueAtTime(0.0005, t + at + 0.22);
      src.connect(lp).connect(g).connect(pan);
      src.start(t + at, Math.random() * 1.5);
      src.stop(t + at + 0.25);
    }
    const thump = ctx.createOscillator(), g = gain(ctx, 0);
    thump.frequency.setValueAtTime(140, t);
    thump.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(loud * 0.8, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.15);
    thump.connect(g).connect(pan);
    thump.start(t);
    thump.stop(t + 0.16);
  }

  // A car blowing up d m away, dx of it to the east: a deep bang, and a roar that
  // rumbles on for a second or two.
  boom(d: number, dx: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) return;
    const t = ctx.currentTime, loud = 40 / (40 + d), pan = ctx.createStereoPanner();
    pan.pan.value = clamp(dx / 45, -0.85, 0.85);
    pan.connect(this.master);
    const src = loop(ctx, this.noise, 0.6), lp = filter(ctx, 'lowpass', 2400 - Math.min(d, 300) * 6), g = gain(ctx, 0);
    lp.frequency.setTargetAtTime(160, t + 0.05, 0.4);
    g.gain.setValueAtTime(loud * 1.3, t);
    g.gain.setTargetAtTime(loud * 0.5, t + 0.08, 0.15);
    g.gain.setTargetAtTime(0, t + 0.5, 0.6);
    src.connect(lp).connect(g).connect(pan);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 4);
    const thump = ctx.createOscillator(), tg = gain(ctx, 0);
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(28, t + 0.5);
    tg.gain.setValueAtTime(loud * 1.2, t);
    tg.gain.exponentialRampToValueAtTime(0.0005, t + 0.6);
    thump.connect(tg).connect(pan);
    thump.start(t);
    thump.stop(t + 0.65);
  }

  play(buffer: AudioBuffer, at: number, gain: number, out: AudioNode, rate = 1) {
    const ctx = this.ctx!;
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(out);
    src.start(Math.max(at, ctx.currentTime));
  }
}

// Near to far: loud to quiet, and to the side it's on (the view looks down on the map,
// so east is to the right).
function place(gain: GainNode, pan: StereoPannerNode, d: number, dx: number, t: number) {
  const g = (15 / (15 + d)) * clamp(1 - d / TRAM_RANGE, 0, 1);
  gain.gain.setTargetAtTime(g, t, 0.1);
  pan.pan.setTargetAtTime(clamp(dx / 45, -0.85, 0.85), t, 0.1);
}

// An engine's note: harmonics of the cylinders' firing rate, roughened with a little
// wobble, through a filter that opens up with the throttle; plus the intake's roar.
class Engine {
  ctx: AudioContext;
  car: Car;
  spec: EngineSpec;
  out: GainNode;
  osc: OscillatorNode; sub: OscillatorNode; wobble: AudioBufferSourceNode; intake: AudioBufferSourceNode;
  depth: GainNode; tone: BiquadFilterNode; roar: BiquadFilterNode; roarGain: GainNode;
  gear = 0; shift = 0;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode, car: Car, spec: EngineSpec) {
    this.ctx = ctx;
    this.car = car;
    this.spec = spec;
    const t = ctx.currentTime;
    const voice = spec.voice, harmonics = new Float32Array(voice.harmonics);
    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics));
    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    // Slow random wobble of the pitch: no engine fires perfectly evenly.
    this.wobble = loop(ctx, noise);
    const slow = filter(ctx, 'lowpass', 25);
    this.depth = ctx.createGain();
    this.wobble.connect(slow).connect(this.depth);
    this.depth.connect(this.osc.frequency);
    this.depth.connect(this.sub.frequency);
    const subGain = gain(ctx, voice.sub);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip(voice.drive);
    this.tone = filter(ctx, 'lowpass', 400, 0.9);
    this.out = gain(ctx, 0);
    this.osc.connect(shaper);
    this.sub.connect(subGain).connect(shaper);
    shaper.connect(this.tone).connect(this.out).connect(dest);
    this.intake = loop(ctx, noise);
    this.roar = filter(ctx, 'bandpass', 300, 1.2);
    this.roarGain = gain(ctx, 0);
    this.intake.connect(this.roar).connect(this.roarGain).connect(this.tone);
    this.osc.start(t);
    this.sub.start(t);
    this.wobble.start(t);
    this.intake.start(t);
    this.out.gain.setTargetAtTime(voice.level[0], t, 0.15);
    this.update(0, 0);
  }

  // `throttle`: -1..1 as driven, braking or reversing when it's below 0.
  update(dt: number, throttle: number) {
    const { car, spec } = this, voice = spec.voice, t = this.ctx.currentTime;
    const v = Math.abs(car.forwardSpeed), vmax = car.spec.vmax;
    const load = car.forwardSpeed < 0.5 && throttle < 0 ? -throttle : clamp(throttle, 0, 1);
    // Revs in a gear: redline at the gear's top speed. Up a gear where the voice says
    // (later with the pedal down), and down once the revs sag.
    const revs = (g: number) => spec.idle + (spec.redline - spec.idle) * clamp(v / (spec.gears[g] * vmax), 0, 1);
    const up = spec.idle + (spec.redline - spec.idle) * (voice.shift[0] + (voice.shift[1] - voice.shift[0]) * load);
    if (this.gear < spec.gears.length - 1 && revs(this.gear) > up) { this.gear++; this.shift = 0.18; }
    else if (this.gear > 0 && revs(this.gear) < spec.idle * 1.9 && revs(this.gear - 1) < up * 0.9) this.gear--;
    this.shift = Math.max(0, this.shift - dt);
    let rpm = revs(this.gear);
    // Pulling away, the clutch lets the revs rise ahead of the speed.
    if (this.gear === 0) rpm = Math.max(rpm, spec.idle + load * voice.clutch);
    const pull = this.shift > 0 ? 0.1 : load;
    const hz = ((rpm / 60) * spec.cylinders) / 2;
    this.osc.frequency.setTargetAtTime(hz, t, SMOOTH);
    this.sub.frequency.setTargetAtTime(hz / 2, t, SMOOTH);
    this.depth.gain.setTargetAtTime(hz * spec.rough, t, 0.2);
    this.tone.frequency.setTargetAtTime(voice.tone[0] + hz * voice.tone[1] + pull * voice.tone[2], t, SMOOTH);
    this.roar.frequency.setTargetAtTime(hz * voice.roar[2], t, SMOOTH);
    this.roarGain.gain.setTargetAtTime(voice.roar[0] + pull * voice.roar[1], t, SMOOTH);
    this.out.gain.setTargetAtTime(voice.level[0] + pull * voice.level[1] + (rpm / spec.redline) * voice.level[2], t, 0.1);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.08);
    for (const n of [this.osc, this.sub, this.wobble, this.intake]) n.stop(t + 0.6);
  }
}

// Tyres on the road: a hiss on asphalt, a rumble at the rate the wheels hit the stones
// on setts, and a squeal when the car slides sideways.
class Tyres {
  ctx: AudioContext;
  hiss: BiquadFilterNode; hissGain: GainNode;
  bumps: OscillatorNode; rumble: BiquadFilterNode; rumbleGain: GainNode;
  squeal: BiquadFilterNode; squealGain: GainNode;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.hiss = filter(ctx, 'lowpass', 300);
    this.hissGain = gain(ctx, 0);
    const a = loop(ctx, noise);
    a.connect(filter(ctx, 'highpass', 60)).connect(this.hiss).connect(this.hissGain).connect(dest);
    // The stones: noise switched on and off at the rate the wheels meet them.
    this.rumble = filter(ctx, 'lowpass', 200, 0.7);
    const chop = gain(ctx, 0.5);
    this.bumps = ctx.createOscillator();
    this.bumps.type = 'square';
    this.bumps.connect(gain(ctx, 0.5)).connect(chop.gain);
    this.rumbleGain = gain(ctx, 0);
    const b = loop(ctx, noise, 0.7);
    b.connect(this.rumble).connect(chop).connect(this.rumbleGain).connect(dest);
    this.squeal = filter(ctx, 'bandpass', 1900, 12);
    this.squealGain = gain(ctx, 0);
    const c = loop(ctx, noise, 1.3);
    c.connect(this.squeal).connect(filter(ctx, 'bandpass', 1900, 6)).connect(this.squealGain).connect(dest);
    for (const n of [a, b, c, this.bumps]) n.start(t);
  }

  // `wet`: how wet the road is, which makes the hiss louder and brighter.
  update(car: Car | null, surface: Surface, wet = 0) {
    const t = this.ctx.currentTime;
    const v = car ? car.speed : 0;
    const light = car?.two ? 0.35 : 1; // two narrow tyres
    const s = SURFACES[surface];
    const slip = car ? Math.abs(car.vx * Math.sin(car.h) - car.vy * Math.cos(car.h)) : 0;
    this.hiss.frequency.setTargetAtTime((250 + v * 45) * (1 + wet * 2.5), t, SMOOTH);
    this.hissGain.gain.setTargetAtTime(light * clamp(v / 30, 0, 1) * 0.3 * (1 - 0.5 * s.rumble) * (1 + wet * 1.2), t, SMOOTH);
    this.bumps.frequency.setTargetAtTime(clamp(v / s.spacing, 1, 400), t, SMOOTH);
    this.rumble.frequency.setTargetAtTime(140 + v * 12, t, SMOOTH);
    this.rumbleGain.gain.setTargetAtTime(light * s.rumble * clamp(v / 12, 0, 1) * 0.55, t, SMOOTH);
    this.squealGain.gain.setTargetAtTime(light * clamp((slip - 2.5) / 5, 0, 1) * (1 - 0.6 * s.rumble) * 0.4, t, 0.04);
  }
}

// One tram near you. It rumbles along, its motors whine as it pulls away and brakes
// (higher the faster it goes), the wheels squeal in tight curves, its bogies click over
// the rail joints one after another, and it hums standing still. Pulling away from a
// stop and pulling in are whole recordings, played as it happens (the motor and the
// rumble step back meanwhile, as they're in the recording). The driver rings the bell
// at whatever's on the track ahead.
class TramVoice {
  sound: Sound;
  ctx: AudioContext;
  v: TramVehicle | null = null;
  out: GainNode; pan: StereoPannerNode;
  motor: AudioBufferSourceNode; motorGain: GainNode;
  roll: AudioBufferSourceNode; rollGain: GainNode;
  squeal: AudioBufferSourceNode; squealGain: GainNode;
  hum: GainNode;
  lastSpeed = 0; joint = 0; bellT = 0;
  dwelling = false; halt = -1; arrived = false; clipT = 0; // (clipT: s left of a departure or arrival)

  constructor(sound: Sound, dest: AudioNode) {
    this.sound = sound;
    const ctx = (this.ctx = sound.ctx!), t = ctx.currentTime, clips = sound.clips;
    this.pan = ctx.createStereoPanner();
    this.out = gain(ctx, 0);
    this.out.connect(this.pan).connect(dest);
    // Each voice starts its loops somewhere else in them, so two trams don't sound alike.
    const start = (src: AudioBufferSourceNode) => src.start(t, Math.random() * src.buffer!.duration);
    this.roll = loop(ctx, clips.roll);
    this.rollGain = gain(ctx, 0);
    this.roll.connect(this.rollGain).connect(this.out);
    this.motor = loop(ctx, clips.motor);
    this.motorGain = gain(ctx, 0);
    this.motor.connect(this.motorGain).connect(this.out);
    this.squeal = loop(ctx, clips.squeal);
    this.squealGain = gain(ctx, 0);
    this.squeal.connect(this.squealGain).connect(this.out);
    for (const n of [this.roll, this.motor, this.squeal]) start(n);
    // Standing still, a tram still hums (its converters and fans).
    const hum = ctx.createOscillator();
    hum.frequency.value = 100;
    this.hum = gain(ctx, 0);
    hum.connect(this.hum).connect(this.out);
    hum.start(t);
  }

  // Braking for the next stop already.
  braking(v: TramVehicle) {
    const h = v.line.halts[v.halt];
    return !!h && v.line.path.ahead(frontOf(v), h.s) < (v.speed * v.speed) / (2 * BRAKE) + 4;
  }

  release() {
    this.v = null;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
  }

  update(dt: number, v: TramVehicle, d: number, dx: number) {
    const t = this.ctx.currentTime, sound = this.sound;
    if (this.v !== v) {
      this.v = v;
      this.lastSpeed = v.speed;
      this.joint = Math.floor(frontOf(v) / JOINT);
      this.bellT = 0;
      this.dwelling = v.dwell > 0;
      this.halt = v.halt;
      this.arrived = this.braking(v); // not halfway into pulling in
      this.clipT = 0;
    }
    place(this.out, this.pan, d, dx, t);
    const speed = v.speed;
    const accel = dt > 0 ? (speed - this.lastSpeed) / dt : 0;
    this.lastSpeed = speed;
    const moving = clamp(speed / 1.5, 0, 1);

    // Off from a stop, and pulling in to the next one: from where it starts braking.
    this.clipT -= dt;
    const dwelling = v.dwell > 0;
    if (this.dwelling && !dwelling) {
      const clip = sound.pick('depart');
      sound.play(clip, t, 0.8, this.out);
      this.clipT = clip?.duration ?? 0;
    }
    this.dwelling = dwelling;
    if (v.halt !== this.halt) { this.halt = v.halt; this.arrived = false; }
    if (!this.arrived && speed > 3 && this.braking(v)) {
      this.arrived = true;
      const clip = sound.clips.arrive;
      sound.play(clip, t, 0.8, this.out);
      this.clipT = clip?.duration ?? 0;
    }
    const recorded = this.clipT > 0 ? 0.35 : 1;

    this.motor.playbackRate.setTargetAtTime(clamp(speed / MOTOR_SPEED, 0.35, 1.3), t, SMOOTH);
    this.motorGain.gain.setTargetAtTime(recorded * moving * clamp(0.25 + Math.abs(accel) * 0.5, 0, 0.9), t, 0.15);
    this.roll.playbackRate.setTargetAtTime(0.75 + 0.35 * clamp(speed / 12, 0, 1), t, SMOOTH);
    this.rollGain.gain.setTargetAtTime(recorded * clamp(speed / 12, 0, 1) * 1.1, t, SMOOTH);
    this.hum.gain.setTargetAtTime(0.025, t, 0.3);
    // The curve: how far the first and last sections point apart.
    const [a, , c] = v.parts;
    const bend = Math.abs(Math.atan2(Math.sin(a.ang - c.ang), Math.cos(a.ang - c.ang)));
    this.squeal.playbackRate.setTargetAtTime(1 + Math.sin(t * 0.7) * 0.04, t, 0.1);
    this.squealGain.gain.setTargetAtTime(clamp((bend - 0.35) * 2, 0, 1) * clamp((speed - 1.5) / 3, 0, 1) * 1.2, t, 0.2);

    // A joint under the front: each bogie crosses it in turn.
    const joint = Math.floor(frontOf(v) / JOINT);
    if (joint !== this.joint) {
      this.joint = joint;
      if (speed > 1) {
        const loud = clamp(speed / 10, 0.3, 1) * 0.25;
        for (const back of BOGIES) if (back / speed < 5) sound.play(sound.clack, t + back / speed, loud, this.out, 0.9 + Math.random() * 0.2);
      }
    }

    // The bell: at you or a car on the track ahead, again every few seconds while it's there.
    this.bellT -= dt;
    // (What the driver sees can come and go from one step to the next.)
    if ((v.spotted > 0 || v.forPlayer || (!!v.blocker && speed < 1)) && this.bellT < 0) {
      sound.play(sound.pick('bell'), t, 0.7, this.out);
      this.bellT = v.forPlayer ? 2 : 4;
    }
  }
}

// The city's sound: loops that play all the time, as loud as src/soundmix.ts says for
// where you are and when. The levels change slowly, so walking from a quiet street onto
// a square the crowd comes up over a few seconds.
class Ambience {
  ctx: AudioContext;
  gains: Record<string, GainNode> = {};

  constructor(ctx: AudioContext, clips: Record<string, AudioBuffer>, dest: AudioNode) {
    this.ctx = ctx;
    for (const [name, buffer] of Object.entries(clips)) {
      const src = loop(ctx, buffer), g = gain(ctx, 0);
      src.connect(g).connect(dest);
      src.start(ctx.currentTime, Math.random() * buffer.duration);
      this.gains[name] = g;
    }
  }

  // `busy` 0–1, `hour` 0–24, `wet` how hard it rains or snows 0–1.
  update(busy: number, hour: number, wet: number) {
    const t = this.ctx.currentTime, gains = ambienceGains(busy, hour, wet);
    for (const [name, g] of Object.entries(this.gains)) g.gain.setTargetAtTime(gains[name] ?? 0, t, 2);
  }
}

// ---- Building blocks ---------------------------------------------------------

// Rain: a steady hiss, and drops pattering on the street (a loop of short clicks at
// random times); while it snows, a low wind that rises and falls.
class WeatherSound {
  ctx: AudioContext; noise: AudioBuffer; dest: AudioNode;
  hissGain: GainNode; patterGain: GainNode;
  wind: BiquadFilterNode; windGain: GainNode;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode) {
    this.ctx = ctx;
    this.noise = noise;
    this.dest = dest;
    this.hissGain = gain(ctx, 0);
    const a = loop(ctx, noise, 0.9);
    a.connect(filter(ctx, 'highpass', 500)).connect(filter(ctx, 'lowpass', 6000)).connect(this.hissGain).connect(dest);
    this.patterGain = gain(ctx, 0);
    const b = loop(ctx, patterBuffer(ctx));
    b.connect(filter(ctx, 'bandpass', 2600, 0.5)).connect(this.patterGain).connect(dest);
    this.wind = filter(ctx, 'lowpass', 380, 1.8);
    this.windGain = gain(ctx, 0);
    const c = loop(ctx, noise, 0.23);
    c.connect(this.wind).connect(this.windGain).connect(dest);
    for (const n of [a, b, c]) n.start(ctx.currentTime);
  }

  // Thunder at `at`: a crack, then a low rumble rolling on for a few seconds.
  thunder(at: number) {
    const ctx = this.ctx, src = loop(ctx, this.noise, 0.5), lp = filter(ctx, 'lowpass', 600, 0.8), g = gain(ctx, 0);
    src.connect(lp).connect(g).connect(this.dest);
    const far = Math.random();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.9 - far * 0.4, at + 0.06 + far * 0.3);
    g.gain.setTargetAtTime(0.45, at + 0.3, 0.4);
    g.gain.setTargetAtTime(0.6, at + 1.2 + Math.random(), 0.3); // a second roll
    g.gain.setTargetAtTime(0, at + 2.2, 1.1);
    lp.frequency.setValueAtTime(900 - far * 600, at);
    lp.frequency.setTargetAtTime(110, at + 0.05, 0.35);
    src.start(at);
    src.stop(at + 9);
  }

  update(rain: number, snow: number) {
    const t = this.ctx.currentTime;
    this.hissGain.gain.setTargetAtTime(rain * 0.09, t, 0.5);
    this.patterGain.gain.setTargetAtTime(rain * 0.5, t, 0.5);
    const gust = 0.6 + 0.25 * Math.sin(t * 0.31) + 0.15 * Math.sin(t * 0.83 + 1);
    this.windGain.gain.setTargetAtTime(snow * 0.22 * gust, t, 0.8);
    this.wind.frequency.setTargetAtTime(260 + 240 * gust, t, 0.8);
  }
}

const gain = (ctx: AudioContext, value: number) => {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
};
const filter = (ctx: AudioContext, type: BiquadFilterType, frequency: number, Q = 0.7) => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
};
// A buffer looped (the noise at a slightly different rate for each use, so they don't line up).
const loop = (ctx: AudioContext, buffer: AudioBuffer, rate = 1) => {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = rate;
  return src;
};
function softClip(drive: number) {
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * drive) / Math.tanh(drive);
  return curve;
}
function noiseBuffer(ctx: AudioContext) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
// Rain drops: three seconds of short ticks, some near and loud, most faint.
function patterBuffer(ctx: AudioContext) {
  const sr = ctx.sampleRate, b = ctx.createBuffer(1, sr * 3, sr), d = b.getChannelData(0);
  for (let n = 0; n < 1800; n++) {
    const at = Math.floor(Math.random() * (d.length - sr * 0.01)), loud = Math.random() ** 3;
    const decay = 900 + Math.random() * 2500;
    for (let i = 0; i < sr * 0.01; i++) d[at + i] += (Math.random() * 2 - 1) * loud * Math.exp((-i / sr) * decay);
  }
  return b;
}
// A wheel over a rail joint: a knock and a short metallic ring.
function clackBuffer(ctx: AudioContext) {
  const sr = ctx.sampleRate, b = ctx.createBuffer(1, Math.floor(sr * 0.15), sr), d = b.getChannelData(0);
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    lp += (Math.random() * 2 - 1 - lp) * 0.3;
    d[i] = lp * 0.9 * Math.exp(-t * 70) + Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t * 30) * 0.8 + Math.sin(2 * Math.PI * 1370 * t) * Math.exp(-t * 45) * 0.12;
  }
  return b;
}
