import { clamp } from './network.ts';
import { BOGIES, frontOf } from './trams.ts';
import { AMBIENCE, ambienceGains, ambienceMuffle, sirenGain, SIREN_RANGE } from './soundmix.ts';
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
// range: easing along, pedal down), how far the clutch lets the revs rise pulling
// away, and how much of a blip of throttle a downshift gets (0 none, 1 a keen driver).
export interface EngineVoice {
  harmonics: number[]; sub: number; drive: number; tone: [number, number, number];
  roar: [number, number, number]; level: [number, number, number]; shift: [number, number]; clutch: number; blip: number;
  // A recorded engine: its loops (public/audio/engine-*.wav) and how many times a second
  // the cylinders fire in each, lowest first. `tone` and `level` then shape the recording,
  // and the overtones, sub-octave, distortion and intake aren't used.
  loops?: [name: string, hz: number][];
}
export interface EngineSpec { idle: number; redline: number; cylinders: number; gears: number[]; rough: number; voice: EngineVoice }
// An everyday car heard from outside: a quiet, smooth hum under the tyres, a little
// fuller with the pedal down, shifting up early as in town. No sub-octave and no
// intake: between them they make an engine lope and splutter.
const EVERYDAY: EngineVoice = {
  harmonics: [0, 1, 0.18, 0.03], sub: 0, drive: 0.3, tone: [120, 1.2, 80],
  roar: [0, 0, 3], level: [0.014, 0.004, 0.004], shift: [0.28, 0.6], clutch: 500, blip: 0.5,
};
// A tuned sports car: a buzzing note over a deep sub-octave, uneven firing, the
// intake roaring and every gear taken nearly to the redline. Not on any car yet;
// meant for faster ones (use with `rough` about 0.02).
export const SPORTY: EngineVoice = {
  harmonics: [0, 1, 0.75, 0.45, 0.55, 0.25, 0.3, 0.15, 0.18, 0.08, 0.1, 0.05, 0.06], sub: 0.6, drive: 2.2,
  tone: [250, 3, 2200], roar: [0.05, 0.35, 4], level: [0.2, 0.14, 0.06], shift: [0.92, 0.92], clutch: 2200, blip: 1,
};
// A turbo diesel: a fuller, lower note with a bit of clatter, shifting up early.
const DIESEL: EngineVoice = {
  harmonics: [0, 1, 0.45, 0.2, 0.06], sub: 0, drive: 0.5, tone: [110, 1.4, 100],
  roar: [0.003, 0.008, 3], level: [0.018, 0.006, 0.005], shift: [0.2, 0.5], clutch: 450, blip: 0.4,
};
// A petrol car from recordings: a Hyundai Kona held at idle, about 2240 and 2910 rpm
// (measured), played faster or slower to the revs and faded from one to the next.
// Only on the sound test page so far.
const KONA: EngineVoice = {
  harmonics: [], sub: 0, drive: 0, tone: [900, 25, 5000],
  roar: [0, 0, 3], level: [0.1, 0.08, 0.1], shift: [0.28, 0.5], clutch: 500, blip: 0.5,
  loops: [['engine-idle', 24], ['engine-mid', 74.5], ['engine-high', 97]],
};
export const RECORDED: EngineSpec = { idle: 720, redline: 6200, cylinders: 4, gears: [0.25, 0.42, 0.6, 0.8, 1.02], rough: 0, voice: KONA };
// An electric motor: a thin whine that rises with speed, silent when standing, a single
// gear (so no shifts) and no clutch or irregular firing.
const ELECTRIC_VOICE: EngineVoice = {
  harmonics: [0, 1, 0, 0.25, 0, 0.08], sub: 0, drive: 0.2, tone: [300, 2, 500],
  roar: [0, 0, 3], level: [0, 0.01, 0.022], shift: [1, 1], clutch: 0, blip: 0,
};
const ELECTRIC: EngineSpec = { idle: 600, redline: 9000, cylinders: 8, gears: [1.02], rough: 0, voice: ELECTRIC_VOICE };
// A big V8 pickup: low and burbling, taken easy.
const V8_VOICE: EngineVoice = {
  harmonics: [0, 1, 0.6, 0.35, 0.15, 0.06], sub: 0.35, drive: 1, tone: [140, 1.6, 300],
  roar: [0.01, 0.06, 3], level: [0.05, 0.03, 0.015], shift: [0.3, 0.55], clutch: 1200, blip: 0.7,
};
export const PETROL: EngineSpec = { idle: 850, redline: 6200, cylinders: 4, gears: [0.25, 0.42, 0.6, 0.8, 1.02], rough: 0.006, voice: EVERYDAY };
export const ENGINES: Record<string, EngineSpec | null> = {
  // By variant (see VARIANTS in car.ts), before the type.
  model3: ELECTRIC,
  modely: ELECTRIC,
  enyaq: ELECTRIC,
  f150: { idle: 650, redline: 5500, cylinders: 8, gears: [0.16, 0.28, 0.42, 0.58, 0.78, 1.02], rough: 0.015, voice: V8_VOICE },
  fabia: { idle: 900, redline: 5500, cylinders: 3, gears: [0.25, 0.42, 0.6, 0.8, 1.02], rough: 0.02, voice: EVERYDAY },
  diesel: { idle: 800, redline: 4500, cylinders: 4, gears: [0.24, 0.4, 0.58, 0.78, 1.02], rough: 0.012, voice: DIESEL },
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
// The tyres' sound. `level`: how loud the road noise is at 108 km/h, and `power` how steeply
// it grows with speed (1 evenly, 2 quiet in town and loud on a fast road). `tone`: its
// filter in Hz, standing and per m/s. `texture`: how much it wavers, as no road is even.
// `rumble`: how loud stones are, and `rumbleTone` their filter (Hz, per m/s, resonance).
// Off for now (level and rumble 0; they were 0.045 and 0.16): filtered noise never sounded
// like tyres. To come back as recordings, see todo.md. The squeal in a slide stays.
export const TYRE = {
  level: 0, power: 2, tone: [180, 16], texture: 0.35,
  rumble: 0, rumbleTone: [80, 5, 1], squeal: 0.4,
};
const SETTS = new Set(['sett', 'cobblestone', 'unhewn_cobblestone']);
export const surfaceOf = (tag: string | undefined | null): Surface => (SETTS.has(tag ?? '') ? 'setts' : tag === 'paving_stones' ? 'pavers' : 'asphalt');

const TRAM_VOICES = 4, TRAM_RANGE = 170; // the nearest trams you can hear, as far as this (m)
const SIREN_VOICES = 3; // the nearest sirens you can hear at once
const JOINT = 24; // m between the rail joints
const BLIP = 0.25; // s a downshift's blip of throttle lasts
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
  sirens?: Siren[]; // emergency vehicles with their sirens on
  aloft?: number; // 0 on the ground to 1 high up in a helicopter: the city fades, sirens stay faint
}

// One siren sounding: `key` tells it from the others from one frame to the next, and (vx, vy) is its speed.
export interface Siren { key: object; kind: 'fire' | 'police'; x: number; y: number; vx: number; vy: number }

// The sound's groups, each with its own volume in the mixer (settings.ts), 1 being as built.
const SILENCE = 'data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const BUSES = ['engine', 'tyres', 'horns', 'trams', 'city', 'weather', 'radio', 'bangs'] as const;
export type Bus = (typeof BUSES)[number];
// Noise cancelling: the steady rumble of engine, tyres, weather and city is cut, mostly its lows; horns, sirens, radio and bangs get through.
const NOISY: Bus[] = ['engine', 'tyres', 'trams', 'city', 'weather'];
const ANC_CUT = 0.5, ANC_SHELF = -22; // volume left, and dB taken off the lows

export class Sound {
  buses = {} as Record<Bus, GainNode>;
  volumes = Object.fromEntries(BUSES.map((b) => [b, 1])) as Record<Bus, number>;
  anc = false;
  private shelves = {} as Record<Bus, BiquadFilterNode>;
  ctx: AudioContext | null = null;
  on: boolean;
  master!: GainNode;
  noise!: AudioBuffer;
  clack!: AudioBuffer;
  clips: Record<string, AudioBuffer> = {};
  engine: Drivetrain | null = null;
  tyres: Tyres | null = null;
  weather: WeatherSound | null = null;
  ambience: Ambience | null = null;
  radio: Radio | null = null;
  onRadioFail: (station: Station) => void = () => {};
  private strikes = -1;
  voices: TramVoice[] = [];
  private horns: Horn | null = null;
  sirens: SirenVoice[] = [];

  constructor() {
    let saved = '';
    try { saved = localStorage.getItem('sound') ?? ''; } catch {}
    this.on = saved !== 'off';
    try {
      const mix = JSON.parse(localStorage.getItem('mix') ?? '{}');
      for (const b of BUSES) if (typeof mix[b] === 'number') this.volumes[b] = clamp(mix[b], 0, 2);
    } catch {}
    try { this.anc = localStorage.getItem('anc') === 'on'; } catch {}
    // (Safari on an iPad only lets the sound start when a touch ends, not when it begins.)
    const keys = ['keydown', 'pointerdown', 'pointerup', 'touchend', 'click'] as const;
    const start = () => {
      this.start();
      if (this.ctx?.state === 'running') for (const k of keys) removeEventListener(k, start);
    };
    for (const k of keys) addEventListener(k, start);
    if (location.search.includes('audiodebug')) this.debugPanel();
    // The game stops in a hidden tab, so the sound does too.
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.on) this.ctx.resume();
    });
  }

  // ?audiodebug: what the sound is doing, on screen (for a device with no console at hand).
  private debugPanel() {
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;margin:0;padding:6px;max-width:100vw;font:11px/1.3 monospace;color:#0f0;background:#000c;pointer-events:none;white-space:pre-wrap';
    document.body.append(box);
    // Two buttons: a test tone straight to the speakers, and one through the game's mixer.
    const beep = (label: string, left: string, through: boolean) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `position:fixed;top:80px;left:${left};z-index:99999;padding:14px 18px;font:16px sans-serif`;
      b.addEventListener('click', () => {
        const c = this.ctx;
        if (!c) return;
        const o = c.createOscillator(), g = c.createGain();
        g.gain.value = 0.3;
        o.frequency.value = 440;
        o.connect(g).connect(through ? this.master : c.destination);
        o.start();
        o.stop(c.currentTime + 0.6);
      });
      document.body.append(b);
    };
    const fresh = document.createElement('button');
    fresh.textContent = 'Beep new context';
    fresh.style.cssText = 'position:fixed;top:80px;left:270px;z-index:99999;padding:14px 18px;font:16px sans-serif';
    fresh.addEventListener('click', () => {
      const c = new AudioContext(), o = c.createOscillator();
      o.connect(c.destination);
      o.start();
      o.stop(c.currentTime + 0.6);
      setTimeout(() => c.close(), 1500);
    });
    document.body.append(fresh);
    const restart = document.createElement('button');
    restart.textContent = 'Suspend+resume';
    restart.style.cssText = 'position:fixed;top:140px;left:0;z-index:99999;padding:14px 18px;font:16px sans-serif';
    restart.addEventListener('click', async () => { await this.ctx?.suspend(); await this.ctx?.resume(); });
    document.body.append(restart);
    beep('Beep direct', '0px', false);
    beep('Beep mixer', '130px', true);
    let meter: AnalyserNode | null = null;
    const level = () => {
      const c = this.ctx;
      if (!c || !this.master) return '-';
      if (!meter) { meter = c.createAnalyser(); meter.fftSize = 256; this.master.connect(meter); }
      const a = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(a);
      return Math.sqrt(a.reduce((x, v) => x + v * v, 0) / a.length).toFixed(4);
    };
    const errors: string[] = [];
    const note = (m: unknown) => { errors.push(String((m as Error)?.stack ?? m).slice(0, 220)); if (errors.length > 4) errors.shift(); };
    addEventListener('error', (e) => note(e.error ?? e.message));
    addEventListener('unhandledrejection', (e) => note(e.reason));
    const warn = console.warn, error = console.error;
    console.warn = (...a) => { note(a.join(' ')); warn(...a); };
    console.error = (...a) => { note(a.join(' ')); error(...a); };
    setInterval(() => {
      const c = this.ctx;
      box.textContent = [
        `time ${c?.currentTime.toFixed(2)} · base ${c?.baseLatency?.toFixed(3)} · rate ${c?.sampleRate} · level ${level()} · ${navigator.userAgent.match(/OS [\d_]+/)?.[0]}`,
        `ctx ${c ? c.state : 'none'} · on ${this.on} · master ${this.master ? this.master.gain.value.toFixed(2) : '-'}`,
        `engine ${!!this.engine} tyres ${!!this.tyres} weather ${!!this.weather} city ${!!this.ambience} radio ${!!this.radio} clips ${Object.keys(this.clips).length} trams ${this.voices.length}`,
        ...errors,
      ].join('\n');
    }, 500);
  }

  // The car radio, on or off; works before the sound has started (a browser only allows it after a key press).
  get radioOn() { return this.radio ? !!this.radio.station : radioOn(); }
  setRadio(on: boolean) {
    if (this.radio) this.radio.set(on);
    else setRadioSaved(on);
  }

  setVolume(bus: Bus, v: number) {
    this.volumes[bus] = clamp(v, 0, 2);
    try { localStorage.setItem('mix', JSON.stringify(this.volumes)); } catch {}
    if (this.ctx) this.buses[bus].gain.setTargetAtTime(this.level(bus), this.ctx.currentTime, 0.05);
  }

  // What a bus is set to, with noise cancelling taken into account.
  private level(bus: Bus) { return this.volumes[bus] * (this.anc && NOISY.includes(bus) ? ANC_CUT : 1); }

  setAnc(on: boolean) {
    this.anc = on;
    try { localStorage.setItem('anc', on ? 'on' : 'off'); } catch {}
    const ctx = this.ctx;
    if (!ctx) return;
    for (const b of NOISY) {
      this.buses[b].gain.setTargetAtTime(this.level(b), ctx.currentTime, 0.4);
      this.shelves[b].gain.setTargetAtTime(on ? ANC_SHELF : 0, ctx.currentTime, 0.4);
    }
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
    // iOS silences Web Audio when the side switch says mute, but not an <audio> element
    // that is playing: a silent one looping alongside keeps the sound audible.
    try {
      const keep = new Audio(SILENCE);
      keep.loop = true;
      keep.setAttribute('playsinline', '');
      keep.play().catch(() => {});
    } catch {}
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.8 : 0;
    this.master.connect(comp).connect(ctx.destination);
    for (const b of BUSES) {
      this.buses[b] = ctx.createGain();
      this.buses[b].gain.value = this.level(b);
      if (NOISY.includes(b)) {
        const shelf = (this.shelves[b] = filter(ctx, 'lowshelf', 500));
        shelf.gain.value = this.anc ? ANC_SHELF : 0;
        this.buses[b].connect(shelf).connect(this.master);
      } else this.buses[b].connect(this.master);
    }
    const bus = this.buses;
    this.noise = noiseBuffer(ctx);
    this.clack = clackBuffer(ctx);
    this.tyres = new Tyres(ctx, this.noise, bus.tyres);
    this.weather = new WeatherSound(ctx, this.noise, bus.weather);
    if (!location.search.includes('noradio')) {
      this.radio = new Radio(ctx, this.noise, bus.radio);
      this.radio.onFail = (station) => this.onRadioFail(station);
    }
    for (let i = 0; i < SIREN_VOICES; i++) this.sirens.push(new SirenVoice(ctx, bus.horns));
    // The trams are heard once their recordings are in.
    Promise.all([...LOOPS, ...ONCE].map(async (name) => {
      const r = await fetch(`audio/${name}.${LOOPS.includes(name) ? 'wav' : 'm4a'}`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      this.clips[name] = await ctx.decodeAudioData(await r.arrayBuffer());
    })).then(() => {
      for (let i = 0; i < TRAM_VOICES; i++) this.voices.push(new TramVoice(this, this.buses.trams));
    }).catch((e) => console.warn('The tram sounds could not be loaded', e));
    // And the city around you, once its recordings are in.
    Promise.all(Object.keys(AMBIENCE).map(async (name) => {
      const r = await fetch(`audio/amb-${name}.m4a`);
      if (!r.ok) throw new Error(`${name}: ${r.status}`);
      return [name, await ctx.decodeAudioData(await r.arrayBuffer())] as const;
    })).then((clips) => {
      this.ambience = new Ambience(ctx, Object.fromEntries(clips), bus.city);
    }).catch((e) => console.warn('The city sounds could not be loaded', e));
  }

  // Your horn, for as long as it's held: a car's two notes, deeper on a lorry or a bus,
  // a thin beep on a motorbike. A bicycle has a bell instead, one ring at a press.
  horn(on: boolean, kind: HornKind = 'car') {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || !this.on) { this.horns?.set(false, kind); return; }
    this.horns ||= new Horn(ctx, this.buses.horns);
    this.horns.set(on, kind);
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
      if (spec) this.engine = new Engine(ctx, this.noise, this.buses.engine, car, spec);
    }
    this.engine?.update(dt, s.throttle);
    this.radio?.update(!!car && !car.two && !s.quiet, car);
    this.tyres!.update(car, s.surface, s.wet ?? 0);
    this.weather!.update(s.rain ?? 0, s.snow ?? 0);
    const aloft = clamp(s.aloft ?? 0, 0, 1);
    this.ambience?.update(s.busy ?? 0.5, s.hour ?? 12, Math.max(s.rain ?? 0, s.snow ?? 0), aloft);
    this.buses.trams.gain.setTargetAtTime(this.level('trams') * (1 - 0.9 * aloft), t, 0.5);
    if (s.strikes !== undefined) {
      if (this.strikes >= 0 && s.strikes > this.strikes) this.weather!.thunder(t + 0.6 + Math.random() * 3.5);
      this.strikes = s.strikes;
    }

    // The nearest sirens, each keeping its voice while it sounds.
    const heard = (s.sirens ?? []).map((q) => ({ q, d: Math.hypot(q.x - s.x, q.y - s.y) })).filter((h) => h.d < SIREN_RANGE).sort((a, b) => a.d - b.d);
    heard.length = Math.min(heard.length, SIREN_VOICES);
    for (const v of this.sirens) if (v.key && !heard.some((h) => h.q.key === v.key)) v.release();
    for (const h of heard) {
      const v = this.sirens.find((x) => x.key === h.q.key) ?? this.sirens.find((x) => !x.key);
      v?.update(h.q, h.d, s.x, s.y, s.car, aloft);
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
    pan.connect(this.buses.bangs);
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
    pan.connect(this.buses.bangs);
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

// What every engine shares, however its sound is made: the gears, and from them the revs.
export abstract class Drivetrain {
  ctx: AudioContext;
  car: Car;
  spec: EngineSpec;
  gear = 0; shift = 0; blip = 0; load = 0; rpm = 0;

  constructor(ctx: AudioContext, car: Car, spec: EngineSpec) {
    this.ctx = ctx;
    this.car = car;
    this.spec = spec;
  }

  // One step of driving. `throttle`: -1..1 as driven, braking or reversing when it's
  // below 0. Gives the revs, how many times a second the cylinders fire at them, how hard
  // the engine is pulling (0–1) and whether the clutch is pressed.
  protected drive(dt: number, throttle: number) {
    const { car, spec } = this, voice = spec.voice;
    const v = Math.abs(car.forwardSpeed), vmax = car.spec.vmax;
    const load = car.forwardSpeed < 0.5 && throttle < 0 ? -throttle : clamp(throttle, 0, 1);
    const hard = car.forwardSpeed > 0.5 && throttle < -0.5;
    // Revs in a gear: redline at the gear's top speed. Up a gear where the voice says
    // (later with the pedal down), and down once the revs sag.
    const revs = (g: number) => spec.idle + (spec.redline - spec.idle) * clamp(v / (spec.gears[g] * vmax), 0, 1);
    // The shift point follows the pedal slowly, so tapping it doesn't flick between two gears.
    this.load += (load - this.load) * Math.min(1, dt / 0.3);
    const up = spec.idle + (spec.redline - spec.idle) * (voice.shift[0] + (voice.shift[1] - voice.shift[0]) * this.load);
    if (this.gear < spec.gears.length - 1 && revs(this.gear) > up) { this.gear++; this.shift = 0.18; }
    // Hard on the brake, the driver stays in gear and the revs fall with the speed, then
    // presses the clutch before the engine would stall; the gear for the speed is taken
    // once the brake is let go. Lifting off or braking gently goes down through the gears.
    else if (!hard && this.gear > 0 && revs(this.gear) < spec.idle * 1.9 && revs(this.gear - 1) < up * 0.9) {
      this.gear--;
      if (v > 2) this.blip = BLIP; // not while finding first gear at a standstill
    }
    this.shift = Math.max(0, this.shift - dt);
    this.blip = Math.max(0, this.blip - dt);
    // The blip: the revs overshoot the lower gear's and the engine speaks up, fading out.
    const kick = voice.blip * (this.blip / BLIP);
    let rpm = revs(this.gear);
    const declutched = hard && rpm < spec.idle * 1.25;
    if (declutched) rpm = spec.idle;
    // Pulling away, the clutch lets the revs rise ahead of the speed.
    if (this.gear === 0) rpm = Math.max(rpm, spec.idle + load * voice.clutch);
    rpm *= 1 + 0.12 * kick;
    this.rpm = rpm;
    const pull = this.shift > 0 ? 0.1 : Math.max(load, kick * 0.7);
    return { rpm, hz: ((rpm / 60) * spec.cylinders) / 2, pull, declutched };
  }

  abstract update(dt: number, throttle: number): void;
  abstract stop(): void;
  // Takes again what of the voice is set up once: for the sound test page.
  revoice() {}
}

// An engine's note: harmonics of the cylinders' firing rate, roughened with a little
// wobble, through a filter that opens up with the throttle; plus the intake's roar.
export class Engine extends Drivetrain {
  out: GainNode;
  osc: OscillatorNode; sub: OscillatorNode; wobble: AudioBufferSourceNode; intake: AudioBufferSourceNode;
  depth: GainNode; tone: BiquadFilterNode; roar: BiquadFilterNode; roarGain: GainNode;
  subGain: GainNode; shaper: WaveShaperNode;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode, car: Car, spec: EngineSpec) {
    super(ctx, car, spec);
    const t = ctx.currentTime;
    const voice = spec.voice;
    this.osc = ctx.createOscillator();
    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    // Slow random wobble of the pitch: no engine fires perfectly evenly.
    this.wobble = loop(ctx, noise);
    const slow = filter(ctx, 'lowpass', 25);
    this.depth = ctx.createGain();
    this.wobble.connect(slow).connect(this.depth);
    this.depth.connect(this.osc.frequency);
    this.depth.connect(this.sub.frequency);
    this.subGain = gain(ctx, 0);
    this.shaper = ctx.createWaveShaper();
    this.revoice();
    const subGain = this.subGain, shaper = this.shaper;
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

  // Takes the voice's overtones, sub-octave and distortion again (the rest is read as it
  // plays): for the sound test page, where they change while the engine runs.
  revoice() {
    const voice = this.spec.voice, harmonics = new Float32Array(voice.harmonics);
    this.osc.setPeriodicWave(this.ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics));
    this.subGain.gain.value = voice.sub;
    this.shaper.curve = softClip(voice.drive);
  }

  update(dt: number, throttle: number) {
    const { spec } = this, voice = spec.voice, t = this.ctx.currentTime;
    const { rpm, hz, pull, declutched } = this.drive(dt, throttle);
    // With the clutch in, the revs settle to idle rather than jump there.
    const settle = declutched ? 0.2 : SMOOTH;
    this.osc.frequency.setTargetAtTime(hz, t, settle);
    this.sub.frequency.setTargetAtTime(hz / 2, t, settle);
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

// An engine from recordings of a car held at steady revs (the voice's `loops`): all of
// them play at once, each sped up or slowed down to the revs, and only the one or two
// recorded nearest to them are heard, one fading into the next as the revs go between.
// A filter opens with the throttle, as the recordings are of an engine without load.
export class RecordedEngine extends Drivetrain {
  out: GainNode; tone: BiquadFilterNode;
  loops: { src: AudioBufferSourceNode; gain: GainNode; hz: number }[] = [];

  constructor(ctx: AudioContext, clips: Record<string, AudioBuffer>, dest: AudioNode, car: Car, spec: EngineSpec) {
    super(ctx, car, spec);
    const t = ctx.currentTime;
    this.tone = filter(ctx, 'lowpass', 2000, 0.7);
    this.out = gain(ctx, 0);
    this.tone.connect(this.out).connect(dest);
    for (const [name, hz] of spec.voice.loops ?? []) {
      if (!clips[name]) continue;
      const src = loop(ctx, clips[name]), g = gain(ctx, 0);
      src.connect(g).connect(this.tone);
      src.start(t, Math.random() * clips[name].duration);
      this.loops.push({ src, gain: g, hz });
    }
    this.update(0, 0);
  }

  update(dt: number, throttle: number) {
    const { spec, loops } = this, voice = spec.voice, t = this.ctx.currentTime;
    const { rpm, hz, pull, declutched } = this.drive(dt, throttle);
    const settle = declutched ? 0.2 : SMOOTH;
    // Where the revs are among the recordings, by pitch: 1.5 is halfway from the second to the third.
    let at = 0;
    while (at < loops.length - 1 && hz > loops[at + 1].hz) at++;
    const next = loops[Math.min(at + 1, loops.length - 1)];
    const mix = next === loops[at] ? 0 : clamp(Math.log(hz / loops[at].hz) / Math.log(next.hz / loops[at].hz), 0, 1);
    loops.forEach((l, i) => {
      l.src.playbackRate.setTargetAtTime(clamp(hz / l.hz, 0.25, 4), t, settle);
      // Equal power: the two recordings aren't in step, so their loudness adds, not their waves.
      const share = i === at ? Math.cos((mix * Math.PI) / 2) : l === next ? Math.sin((mix * Math.PI) / 2) : 0;
      l.gain.gain.setTargetAtTime(share, t, SMOOTH);
    });
    this.tone.frequency.setTargetAtTime(voice.tone[0] + hz * voice.tone[1] + pull * voice.tone[2], t, SMOOTH);
    this.out.gain.setTargetAtTime(voice.level[0] + pull * voice.level[1] + (rpm / spec.redline) * voice.level[2], t, 0.1);
  }

  stop() {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.08);
    for (const l of this.loops) l.src.stop(t + 0.6);
  }
}

// A siren: a bright buzzing note through a filter that closes with distance, shifted in
// pitch as the vehicle comes or goes. An engine's is a slow two-tone (high, low, about
// once a second); a police car's a faster wail that rises and falls.
const SONIC = 343; // m/s
class SirenVoice {
  ctx: AudioContext;
  key: object | null = null;
  osc: OscillatorNode; top: OscillatorNode; tone: BiquadFilterNode; out: GainNode; pan: StereoPannerNode;
  phase = Math.random();
  private last = 0;

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.top = ctx.createOscillator();
    this.top.type = 'square';
    const topGain = gain(ctx, 0.18);
    this.tone = filter(ctx, 'lowpass', 3000, 0.7);
    this.out = gain(ctx, 0);
    this.pan = ctx.createStereoPanner();
    this.osc.connect(this.tone);
    this.top.connect(topGain).connect(this.tone);
    this.tone.connect(this.out).connect(this.pan).connect(dest);
    this.osc.start();
    this.top.start();
  }

  update(q: Siren, d: number, lx: number, ly: number, me: Car | null, aloft = 0) {
    const t = this.ctx.currentTime;
    if (this.key !== q.key) { this.key = q.key; this.last = t; this.phase = Math.random(); }
    this.phase = (this.phase + (t - this.last) * (q.kind === 'fire' ? 1 : 1.6)) % 1;
    this.last = t;
    // Pitch: high and low for an engine, a sweep up and down for the police.
    const hz = q.kind === 'fire' ? (this.phase < 0.5 ? 660 : 495) : 650 + 550 * (0.5 - 0.5 * Math.cos(this.phase * Math.PI * 2));
    // Doppler: the speed of the siren towards you, less your own.
    const dx = lx - q.x, dy = ly - q.y, n = Math.max(d, 1);
    const toward = ((q.vx - (me?.vx ?? 0)) * dx + (q.vy - (me?.vy ?? 0)) * dy) / n;
    const f = hz * SONIC / (SONIC - clamp(toward, -40, 40));
    const tc = q.kind === 'fire' ? 0.02 : 0.05;
    this.osc.frequency.setTargetAtTime(f, t, tc);
    this.top.frequency.setTargetAtTime(f * 2, t, tc);
    this.tone.frequency.setTargetAtTime(clamp(3600 - d * 7, 800, 3600) * (1 - 0.6 * aloft), t, 0.1);
    this.out.gain.setTargetAtTime(sirenGain(q.kind, d) * (1 - 0.65 * aloft), t, 0.1);
    this.pan.pan.setTargetAtTime(clamp(-dx / 45, -0.85, 0.85), t, 0.1);
  }

  release() {
    this.key = null;
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}

// Tyres on the road: a hiss on asphalt, a rumble at the rate the wheels hit the stones
// on setts, and a squeal when the car slides sideways.
export class Tyres {
  ctx: AudioContext;
  hiss: BiquadFilterNode; soft: BiquadFilterNode; hissGain: GainNode; waver: GainNode;
  bumps: OscillatorNode; rumble: BiquadFilterNode; rumbleGain: GainNode;
  squeal: BiquadFilterNode; squealGain: GainNode;

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    // The road noise: a dull roar (filtered twice, so no hiss is left on top) that wavers
    // slowly, which is what tells it from plain noise.
    this.hiss = filter(ctx, 'lowpass', 300, 0.5);
    this.soft = filter(ctx, 'lowpass', 450, 0.5);
    this.hissGain = gain(ctx, 0);
    const uneven = gain(ctx, 1), slow = loop(ctx, noise, 0.37);
    this.waver = gain(ctx, 0);
    slow.connect(filter(ctx, 'lowpass', 4)).connect(this.waver).connect(uneven.gain);
    const a = loop(ctx, noise);
    a.connect(filter(ctx, 'highpass', 80)).connect(this.hiss).connect(this.soft).connect(uneven).connect(this.hissGain).connect(dest);
    // The stones: noise swelling and fading at the rate the wheels meet them (smoothly, and
    // filtered afterwards: switching it on and off crackles).
    this.rumble = filter(ctx, 'lowpass', 200, 1.5);
    const chop = gain(ctx, 0.5);
    this.bumps = ctx.createOscillator();
    this.bumps.connect(gain(ctx, 0.5)).connect(chop.gain);
    this.rumbleGain = gain(ctx, 0);
    const b = loop(ctx, noise, 0.7);
    b.connect(chop).connect(this.rumble).connect(this.rumbleGain).connect(dest);
    this.squeal = filter(ctx, 'bandpass', 1900, 12);
    this.squealGain = gain(ctx, 0);
    const c = loop(ctx, noise, 1.3);
    c.connect(this.squeal).connect(filter(ctx, 'bandpass', 1900, 6)).connect(this.squealGain).connect(dest);
    for (const n of [a, b, c, slow, this.bumps]) n.start(t);
  }

  // `wet`: how wet the road is, which makes the hiss louder and brighter.
  update(car: Car | null, surface: Surface, wet = 0) {
    const t = this.ctx.currentTime;
    const v = car ? car.speed : 0;
    const light = car?.two ? 0.35 : 1; // two narrow tyres
    const s = SURFACES[surface];
    const slip = car ? Math.abs(car.vx * Math.sin(car.h) - car.vy * Math.cos(car.h)) : 0;
    const top = (TYRE.tone[0] + v * TYRE.tone[1]) * (1 + wet * 2.5);
    this.hiss.frequency.setTargetAtTime(top, t, SMOOTH);
    this.soft.frequency.setTargetAtTime(top * 1.5, t, SMOOTH);
    // The slow noise is faint once filtered: 130 brings it to about 1.
    this.waver.gain.setTargetAtTime(TYRE.texture * 130, t, SMOOTH);
    this.hissGain.gain.setTargetAtTime(light * clamp(v / 30, 0, 1.5) ** TYRE.power * TYRE.level * (1 - 0.5 * s.rumble) * (1 + wet * 1.2), t, SMOOTH);
    this.bumps.frequency.setTargetAtTime(clamp(v / s.spacing, 1, 400), t, SMOOTH);
    this.rumble.frequency.setTargetAtTime(TYRE.rumbleTone[0] + v * TYRE.rumbleTone[1], t, SMOOTH);
    this.rumble.Q.setTargetAtTime(TYRE.rumbleTone[2], t, SMOOTH);
    this.rumbleGain.gain.setTargetAtTime(light * s.rumble * clamp(v / 12, 0, 1) * TYRE.rumble, t, SMOOTH);
    this.squealGain.gain.setTargetAtTime(light * clamp((slip - 2.5) / 5, 0, 1) * (1 - 0.6 * s.rumble) * TYRE.squeal, t, 0.04);
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
  lastSpeed = 0; joint = 0; bellT = 0; rung = 0;
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
      this.rung = v.ring ?? 0;
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

    // The bell: at you or a car on the track ahead, again every few seconds while it's
    // there, and whenever whoever's driving it rings.
    this.bellT -= dt;
    if ((v.ring ?? 0) !== this.rung) {
      this.rung = v.ring ?? 0;
      sound.play(sound.pick('bell'), t, 0.9, this.out);
    }
    // (What the driver sees can come and go from one step to the next.)
    if ((v.spotted > 0 || v.forPlayer || (!!v.blocker && speed < 1)) && this.bellT < 0) {
      sound.play(sound.pick('bell'), t, 0.7, this.out);
      this.bellT = v.forPlayer ? 2 : 4;
    }
  }
}

export type HornKind = 'car' | 'heavy' | 'moto' | 'bike';
const HORNS: Record<HornKind, number[]> = { car: [415, 523], heavy: [262, 330], moto: [620, 780], bike: [] };

// A horn: two notes held together, buzzing a little, for as long as it's on.
class Horn {
  ctx: AudioContext;
  dest: AudioNode;
  out: GainNode;
  notes: OscillatorNode[] = [];
  on = false;
  kind: HornKind = 'car';

  constructor(ctx: AudioContext, dest: AudioNode) {
    this.ctx = ctx;
    this.dest = dest;
    this.out = gain(ctx, 0);
    this.out.connect(dest);
    const lp = filter(ctx, 'lowpass', 2600), am = gain(ctx, 0.85);
    const buzz = ctx.createOscillator(), depth = gain(ctx, 0.15);
    buzz.frequency.value = 95;
    buzz.connect(depth).connect(am.gain);
    buzz.start();
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 440;
      o.connect(lp);
      o.start();
      this.notes.push(o);
    }
    lp.connect(am).connect(this.out);
  }

  set(on: boolean, kind: HornKind) {
    const t = this.ctx.currentTime;
    if (on && kind === 'bike') {
      if (!this.on) this.ding(t);
      this.on = true;
      return;
    }
    if (on === this.on && kind === this.kind) return;
    this.on = on;
    this.kind = kind;
    const freqs = HORNS[kind];
    if (freqs.length) this.notes.forEach((o, i) => o.frequency.setTargetAtTime(freqs[i], t, 0.005));
    this.out.gain.setTargetAtTime(on ? 0.16 : 0, t, on ? 0.012 : 0.05);
  }

  // A bicycle bell: two bright notes that ring out.
  private ding(t: number) {
    for (const f of [2350, 3130]) {
      const o = this.ctx.createOscillator(), g = gain(this.ctx, 0);
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.9);
      o.connect(g).connect(this.dest);
      o.start(t);
      o.stop(t + 1);
    }
  }
}

// The city's sound: loops that play all the time, as loud as src/soundmix.ts says for
// where you are and when. The levels change slowly, so walking from a quiet street onto
// a square the crowd comes up over a few seconds.
class Ambience {
  ctx: AudioContext;
  gains: Record<string, GainNode> = {};
  muffles: Record<string, BiquadFilterNode> = {};

  constructor(ctx: AudioContext, clips: Record<string, AudioBuffer>, dest: AudioNode) {
    this.ctx = ctx;
    for (const [name, buffer] of Object.entries(clips)) {
      const src = loop(ctx, buffer), g = gain(ctx, 0), lp = filter(ctx, 'lowpass', 20000);
      src.connect(lp).connect(g).connect(dest);
      src.start(ctx.currentTime, Math.random() * buffer.duration);
      this.gains[name] = g;
      this.muffles[name] = lp;
    }
  }

  // `busy` 0–1, `hour` 0–24, `wet` how hard it rains or snows 0–1.
  update(busy: number, hour: number, wet: number, aloft = 0) {
    const t = this.ctx.currentTime, gains = ambienceGains(busy, hour, wet), muffle = ambienceMuffle(busy);
    // High up the city is a faint murmur: much quieter, and only its lows reach you.
    for (const [name, g] of Object.entries(this.gains)) g.gain.setTargetAtTime((gains[name] ?? 0) * (1 - 0.93 * aloft), t, 2);
    for (const [name, lp] of Object.entries(this.muffles)) lp.frequency.setTargetAtTime(Math.min(muffle[name] ?? 20000, 20000 - 18500 * aloft), t, 2);
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
export function noiseBuffer(ctx: AudioContext) {
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
