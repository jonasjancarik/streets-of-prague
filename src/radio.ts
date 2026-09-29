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

// What's remembered: a station's id, or 'off'. Nothing yet means the first station.
const KEY = 'radio';
const readSaved = () => {
  let saved: string | null = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  return saved === null ? 0 : STATIONS.findIndex((s) => s.id === saved);
};
const save = (i: number) => { try { localStorage.setItem(KEY, STATIONS[i]?.id ?? 'off'); } catch {} };
// Whether a station is set to play; known before the sound has started.
export const radioOn = () => readSaved() >= 0;
export const setRadioSaved = (on: boolean) => save(on ? 0 : -1);

const LEVEL = 0.55; // how loud a station plays, before the master volume
const FADE = 0.25; // s

export class Radio {
  private ctx: AudioContext;
  private noise: AudioBuffer;
  private out: GainNode;
  private input: AudioNode; // where a station's sound comes in
  private el: HTMLAudioElement | null = null;
  private tuned = -1; // the index in STATIONS being played, or -1 when it's off
  private want = false; // whether a station should be heard right now
  private pauser = 0;
  // Called when a station can't be reached.
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
    this.tuned = readSaved();
  }
  get station(): Station | null { return STATIONS[this.tuned] ?? null; }

  // The next station, and after the last one, off.
  next(): Station | null {
    return this.tune(this.tuned + 1 >= STATIONS.length ? -1 : this.tuned + 1);
  }

  // The first station, or off.
  set(on: boolean) {
    if (on !== (this.tuned >= 0)) this.tune(on ? 0 : -1);
  }

  private tune(i: number) {
    this.tuned = i;
    save(i);
    this.close();
    if (this.station) { this.hiss(); if (this.want) this.open(); }
    return this.station;
  }

  // Whether the radio should be heard now: you're in a car, with the sound on.
  update(want: boolean) {
    if (want === this.want) return;
    this.want = want;
    const t = this.ctx.currentTime;
    clearTimeout(this.pauser);
    this.out.gain.cancelScheduledValues(t);
    if (want && this.station) {
      if (!this.el) this.open();
      else this.el.play().catch(() => {});
      this.out.gain.setTargetAtTime(LEVEL, t, FADE / 3);
    } else {
      this.out.gain.setTargetAtTime(0, t, FADE / 3);
      // Left playing in the background it would keep downloading the stream.
      this.pauser = window.setTimeout(() => { if (!this.want) this.close(); }, FADE * 3000);
    }
  }

  private open() {
    const station = this.station;
    if (!station) return;
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'none';
    el.src = station.url;
    el.addEventListener('error', () => { if (this.el === el) this.onFail(station); });
    this.ctx.createMediaElementSource(el).connect(this.input);
    this.el = el;
    this.out.gain.setTargetAtTime(this.want ? LEVEL : 0, this.ctx.currentTime, FADE / 3);
    el.play().catch(() => {});
  }

  private close() {
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load(); // stops the download
    this.el = null;
  }

  // The static between two stations.
  private hiss() {
    if (!this.want) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(), g = ctx.createGain(), band = biquad(ctx, 'bandpass', 2600, 0.5);
    src.buffer = this.noise;
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    src.connect(band).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + 0.5);
  }
}

const biquad = (ctx: AudioContext, type: BiquadFilterType, frequency: number, Q = 0.7) => {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
};
