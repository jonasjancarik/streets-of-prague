import * as THREE from 'three';
import { WET, SNOW, STREET_SNOW, RAIN, BARE, SEASON, NOISE, NOISE_GLSL, WEATHER_DETAIL } from './shading.ts';
import { LAMP_GLSL, LAMP_MAP, LAMP_BOX, LAMP_ON } from './lamps.ts';
import { t } from './i18n.ts';
import { SEASONS } from './season.ts';
import { shareGroundSeason } from './groundSeason.ts';
import type { Season, SeasonName } from './season.ts';
import { LocalMistVolume, MIST_MODE } from './localmist.ts';

// The weather: clear, cloudy, rain, a thunderstorm, mist or snow. Each is a mix of
// cloud, rain, storm, snow and mist (0–1), and the weather moves between them
// gradually; in a storm lightning flashes now and then (thunder in audio.ts).
// The ground gets wet in the rain and dries slowly after it; snow settles and melts
// slower still. On the streets and pavements it lies thick through the night, and
// from the morning the traffic and the ploughs clear it, more with every busy hour
// (by the game's clock); falling snow covers them again, fastest at night. The
// weather changes by itself every half hour or so of the game's clock, more often to
// rain in summer and to snow in winter (by the game's date, season.ts),
// with mist left out of the roll (and the real weather's mist shown as clouds) while
// it is in beta,
// unless it's been picked
// (?weather=clear|cloudy|rain|storm|mist|snow, the P key or the developer panel).
//
// Sky (sky.ts) turns it into light and fog; WeatherFx draws the falling rain and snow
// and the drifting mist; the ground and the buildings get wet and snowy in their
// shaders (shading.ts).

export type Kind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'mist' | 'snow';
export const KINDS: Kind[] = ['clear', 'cloudy', 'rain', 'storm', 'mist', 'snow'];
// Mist is beta: explicit choices remain available, automatic ones use clouds.
export const automaticWeather = (kind: Kind): Kind => kind === 'mist' ? 'cloudy' : kind;
// `cover`: the snow lying; `cleared`, how much of it is gone from the streets.
// `flash`: lightning, 0–1 as it flickers; `strikes` counts them (for the thunder).
export interface Conditions { cloud: number; rain: number; storm: number; snow: number; mist: number; wet: number; cover: number; cleared: number; flash: number; strikes: number }
export const CLEAR: Conditions = { cloud: 0, rain: 0, storm: 0, snow: 0, mist: 0, wet: 0, cover: 0, cleared: 0, flash: 0, strikes: 0 };

const LOOK: Record<Kind, { cloud: number; rain: number; storm: number; snow: number; mist: number }> = {
  clear: { cloud: 0, rain: 0, storm: 0, snow: 0, mist: 0 },
  cloudy: { cloud: 0.55, rain: 0, storm: 0, snow: 0, mist: 0 },
  rain: { cloud: 1, rain: 1, storm: 0, snow: 0, mist: 0.12 },
  storm: { cloud: 1, rain: 1, storm: 1, snow: 0, mist: 0.2 },
  mist: { cloud: 0.6, rain: 0, storm: 0, snow: 0, mist: 1 },
  snow: { cloud: 0.95, rain: 0, storm: 0, snow: 1, mist: 0.15 },
};
const NAMES: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };
// Lightning: strikes a second at full storm, and how a flash flickers (s, brightness).
const STRIKES = 1 / 9;
const FLICKER: [number, number][] = [[0, 1], [0.07, 0.15], [0.14, 0.85], [0.22, 0.3], [0.3, 0.5], [0.7, 0]];

// How likely each weather is to come next, in the middle of each season (blended
// between them by the date). Grey skies are kept to about a quarter of the time at
// most: from above, a long overcast spell flattens the whole city. Mist isn't rolled
// while it is in beta.
const CHANCES: Record<SeasonName, Record<Kind, number>> = {
  winter: { clear: 2.5, cloudy: 2.5, rain: 1, storm: 0, mist: 2, snow: 3 },
  spring: { clear: 4, cloudy: 2, rain: 2, storm: 0.3, mist: 0.5, snow: 0.2 },
  summer: { clear: 6, cloudy: 2, rain: 1.5, storm: 0.7, mist: 0.2, snow: 0 },
  autumn: { clear: 3.5, cloudy: 2, rain: 2.5, storm: 0.1, mist: 2, snow: 0.2 },
};
const MIST_ROLLED = false; // beta (automaticWeather)
const CLEAR_CHANCES: Record<Kind, number> = { clear: 0, cloudy: 0, rain: 0, storm: 0, mist: 0, snow: 0 };

const CHANGE = 1 / 25;         // of the full change a second (clear to rain in 25 s)
const LIVE_CHANGE = 1 / 150;   // the same while following the real weather: it comes over in a few minutes
// How often the real weather is asked for while it is followed (main.ts), and how long
// the last answer counts: after that the game's own weather takes over again.
export const LIVE_EVERY = 10 * 60, LIVE_LASTS = 45 * 60; // real seconds
const WETTING = 1 / 40, DRYING = 1 / 480;
const SETTLING = 1 / 90, MELTING = 1 / 900;
// Snow cleared off the streets: by the traffic of the hour, up to MOST of it, with
// CLEARING of what's left going an hour at full traffic; falling snow covers them
// again with COVERING of the cleared part an hour, less in busy streets.
const TRAFFIC = [0.05, 0.03, 0.02, 0.02, 0.05, 0.2, 0.5, 0.85, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.9, 0.7, 0.5, 0.35, 0.2, 0.1];
const MOST = 0.9, CLEARING = 1 / (3 * 3600), COVERING = 1 / (2 * 3600);
const trafficAt = (clockT: number) => {
  const h = (clockT % 86400) / 3600, i = Math.floor(h);
  return TRAFFIC[i] + (TRAFFIC[(i + 1) % 24] - TRAFFIC[i]) * (h - i);
};

export class Weather {
  kind: Kind;
  // Picked by hand: it stays.
  fixed: boolean;
  readonly now: Conditions = { ...CLEAR };
  // Following the real weather in Prague (the start screen's "Now"): `follow` brings each
  // new report, and until the last one is too old the weather doesn't change by itself.
  // Picking a weather by hand ends it.
  live = false;
  private liveUntil = 0; // wall-clock expiry, including time asleep or paused in settings
  private next = 0; // clock seconds of the week at the next change
  private flashT = Infinity; // s since the last lightning
  private lastT: number; // the clock at the last update (to notice it being set)
  private rng: () => number;

  constructor(params: URLSearchParams, clockT: number, private season: Season) {
    // A new roll every time the game starts.
    let s = Math.floor(Math.random() * 2147483646) + 1;
    this.rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const asked = params.get('weather') as Kind | null;
    this.fixed = !!asked && KINDS.includes(asked);
    this.kind = this.fixed && asked ? asked : this.pick(clockT);
    this.lastT = clockT;
    this.settle();
    this.next = clockT + this.span();
  }

  // The game begins (the start screen): this weather, at this time, changing by itself
  // after a while unless it was asked for in the URL.
  // `live`: it is the real weather now, to be followed from here on.
  begin(kind: Kind, clockT: number, live = false) {
    if (kind !== this.kind) this.fixed = false;
    this.live = live;
    this.liveUntil = live ? Date.now() + LIVE_LASTS * 1000 : 0;
    this.kind = kind;
    this.lastT = clockT;
    this.settle();
    this.next = clockT + this.span();
  }

  private span() { return (20 + this.rng() * 40) * 60; }

  // What the roll would pick, without changing the weather or shader values (checks).
  preview(clockT: number, season: Season): Kind { return this.pick(clockT, season); }

  private pick(clockT: number, season = this.season): Kind {
    const shares = season.shares();
    const chances = { ...CLEAR_CHANCES };
    for (const s of SEASONS) for (const k of KINDS) chances[k] += shares[s] * CHANCES[s][k];
    const hour = (clockT % 86400) / 3600;
    if (hour > 4 && hour < 10) chances.mist *= 2.5; // mist mostly in the morning
    if (!MIST_ROLLED) chances.mist = 0;
    const total = KINDS.reduce((a, k) => a + chances[k], 0);
    let x = this.rng() * total;
    for (const k of KINDS) if ((x -= chances[k]) < 0) return automaticWeather(k);
    return 'clear';
  }

  // At once, with the ground as it would be after a while of it.
  private settle() {
    const look = LOOK[this.kind];
    Object.assign(this.now, look, { wet: look.rain > 0.5 ? 1 : 0, cover: look.snow > 0.5 ? 1 : 0 });
    this.clearSince(this.lastT);
    this.share();
  }

  // The streets as they'd be at `clockT` after the snow lay whole at midnight.
  private clearSince(clockT: number) {
    const n = this.now, day = clockT - (clockT % 86400);
    n.cleared = 0;
    for (let t = day; t < clockT; t += 60) this.clear(60, t);
  }

  private clear(dt: number, clockT: number) {
    const n = this.now, traffic = trafficAt(clockT);
    n.cleared += (CLEARING * traffic * (MOST - n.cleared) - COVERING * n.snow * (1 - 0.85 * traffic) * n.cleared) * dt;
    n.cleared = Math.min(MOST, Math.max(0, n.cleared));
  }

  private share() {
    WET.value = this.now.wet;
    SNOW.value = this.now.cover;
    STREET_SNOW.value = 1 - this.now.cleared;
    // (Only the puddles' and the water's rings read this: none on the Lowest tier.)
    RAIN.value = this.now.rain * WEATHER_DETAIL.value;
    // The broadleaf trees are bare while their leaves aren't out, and under snow any time.
    BARE.value = Math.max(1 - this.season.leaf, this.now.cover);
    SEASON.value.set(this.season.turn, this.season.blossom, this.season.fresh, 0);
    shareGroundSeason(this.season);
  }

  set(kind: Kind, instantly = false) {
    this.kind = kind;
    this.fixed = true;
    this.live = false;
    if (instantly) this.settle();
  }

  // The real weather as just reported: the game's moves to it gradually. Nothing while
  // the weather is the player's own choice or isn't being followed.
  follow(kind: Kind) {
    if (!this.live || this.fixed) return false;
    this.kind = automaticWeather(kind);
    this.liveUntil = Date.now() + LIVE_LASTS * 1000;
    return true;
  }

  // The next weather in turn (the P key); back to changing by itself after the last.
  cycle() {
    const i = KINDS.indexOf(this.kind);
    this.set(KINDS[(i + 1) % KINDS.length]);
  }

  label() { return t('Weather: {name}', { name: t(NAMES[this.kind]) }); }
  get name() { return t(NAMES[this.kind]); }

  // `dt`: game seconds (faster on a sped-up tram ride); `clockT` the game's clock;
  // `real` the real seconds since the last frame.
  update(dt: number, clockT: number, real = dt) {
    // The clock set to another time (the developer panel): the streets as they'd be then.
    const jumped = Math.abs(clockT - this.lastT - dt) > 120;
    this.lastT = clockT;
    if (jumped && this.now.cover > 0) this.clearSince(clockT);
    const followed = this.live && Date.now() < this.liveUntil;
    if (!this.fixed && !followed && (clockT >= this.next || clockT < this.next - 7200)) {
      this.kind = this.pick(clockT);
      this.next = clockT + this.span();
    }
    if (!this.fixed) this.kind = automaticWeather(this.kind);
    const want = LOOK[this.kind], n = this.now;
    const toward = (v: number, t: number, rate: number) => (v < t ? Math.min(t, v + rate * dt) : Math.max(t, v - rate * dt));
    const change = followed ? LIVE_CHANGE : CHANGE;
    n.cloud = toward(n.cloud, want.cloud, change);
    n.mist = toward(n.mist, want.mist, change * 0.6);
    // Clouds come before the rain and go after it.
    n.rain = toward(n.rain, n.cloud > 0.8 ? want.rain : 0, change);
    n.storm = toward(n.storm, n.rain > 0.8 ? want.storm : 0, change);
    n.snow = toward(n.snow, n.cloud > 0.8 ? want.snow : 0, change);
    n.wet = n.rain > 0.3 ? toward(n.wet, 1, WETTING * n.rain) : toward(n.wet, 0, DRYING * (1 - n.cloud * 0.6));
    n.cover = n.snow > 0.3 ? toward(n.cover, 1, SETTLING * n.snow) : toward(n.cover, 0, MELTING);
    if (n.cover > 0) this.clear(dt, clockT);
    else n.cleared = 0;
    // Lightning (by real time: `real`, not sped up with the clock).
    this.flashT += real;
    if (n.storm > 0.3 && Math.random() < real * STRIKES * n.storm) { this.flashT = 0; n.strikes++; }
    let flash = 0;
    for (let i = 1; i < FLICKER.length; i++) {
      const [t0, a] = FLICKER[i - 1], [t1, b] = FLICKER[i];
      if (this.flashT >= t0 && this.flashT < t1) flash = a + (b - a) * ((this.flashT - t0) / (t1 - t0));
    }
    n.flash = flash;
    this.share();
  }
}

// ---- What falls and drifts --------------------------------------------------------

const RAIN_DROPS = 13000, FLAKES = 10000;
const FALL = 9, FLAKE_FALL = 1.1; // m/s
// The widest a drop's square is, as a multiple of the view's.
export const DROP_SPREAD = 1.5;

// Drops that stay put in the world while the camera moves, so walking or driving through
// the rain looks right. Each wraps round the sides of a square of its own over the view,
// between the view's size and DROP_SPREAD times it, and of a size that doesn't change
// with the view: as the camera rises or comes down (with the car's speed) a drop stays
// where it is until its square is too small or too large, and then takes the next size,
// one drop at a time. (One square for all of them, the size of the view, moved every
// drop whenever the view changed.) Up and down they wrap in the world too.
const WRAP_GLSL = /* glsl */ `
uniform vec3 uCentre; uniform vec2 uBox; uniform float uTime; uniform vec2 uWind;
vec3 dropAt(vec4 seed, float fall, float sway) {
  float own = fract((seed.x + seed.y + seed.z) * 97.);
  float size = pow(${DROP_SPREAD.toFixed(1)}, ceil(log(uBox.x) / log(${DROP_SPREAD.toFixed(1)}) - own) + own);
  vec2 drift = uWind * uTime + sway * vec2(sin(uTime * .9 + seed.w * 6.28), cos(uTime * .7 + seed.w * 4.1));
  vec2 lo = uCentre.xz - size * .5;
  vec2 xz = lo + fract(seed.xz + (drift - lo) / size) * size;
  float y = uCentre.y + fract(seed.y - (uTime * fall + uCentre.y) / uBox.y) * uBox.y;
  return vec3(xz.x, y, xz.y);
}
`;

// What the WebGPU trial's own version (webgpu/weather.ts) gets to build the three from: it
// returns the objects to draw (its snow is a sprite for each flake: points there are 1 px).
export interface FxParts {
  shared: { uCentre: { value: THREE.Vector3 }; uBox: { value: THREE.Vector2 }; uTime: { value: number }; uWind: { value: THREE.Vector2 } };
  rainOn: { value: number }; snowOn: { value: number }; mistOn: { value: number };
  scale: { value: number }; // the snow's size in pixels at a distance of 1 m
  tint: { value: THREE.Color }; fog: { value: THREE.Color };
  rain: THREE.BufferGeometry; snowSeeds: Float32Array; mist: THREE.BufferGeometry;
  // MIST for the shader: 1/bankSize, 1/wispSize, 1/fineSize, thin; bankShare, wispShare, from,
  // from + soft; speed, 1/(sheets - 1).
  mistA: { value: THREE.Vector4 }; mistB: { value: THREE.Vector4 }; mistC: { value: THREE.Vector4 };
}
let fxBy: ((parts: FxParts) => { rain: THREE.Object3D; snow: THREE.Object3D; mist: THREE.Object3D }) | null = null;
export const setFx = (f: typeof fxBy) => { fxBy = f; };

// The mist's shape. The developer panel changes these while the game runs (dev.ts);
// WeatherFx and Sky read them every frame.
export const MIST = {
  haze: 0.06,     // the thin fog over the whole view in mist, as Sky's `amount`
  most: 0.17,     // how much one sheet hides where the mist is thickest
  sheets: 7,      // how many sheets a bank is made of
  low: 0.2,       // the lowest and the highest sheet above the ground (m)
  high: 7.5,
  bankSize: 220,  // how far across a bank is, the wisps in it and their fine edge (m)
  wispSize: 36,
  fineSize: 12,
  bankShare: 0.6, // how much the banks and the wisps count
  wispShare: 0.6,
  from: 0.6,      // where the mist starts (lower: more of the city in mist)
  soft: 0.16,     // how gradually it thickens from there
  thin: 0.01,     // how much thinner the top sheet is than the lowest
  speed: 1,       // how fast it drifts
};
export type Mist = typeof MIST;
export const MIST_DEFAULT: Mist = { ...MIST };
export const MOST_SHEETS = 14;

// The sheets as one mesh, a unit square each, the lowest drawn first; `layer` counts
// them from 0, and the lowest `MIST.sheets` are drawn.
function mistSheets() {
  const at: number[] = [], layer: number[] = [], index: number[] = [];
  for (let k = 0; k < MOST_SHEETS; k++) {
    at.push(-0.5, k, -0.5, 0.5, k, -0.5, -0.5, k, 0.5, 0.5, k, 0.5);
    layer.push(k, k, k, k);
    index.push(k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(at, 3));
  g.setAttribute('layer', new THREE.Float32BufferAttribute(layer, 1));
  g.setIndex(index);
  return g;
}

export class WeatherFx {
  private rain: THREE.Object3D;
  private snow: THREE.Object3D;
  private mist: THREE.Object3D;
  private localMist: LocalMistVolume;
  private shared = {
    uCentre: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector2(200, 40) },
    uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1.5, 0.6) },
    uLampMap: LAMP_MAP, uLampBox: LAMP_BOX, uLampOn: LAMP_ON,
  };
  private rainOn = { value: 0 };
  private snowOn = { value: 0 };
  private mistOn = { value: 0 };
  private mistA = { value: new THREE.Vector4() };
  private mistB = { value: new THREE.Vector4() };
  private mistC = { value: new THREE.Vector4() };
  private mistGeometry: THREE.BufferGeometry;
  private snowScale = { value: 800 };
  // The colours they take from the light (display colours, see Sky).
  readonly tint = { value: new THREE.Color('#9aa3ad') };
  readonly fog = { value: new THREE.Color('#b0b5bb') };
  // The wind that carries what falls (m/s, x and z), for the chimneys' smoke too.
  get wind() { return this.shared.uWind.value; }

  constructor(scene: THREE.Scene) {
    this.localMist = new LocalMistVolume(scene, this.shared.uTime, this.fog);
    const rand = (n: number, per: number) => {
      const a = new Float32Array(n * per * 4);
      for (let i = 0; i < n; i++) {
        const s = [Math.random(), Math.random(), Math.random(), Math.random()];
        for (let k = 0; k < per; k++) a.set(s, (i * per + k) * 4);
      }
      return a;
    };
    // Rain: a streak for each drop, its head and its tail (as far back as it falls in
    // a fraction of a second, so it looks like rain in a photograph).
    const rg = new THREE.BufferGeometry();
    const tail = new Float32Array(RAIN_DROPS * 2);
    for (let i = 0; i < RAIN_DROPS; i++) tail[i * 2 + 1] = 1;
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN_DROPS * 6), 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(rand(RAIN_DROPS, 2), 4));
    rg.setAttribute('tail', new THREE.BufferAttribute(tail, 1));
    // Snow: soft flakes, swaying as they come down.
    const sg = new THREE.BufferGeometry();
    const flakes = rand(FLAKES, 1);
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLAKES * 3), 3));
    sg.setAttribute('seed', new THREE.BufferAttribute(flakes, 4));
    const mistGeometry = this.mistGeometry = mistSheets();
    const by = fxBy?.({
      shared: this.shared, rainOn: this.rainOn, snowOn: this.snowOn, mistOn: this.mistOn, scale: this.snowScale,
      tint: this.tint, fog: this.fog, rain: rg, snowSeeds: flakes, mist: mistGeometry,
      mistA: this.mistA, mistB: this.mistB, mistC: this.mistC,
    });
    this.rain = by ? by.rain : new THREE.LineSegments(rg, new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOn: this.rainOn, uTint: this.tint },
      vertexShader: /* glsl */ `
        attribute vec4 seed; attribute float tail;
        ${WRAP_GLSL}
        ${LAMP_GLSL}
        uniform float uOn;
        varying vec3 vLit; varying float vA;
        void main() {
          vec3 p = dropAt(seed, ${FALL.toFixed(1)}, 0.);
          p -= normalize(vec3(uWind.x, -${FALL.toFixed(1)}, uWind.y)) * tail * (.9 + seed.w * .6);
          vLit = 1. - exp(-lampLight(vec3(p.x, uCentre.y, p.z)) * 2.5);  // lit by the lamps below
          vA = step(seed.w, uOn) * (1. - tail * .7);
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint; varying vec3 vLit; varying float vA;
        void main() {
          gl_FragColor = vec4(uTint + vLit, vA * (.35 + .6 * max(vLit.r, vLit.g)));
        }`,
      transparent: true, depthWrite: false,
    }));
    this.snow = by ? by.snow : new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOn: this.snowOn, uTint: this.tint, uScale: this.snowScale },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        ${WRAP_GLSL}
        ${LAMP_GLSL}
        uniform float uOn; uniform float uScale;
        varying vec3 vLit; varying float vA;
        void main() {
          vec3 p = dropAt(seed, ${FLAKE_FALL.toFixed(1)} * (.7 + seed.w * .6), .8);
          vLit = 1. - exp(-lampLight(vec3(p.x, uCentre.y, p.z)) * 1.5);
          vA = step(seed.w, uOn);
          vec4 mv = viewMatrix * vec4(p, 1.);
          gl_PointSize = max(1.5, uScale * (.12 + .1 * seed.w) / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTint; varying vec3 vLit; varying float vA;
        void main() {
          float d = length(gl_PointCoord - .5) * 2.;
          vec3 c = max(uTint * 1.3, vec3(.32, .34, .38)) + vLit;
          gl_FragColor = vec4(min(c, vec3(1.)), vA * smoothstep(1., .3, d) * .9);
        }`,
      transparent: true, depthWrite: false,
    }));
    // Mist: banks of it lying in the streets, clear air between them. Level sheets one
    // above the other, each with its own drifting holes and thinner the higher it is, so
    // a bank has depth as the view moves past it; roofs stand out of it, and the lamps
    // light it from below.
    this.mist = by ? by.mist : new THREE.Mesh(mistGeometry, new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOn: this.mistOn, uFog: this.fog, uNoise: NOISE, uMistA: this.mistA, uMistB: this.mistB, uMistC: this.mistC },
      vertexShader: /* glsl */ `
        attribute float layer; uniform vec4 uMistC;
        varying vec3 vW; varying float vH;
        void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vH = layer * uMistC.y; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        ${LAMP_GLSL}
        uniform float uOn; uniform float uTime; uniform vec3 uFog; varying vec3 vW; varying float vH;
        uniform vec4 uMistA; uniform vec4 uMistB; uniform vec4 uMistC;
        void main() {
          vec2 p = vW.xz;
          float t = uTime * uMistC.x;
          float bank = vnoise(p * uMistA.x + t * vec2(.006, .002));
          float wisp = vnoise(p * uMistA.y + vH * 1.9 + t * vec2(.03, .012)) * .65
            + vnoise(p * uMistA.z + 7. - vH * 3.1 - t * vec2(.02, .035)) * .35;
          float a = uOn * smoothstep(uMistB.z, uMistB.w, bank * uMistB.x + wisp * uMistB.y - vH * uMistA.w);
          vec3 c = uFog + (1. - exp(-lampLight(vW) * .5)) * .6;
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    for (const o of [this.rain, this.snow, this.mist]) {
      o.frustumCulled = false;
      o.visible = false;
      scene.add(o);
    }
    this.rain.renderOrder = this.snow.renderOrder = 10;
    this.mist.renderOrder = 9;
  }

  // `x, y`: where the camera looks; `ground` the ground's height there; `height` the
  // camera's above it; `r` how far the view reaches.
  update(w: Conditions, t: number, x: number, y: number, ground: number, height: number, r: number, dpr: number,
    mistGround: (x: number, z: number) => number, mistWater: (x: number, z: number) => number | null) {
    const s = this.shared;
    s.uTime.value = t;
    s.uCentre.value.set(x, ground - 2, -y);
    // Up to 15 m under the camera; the box wide enough to fill the view at the top.
    s.uBox.value.set(2 * r + 20, Math.max(10, Math.min(45, height - 15)));
    this.rainOn.value = w.rain;
    s.uWind.value.set(1.5 + 5 * w.storm, 0.6 + 2 * w.storm);
    this.snowOn.value = w.snow;
    this.mistOn.value = Math.min(1, w.mist) * MIST.most;
    this.rain.visible = w.rain > 0.01;
    this.snow.visible = w.snow > 0.01;
    // The Lowest tier draws no mist banks or volumes: the haze over the whole view (Sky) is its mist.
    const banks = WEATHER_DETAIL.value > 0 ? w.mist : 0;
    this.mist.visible = banks > 0.01 && (MIST_MODE.value === 'sheets' || !this.localMist.mesh);
    this.localMist.update(banks, t, x, -y, r, mistGround, mistWater);
    this.snowScale.value = innerHeight * dpr * 1.4;
    const m = MIST, sheets = Math.max(2, Math.min(MOST_SHEETS, Math.round(m.sheets)));
    this.mistA.value.set(1 / m.bankSize, 1 / m.wispSize, 1 / m.fineSize, m.thin);
    this.mistB.value.set(m.bankShare, m.wispShare, m.from, m.from + Math.max(0.01, m.soft));
    this.mistC.value.set(m.speed, 1 / (sheets - 1), 0, 0);
    this.mistGeometry.setDrawRange(0, sheets * 6);
    this.mist.position.set(x, ground + m.low, -y);
    this.mist.scale.set(2.6 * r + 60, Math.max(0.1, m.high - m.low) / (sheets - 1), 2.6 * r + 60);
  }
}
