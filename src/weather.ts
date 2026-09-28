import * as THREE from 'three';
import { WET, SNOW, RAIN, NOISE_GLSL } from './shading.ts';
import { LAMP_GLSL, LAMP_MAP, LAMP_BOX, LAMP_ON } from './lamps.ts';

// The weather: clear, cloudy, rain, a thunderstorm, mist or snow. Each is a mix of
// cloud, rain, storm, snow and mist (0–1), and the weather moves between them
// gradually; in a storm lightning flashes now and then (thunder in audio.ts).
// The ground gets wet in the rain and dries slowly after it; snow settles and melts
// slower still. It changes by itself every half hour or so of the game's clock, more
// often to rain in summer and to snow and mist in winter, unless it's been picked
// (?weather=clear|cloudy|rain|storm|mist|snow, the P key or the developer panel).
//
// Sky (sky.ts) turns it into light and fog; WeatherFx draws the falling rain and snow
// and the drifting mist; the ground and the buildings get wet and snowy in their
// shaders (shading.ts).

export type Kind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'mist' | 'snow';
export const KINDS: Kind[] = ['clear', 'cloudy', 'rain', 'storm', 'mist', 'snow'];
// `flash`: lightning, 0–1 as it flickers; `strikes` counts them (for the thunder).
export interface Conditions { cloud: number; rain: number; storm: number; snow: number; mist: number; wet: number; cover: number; flash: number; strikes: number }
export const CLEAR: Conditions = { cloud: 0, rain: 0, storm: 0, snow: 0, mist: 0, wet: 0, cover: 0, flash: 0, strikes: 0 };

const LOOK: Record<Kind, { cloud: number; rain: number; storm: number; snow: number; mist: number }> = {
  clear: { cloud: 0, rain: 0, storm: 0, snow: 0, mist: 0 },
  cloudy: { cloud: 0.85, rain: 0, storm: 0, snow: 0, mist: 0 },
  rain: { cloud: 1, rain: 1, storm: 0, snow: 0, mist: 0.12 },
  storm: { cloud: 1, rain: 1, storm: 1, snow: 0, mist: 0.2 },
  mist: { cloud: 0.6, rain: 0, storm: 0, snow: 0, mist: 1 },
  snow: { cloud: 0.95, rain: 0, storm: 0, snow: 1, mist: 0.15 },
};
const NAMES: Record<Kind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', mist: 'Mist', snow: 'Snow' };
// Lightning: strikes a second at full storm, and how a flash flickers (s, brightness).
const STRIKES = 1 / 9;
const FLICKER: [number, number][] = [[0, 1], [0.07, 0.15], [0.14, 0.85], [0.22, 0.3], [0.3, 0.5], [0.7, 0]];

// How likely each weather is to come next, by season.
const CHANCES: Record<'winter' | 'spring' | 'summer' | 'autumn', Record<Kind, number>> = {
  winter: { clear: 2, cloudy: 4, rain: 1, storm: 0, mist: 2, snow: 3 },
  spring: { clear: 4, cloudy: 3, rain: 2, storm: 0.3, mist: 0.5, snow: 0.2 },
  summer: { clear: 6, cloudy: 2, rain: 1.5, storm: 0.7, mist: 0.2, snow: 0 },
  autumn: { clear: 3, cloudy: 4, rain: 2.5, storm: 0.1, mist: 2, snow: 0.2 },
};
const season = (month: number) => month === 11 || month < 2 ? 'winter' : month < 5 ? 'spring' : month < 8 ? 'summer' : 'autumn';

const CHANGE = 1 / 25;         // of the full change a second (clear to rain in 25 s)
const WETTING = 1 / 40, DRYING = 1 / 480;
const SETTLING = 1 / 90, MELTING = 1 / 900;

export class Weather {
  kind: Kind;
  // Picked by hand: it stays.
  fixed: boolean;
  readonly now: Conditions = { ...CLEAR };
  private next = 0; // clock seconds of the week at the next change
  private flashT = Infinity; // s since the last lightning
  private rng: () => number;

  constructor(params: URLSearchParams, clockT: number) {
    // The same weather for the same day and hour.
    let s = Math.floor(Date.now() / 3600000) % 2147483646 + 1;
    this.rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const asked = params.get('weather') as Kind | null;
    this.fixed = !!asked && KINDS.includes(asked);
    this.kind = this.fixed && asked ? asked : this.pick(clockT);
    this.settle();
    this.next = clockT + this.span();
  }

  private span() { return (20 + this.rng() * 40) * 60; }

  private pick(clockT: number): Kind {
    const chances = { ...CHANCES[season(new Date().getMonth())] };
    const hour = (clockT % 86400) / 3600;
    if (hour > 4 && hour < 10) chances.mist *= 2.5; // mist mostly in the morning
    const total = KINDS.reduce((a, k) => a + chances[k], 0);
    let x = this.rng() * total;
    for (const k of KINDS) if ((x -= chances[k]) < 0) return k;
    return 'clear';
  }

  // At once, with the ground as it would be after a while of it.
  private settle() {
    const look = LOOK[this.kind];
    Object.assign(this.now, look, { wet: look.rain > 0.5 ? 1 : 0, cover: look.snow > 0.5 ? 1 : 0 });
    this.share();
  }

  private share() {
    WET.value = this.now.wet;
    SNOW.value = this.now.cover;
    RAIN.value = this.now.rain;
  }

  set(kind: Kind, instantly = false) {
    this.kind = kind;
    this.fixed = true;
    if (instantly) this.settle();
  }

  // The next weather in turn (the P key); back to changing by itself after the last.
  cycle() {
    const i = KINDS.indexOf(this.kind);
    this.set(KINDS[(i + 1) % KINDS.length]);
  }

  label() { return `Weather: ${NAMES[this.kind]}`; }
  get name() { return NAMES[this.kind]; }

  // `dt`: game seconds (faster on a sped-up tram ride); `clockT` the game's clock;
  // `real` the real seconds since the last frame.
  update(dt: number, clockT: number, real = dt) {
    if (!this.fixed && (clockT >= this.next || clockT < this.next - 7200)) {
      this.kind = this.pick(clockT);
      this.next = clockT + this.span();
    }
    const want = LOOK[this.kind], n = this.now;
    const toward = (v: number, t: number, rate: number) => (v < t ? Math.min(t, v + rate * dt) : Math.max(t, v - rate * dt));
    n.cloud = toward(n.cloud, want.cloud, CHANGE);
    n.mist = toward(n.mist, want.mist, CHANGE * 0.6);
    // Clouds come before the rain and go after it.
    n.rain = toward(n.rain, n.cloud > 0.8 ? want.rain : 0, CHANGE);
    n.storm = toward(n.storm, n.rain > 0.8 ? want.storm : 0, CHANGE);
    n.snow = toward(n.snow, n.cloud > 0.8 ? want.snow : 0, CHANGE);
    n.wet = n.rain > 0.3 ? toward(n.wet, 1, WETTING * n.rain) : toward(n.wet, 0, DRYING * (1 - n.cloud * 0.6));
    n.cover = n.snow > 0.3 ? toward(n.cover, 1, SETTLING * n.snow) : toward(n.cover, 0, MELTING);
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

const RAIN_DROPS = 9000, FLAKES = 7000;
const FALL = 9, FLAKE_FALL = 1.1; // m/s

// Drops in a box over the view that stays put in the world while the camera moves
// (they wrap round its sides), so walking or driving through the rain looks right.
const WRAP_GLSL = /* glsl */ `
uniform vec3 uCentre; uniform vec2 uBox; uniform float uTime; uniform vec2 uWind;
vec3 dropAt(vec4 seed, float fall, float sway) {
  float size = uBox.x;
  vec2 drift = uWind * uTime + sway * vec2(sin(uTime * .9 + seed.w * 6.28), cos(uTime * .7 + seed.w * 4.1));
  vec2 lo = uCentre.xz - size * .5;
  vec2 xz = lo + fract(seed.xz + (drift - lo) / size) * size;
  float y = uCentre.y + fract(seed.y - uTime * fall / uBox.y) * uBox.y;
  return vec3(xz.x, y, xz.y);
}
`;

export class WeatherFx {
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private mist: THREE.Mesh;
  private shared = {
    uCentre: { value: new THREE.Vector3() }, uBox: { value: new THREE.Vector2(200, 40) },
    uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1.5, 0.6) },
    uLampMap: LAMP_MAP, uLampBox: LAMP_BOX, uLampOn: LAMP_ON,
  };
  private rainOn = { value: 0 };
  private snowOn = { value: 0 };
  private mistOn = { value: 0 };
  // The colours they take from the light (display colours, see Sky).
  readonly tint = { value: new THREE.Color('#9aa3ad') };
  readonly fog = { value: new THREE.Color('#b0b5bb') };

  constructor(scene: THREE.Scene) {
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
    this.rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
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
    // Snow: soft flakes, swaying as they come down.
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FLAKES * 3), 3));
    sg.setAttribute('seed', new THREE.BufferAttribute(rand(FLAKES, 1), 4));
    this.snow = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOn: this.snowOn, uTint: this.tint, uScale: { value: 800 } },
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
    // Mist: a drifting sheet a few metres above the ground, taller buildings standing
    // out of it, lit from below by the lamps.
    this.mist = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOn: this.mistOn, uFog: this.fog },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        ${LAMP_GLSL}
        uniform float uOn; uniform float uTime; uniform vec3 uFog; varying vec3 vW;
        void main() {
          vec2 p = vW.xz * .014 + uTime * vec2(.010, .004);
          float n = fbm2(p + .5 * fbm2(p * .6 + 3.) - uTime * vec2(.004, .007)) * .75 + vnoise(p * 4.1 + 5.) * .25;
          float a = uOn * (.18 + .5 * smoothstep(.3, .75, n));
          vec3 c = uFog + (1. - exp(-lampLight(vW) * .5)) * .6;
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true, depthWrite: false,
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
  update(w: Conditions, t: number, x: number, y: number, ground: number, height: number, r: number, dpr: number) {
    const s = this.shared;
    s.uTime.value = t;
    s.uCentre.value.set(x, ground - 2, -y);
    // Up to 15 m under the camera; the box wide enough to fill the view at the top.
    s.uBox.value.set(2 * r + 20, Math.max(10, Math.min(45, height - 15)));
    this.rainOn.value = w.rain;
    s.uWind.value.set(1.5 + 5 * w.storm, 0.6 + 2 * w.storm);
    this.snowOn.value = w.snow;
    this.mistOn.value = Math.min(1, w.mist) * 0.62;
    this.rain.visible = w.rain > 0.01;
    this.snow.visible = w.snow > 0.01;
    this.mist.visible = w.mist > 0.01;
    (this.snow.material as THREE.ShaderMaterial).uniforms.uScale.value = innerHeight * dpr * 1.4;
    this.mist.position.set(x, ground + 3.5, -y);
    this.mist.scale.set(2.6 * r + 60, 1, 2.6 * r + 60);
  }
}
