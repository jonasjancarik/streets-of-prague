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

const LEVEL = 0.55; // how loud a station plays, before the master volume
const FADE = 0.25; // s

const randomOther = (not: number) => {
  let i = Math.floor(Math.random() * STATIONS.length);
  if (i === not) i = (i + 1) % STATIONS.length;
  return i;
};

export class Radio {
  private ctx: AudioContext;
  private noise: AudioBuffer;
  private out: GainNode;
  private input: AudioNode; // where a station's sound comes in
  private el: HTMLAudioElement | null = null;
  private tuned = -1; // the index in STATIONS being played, or -1 when it's off
  private want = false; // whether a station should be heard right now
  private away = 0;
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
    setRadioSaved(i >= 0);
    this.close();
    if (this.station) this.open(this.want);
    return this.station;
  }

  // Whether the radio should be heard now: you're in a car, with the sound on.
  update(want: boolean) {
    if (want === this.want) return;
    this.want = want;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    if (want && this.station) {
      if (!this.el) this.open(true);
      else this.el.play().catch(() => {});
      this.out.gain.setTargetAtTime(LEVEL, t, FADE / 3);
    } else {
      this.out.gain.setTargetAtTime(0, t, FADE / 3);
      // The next car gets another station.
      if (this.station) window.setTimeout(() => { if (!this.want && this.station) { this.close(); this.tuned = randomOther(this.tuned); } }, FADE * 1000);
    }
  }

  // On foot, the station is only downloaded (silently) while you're near a car, so it's buffered
  // when you get in, and dropped again a little after you walk away.
  warm(near: boolean, dt: number) {
    if (this.want || !this.station) return;
    if (near) {
      this.away = 0;
      if (!this.el) this.open(false);
    } else if (this.el && (this.away += dt) > 20) this.close();
  }

  private open(withStatic = false) {
    const station = this.station;
    if (!station) return;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.src = station.url;
    el.addEventListener('error', () => { if (this.el === el) { this.endStatic(); if (this.want) this.onFail(station); } });
    el.addEventListener('playing', () => { if (this.el === el) this.endStatic(); });
    this.ctx.createMediaElementSource(el).connect(this.input);
    this.el = el;
    if (withStatic) this.startStatic();
    el.play().catch(() => {});
  }

  private close() {
    this.endStatic();
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load(); // stops the download
    this.el = null;
  }

  // Static that fills the gap until a station starts playing.
  private startStatic() {
    this.endStatic();
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(), g = ctx.createGain(), band = biquad(ctx, 'bandpass', 2600, 0.5);
    src.buffer = this.noise;
    src.loop = true;
    g.gain.setValueAtTime(0.3, t);
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
