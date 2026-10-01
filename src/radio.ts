// The car radio: live internet stations, heard only while you drive a car. Each one is
// an <audio> element fed through Web Audio, so it goes through the same master volume
// (silent in the metro or with the sound off) and can be filtered like a small speaker.
// More stations that were checked are listed in docs/radio-stations.md.

export interface Station { id: string; name: string; url: string }

export const STATIONS: Station[] = [
  { id: 'wave', name: 'ČRo Wave', url: 'https://rozhlas.stream/wave_mp3_128.mp3' },
  { id: 'beat', name: 'Radio Beat', url: 'https://icecast2.play.cz/radiobeat128.mp3' },
  { id: 'hit80', name: 'Hitrádio Osmdesátka', url: 'https://ice.abradio.cz/hit80128.mp3' },
  { id: 'hit90', name: 'Hitrádio Devadesátka', url: 'https://ice.abradio.cz/hit90128.mp3' },
  { id: 'oldies', name: 'Oldies Rádio', url: 'https://ice.abradio.cz/oldiesradio128.mp3' },
  { id: 'kiss', name: 'Kiss', url: 'https://icecast4.play.cz/kiss128.mp3' },
  { id: 'evropa2', name: 'Evropa 2', url: 'https://ice.actve.net/fm-evropa2-128' },
  { id: 'casrock', name: 'Čas Rock', url: 'https://icecast6.play.cz/casrock128.mp3' },
  { id: 'vltava', name: 'ČRo Vltava', url: 'https://icecast5.play.cz/cro3-128.mp3' },
  { id: 'paradise', name: 'Radio Paradise', url: 'https://stream.radioparadise.com/mp3-128' },
];

// What's remembered: whether the radio is on. Which station plays is picked at random.
const KEY = 'radio';
export const radioOn = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export const setRadioSaved = (on: boolean) => { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} };

const LEVEL = 0.14; // how loud a station plays, before the master volume
const FADE = 0.25; // s

const randomOther = (not: number) => {
  let i = Math.floor(Math.random() * STATIONS.length);
  if (i === not) i = (i + 1) % STATIONS.length;
  return i;
};

interface Stream { el: HTMLAudioElement; gain: GainNode }
type Owner = { radio?: number };

const LINGER = 60; // s a car's station keeps downloading after you leave it (as long as you're away from it)
const WARM = 20; // s the next station keeps downloading after you walk away from every car

export class Radio {
  private ctx: AudioContext;
  private noise: AudioBuffer;
  private out: GainNode;
  private input: AudioNode; // where a station's sound comes in
  // Stations being downloaded: the one for the next car, and the one you just left (so getting
  // back into that car has no wait). Only the tuned one is audible, and only in a car.
  private streams = new Map<number, Stream>();
  private tuned = -1; // the index in STATIONS being played, or -1 when it's off
  private want = false; // whether a station should be heard right now
  private away = 0;
  private warmOn = false;
  private owner: Owner | null = null; // the car you're in, which remembers its station
  private linger: { car: Owner; idx: number; away: number } | null = null;
  private stopStatic: (() => void) | null = null;
  // Called when a station can't be reached while you're listening.
  onFail: (station: Station) => void = () => {};

  constructor(ctx: AudioContext, noise: AudioBuffer, dest: AudioNode) {
    this.ctx = ctx;
    this.noise = noise;
    // A small car speaker: no deep bass, no high treble.
    const hp = biquad(ctx, 'highpass', 190), lp = biquad(ctx, 'lowpass', 5200), body = biquad(ctx, 'peaking', 1400, 0.9);
    body.gain.value = 3;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    hp.connect(body).connect(lp).connect(this.out).connect(dest);
    this.input = hp;
    if (radioOn()) this.tuned = randomOther(-1);
  }
  get station(): Station | null { return STATIONS[this.tuned] ?? null; }
  // The car whose station is still downloading after you left it.
  get lingering(): Owner | null { return this.linger?.car ?? null; }

  // The next station, and after the last one, off.
  next(): Station | null {
    return this.tune(this.tuned < 0 ? 0 : this.tuned + 1 >= STATIONS.length ? -1 : this.tuned + 1);
  }

  // The station before this one, and before the first, off.
  prev(): Station | null {
    return this.tune(this.tuned < 0 ? STATIONS.length - 1 : this.tuned - 1);
  }

  // A chosen station, or -1 for off.
  pick(i: number) { if (i !== this.tuned) this.tune(i); }

  // Turns the radio on at a random station, or off.
  set(on: boolean) {
    if (on !== (this.tuned >= 0)) this.tune(on ? randomOther(-1) : -1);
  }

  private tune(i: number) {
    this.tuned = i;
    if (this.owner) this.owner.radio = i;
    setRadioSaved(i >= 0);
    this.endStatic();
    this.sync();
    return this.station;
  }

  // Whether the radio should be heard now: you're in a car, with the sound on.
  update(want: boolean, car: Owner | null = null) {
    const owner = want ? car : null;
    const moved = owner !== this.owner;
    if (!moved && want === this.want) return;
    if (moved) {
      // Leaving a car: its station goes on downloading for a while and the next car gets another one.
      if (this.owner) {
        if (this.tuned >= 0) this.linger = { car: this.owner, idx: this.tuned, away: 0 };
        this.tuned = this.tuned >= 0 ? randomOther(this.tuned) : -1;
      }
      // Getting into a car brings back its station; one not yet sat in takes what's tuned now.
      if (owner) {
        if (owner.radio === undefined) owner.radio = this.tuned;
        else this.tuned = owner.radio;
        if (this.linger?.car === owner) this.linger = null;
      }
      this.owner = owner;
    }
    this.want = want;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(want && this.station ? LEVEL : 0, t, FADE / 3);
    this.sync();
  }

  // On foot, the next station is only downloaded (silently) while you're near a car, so it's
  // buffered when you get in, and dropped again a little after you walk away. The station of the
  // car you just left stays a minute, longer while you're still by it.
  warm(near: boolean, dt: number, nearLinger = false) {
    if (this.linger) {
      if (nearLinger) this.linger.away = 0;
      else if ((this.linger.away += dt) > LINGER) this.linger = null;
    }
    if (near) { this.away = 0; this.warmOn = true; }
    else if ((this.away += dt) > WARM) this.warmOn = false;
    this.sync();
  }

  // Opens the stations that should be downloading, closes the others, and lets only the tuned one be heard.
  private sync() {
    const keep = (i: number) => (i === this.tuned && (this.want || this.warmOn)) || this.linger?.idx === i;
    for (const i of [...this.streams.keys()]) if (!keep(i)) this.close(i);
    if (this.tuned >= 0 && keep(this.tuned) && !this.streams.has(this.tuned)) this.open(this.tuned, this.want);
    const t = this.ctx.currentTime;
    for (const [i, s] of this.streams) {
      s.gain.gain.cancelScheduledValues(t);
      s.gain.gain.setTargetAtTime(i === this.tuned && this.want ? 1 : 0, t, FADE / 3);
      // A station only downloading must be silent whatever the audio graph does (Safari on an
      // iPad can let a stream through before the context runs), so the element itself is muted.
      s.el.muted = !(i === this.tuned && this.want);
      if (i === this.tuned && this.want && s.el.paused) s.el.play().catch(() => {});
    }
  }

  private open(i: number, withStatic: boolean) {
    const station = STATIONS[i];
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.muted = true;
    el.src = station.url;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    el.addEventListener('error', () => { if (this.streams.get(i)?.el === el && i === this.tuned) { this.endStatic(); if (this.want) this.onFail(station); } });
    el.addEventListener('playing', () => { if (i === this.tuned) this.endStatic(); });
    this.ctx.createMediaElementSource(el).connect(gain).connect(this.input);
    this.streams.set(i, { el, gain });
    if (withStatic) this.startStatic();
    el.play().catch(() => {});
  }

  private close(i: number) {
    const s = this.streams.get(i);
    if (!s) return;
    if (i === this.tuned) this.endStatic();
    s.el.pause();
    s.el.removeAttribute('src');
    s.el.load(); // stops the download
    s.gain.disconnect();
    this.streams.delete(i);
  }

  // Lets go of every station; the radio isn't used after this.
  dispose() {
    this.stopStatic = null; // the context it would fade on is being closed
    for (const i of [...this.streams.keys()]) this.close(i);
  }

  // Static that fills the gap until a station starts playing.
  private startStatic() {
    this.endStatic();
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(), g = ctx.createGain(), band = biquad(ctx, 'bandpass', 2600, 0.5);
    src.buffer = this.noise;
    src.loop = true;
    g.gain.setValueAtTime(0.15, t);
    src.connect(band).connect(g).connect(this.out);
    src.start(t);
    this.stopStatic = () => {
      const n = ctx.currentTime;
      g.gain.cancelScheduledValues(n);
      g.gain.setValueAtTime(g.gain.value, n);
      g.gain.linearRampToValueAtTime(0, n + 0.25);
      src.stop(n + 0.3);
    };
  }

  private endStatic() {
    this.stopStatic?.();
    this.stopStatic = null;
  }
}

const biquad = (ctx: AudioContext, type: BiquadFilterType, frequency: number, Q = 0.7) => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
};
