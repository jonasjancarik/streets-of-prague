import * as THREE from 'three';
import { SKY_REF, STREET_REF, SUN_DIR, SUN_LIGHT, WINDOWS } from './shading.ts';
import { CLEAR, MIST } from './weather.ts';
import { updateClouds } from './clouds.ts';
import type { Conditions } from './weather.ts';
import { GRADE, OLD_GRADE, filmic, ungrade } from './grade.ts';

// The light of the time of day: where the sun is over Prague, and the colour and
// strength of the sunlight and of the sky's light, blended between a few moods by the
// sun's height, then dimmed and greyed by the clouds (weather.ts). Also the fog of
// rain, snow and mist, when the street lamps come on, and how many windows are lit.

const LAT = 50.08 * Math.PI / 180;

// The sun's height and bearing (radians; bearing from north, clockwise) for the time of
// day in Prague on a day of the year (the game's date, season.ts). Near enough for
// light: no equation of time.
function sunAt(secOfDay: number, dayOfYear: number) {
  const decl = -23.44 * Math.PI / 180 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
  // Solar noon in Prague is about 12:04 in winter time and 13:04 in summer time.
  // (Summer time from the end of March to the end of October.)
  const noon = 12.04 + (dayOfYear >= 89 && dayOfYear < 299 ? 1 : 0);
  const h = (secOfDay / 3600 - noon) * 15 * Math.PI / 180;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(h);
  const el = Math.asin(sinEl);
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

type Light = { sun: string; sunI: number; sky: string; skyI: number };
type Mood = Light & { ground: string; exposure: number; clear?: Light };
// By the sun's height in degrees. Below the horizon the moon takes over (see update).
// `clear`: the light under a clear sky, where it differs (mixed in as the clouds clear).
// Under a clear sky the sky's light is blue: what lies in shade is lit by it alone, so
// shade is blue-grey (in Google's aerial photo of Náměstí Míru a shaded pavement keeps
// about 0.4 of the sunlit one's red, 0.5 of its green and 0.7 of its blue). The sun is a
// little warmer and stronger to make up for it, so that sunlit stone stays as warm and as
// light. Under clouds the sky's light stays grey.
const MOODS: [number, Mood][] = [
  [-10, { sun: '#8fa6d8', sunI: 0.5, sky: '#2c3a5c', ground: '#16151c', skyI: 1.0, exposure: 2.03 }],
  [-4, { sun: '#8fa6d8', sunI: 0.0, sky: '#4a4e72', ground: '#2a2230', skyI: 1.45, exposure: 1.96 }],
  [1, { sun: '#ffa060', sunI: 1.8, sky: '#948aa4', ground: '#4c3a34', skyI: 1.3, exposure: 1.93 }],
  // (A low sun lights the street less, and the eye adapts: the exposure opens up as it sinks,
  // so a November afternoon isn't a dimmer copy of a summer noon.)
  [8, { sun: '#ffaa66', sunI: 3.0, sky: '#b4b2bd', ground: '#6a5444', skyI: 1.1, exposure: 1.9,
    clear: { sun: '#ffaa66', sunI: 3.15, sky: '#a2aecb', skyI: 1.0 } }],
  [20, { sun: '#ffd1a0', sunI: 3.4, sky: '#bfc4cc', ground: '#7a6a52', skyI: 1.15, exposure: 1.8,
    clear: { sun: '#ffca90', sunI: 3.65, sky: '#93aedc', skyI: 1.0 } }],
  [40, { sun: '#fff0dc', sunI: 3.6, sky: '#c9cfd6', ground: '#857a62', skyI: 1.2, exposure: 1.62,
    clear: { sun: '#ffe3c0', sunI: 3.9, sky: '#96b4e6', skyI: 1.02 } }],
];

// Under clouds the sky's light is grey by day; at night the clouds glow orange with
// the city's lights.
const OVERCAST = new THREE.Color('#b3b8bf'), CITY_GLOW = new THREE.Color('#5a4d48');
// The share of the sunlight that comes back off the street's sunlit walls into its shade.
const BOUNCE = 0.12;
const SNOWY_GROUND =new THREE.Color('#b9bec6'), LIGHTNING = new THREE.Color('#dfe6ff');
// Fog and mist, as seen (display colours): by day, at night, at night under clouds.
const FOG_DAY = new THREE.Color('#b4b9bf'), FOG_NIGHT = new THREE.Color('#1a1e25'), FOG_GLOW = new THREE.Color('#2c2a2b');
const FOG_SHARE = 0.88; // WebGPU's share of the fog asked for (see Sky.update)
// The sky as seen from the street (webgpu/dome.ts): its colours overhead and at the horizon,
// the clouds' lit edges and grey undersides, the sun's or moon's disc and the glow round it
// (all as what goes in before the tone curve), where the disc stands (w: the cosine of its
// radius), which way the shadows' light comes from, and the air: x how much the fair-weather
// clouds show, y how clouded over the sky is, z how well the stars show.
export const DOME = {
  zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
  cloudLit: { value: new THREE.Color() }, cloudBase: { value: new THREE.Color() },
  disc: { value: new THREE.Color() }, glow: { value: new THREE.Color() },
  sun: { value: new THREE.Vector4(0, 1, 0, 0.9999) }, shade: { value: new THREE.Vector4(0, 1, 0, 0) },
  air: { value: new THREE.Vector4() },
};
// The sky's colours as seen (display colours), clear and clouded over, by day and at night;
// `low`: what a low sun turns the clear ones towards.
const DOME_LOOK = {
  zenith: { day: '#3f76c6', dayGrey: '#8f979f', night: '#070b17', nightGrey: '#232021', low: '#4c6aa6' },
  horizon: { day: '#b9d1e8', dayGrey: '#b4b9bf', night: '#1b2132', nightGrey: '#2c2a2b', low: '#ecc19a' },
  lit: { day: '#fbfaf6', dayGrey: '#c9ced3', night: '#2d313b', nightGrey: '#3b3533', low: '#f6cfa6' },
  base: { day: '#b7c0cb', dayGrey: '#8d9399', night: '#161920', nightGrey: '#2a2625', low: '#8f8798' },
};
const MOON = new THREE.Color('#e3e9f4');
// The sky's node, once the WebGPU side has made it (webgpu.ts): main.ts sets it as the scene's
// background while the horizon can be in view.
export const DOME_NODE: { value: unknown } = { value: null };
const da = new THREE.Color(), db = new THREE.Color(), dl = new THREE.Color();
// The share of lit windows through the day, by the hour.
const LIT = [0.12, 0.08, 0.06, 0.05, 0.06, 0.12, 0.25, 0.3, 0.15, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.15, 0.25, 0.4, 0.45, 0.45, 0.4, 0.3, 0.2];

const ca = new THREE.Color(), cb = new THREE.Color(), cc = new THREE.Color(), seen = new THREE.Color();
function mix(a: string, b: string, t: number, out: THREE.Color) {
  return out.copy(ca.set(a).convertSRGBToLinear()).lerp(cb.set(b).convertSRGBToLinear(), t).convertLinearToSRGB();
}
// A mood's light under so much cloud (0 clear … 1 overcast), into `out`.
const clearA: Light = { sun: '', sunI: 0, sky: '', skyI: 0 }, clearB: Light = { ...clearA }, lc = new THREE.Color();
function lightIn(m: Mood, cloud: number, out: Light): Light {
  if (!m.clear) return m;
  const k = 1 - cloud;
  out.sun = `#${mix(m.sun, m.clear.sun, k, lc).getHexString()}`;
  out.sky = `#${mix(m.sky, m.clear.sky, k, lc).getHexString()}`;
  out.sunI = THREE.MathUtils.lerp(m.sunI, m.clear.sunI, k);
  out.skyI = THREE.MathUtils.lerp(m.skyI, m.clear.skyI, k);
  return out;
}

// Tone mapping and grading (grade.ts): a filmic curve per channel and a little more
// saturation. ?grade=old brings back the curve before it: an extended Reinhard per
// channel, a little less saturation, a gentle S-curve and the shadows lifted a little
// towards warm. (A lookup table would allow any grade, but it needs the scene drawn to a
// target first and graded in a pass of its own.) On the old renderer it runs in every
// material, for every ground layer drawn over a pixel.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  OLD_GRADE ? `vec3 CustomToneMapping( vec3 color ) {
  if ( toneMappingExposure < 0. ) return color * -toneMappingExposure;   // off (see Sky.curve)
  color *= toneMappingExposure;
  vec3 c = color * ( 1. + color / 36. ) / ( 1. + color );
  c = mix( c, vec3( dot( c, vec3( .2126, .7152, .0722 ) ) ), .12 );
  c = mix( c, c * c * ( 3. - 2. * c ), .35 );
  return c + vec3( .016, .012, .006 ) * ( 1. - c );   // the shadows lifted a little, warm
}` : `vec3 CustomToneMapping( vec3 color ) {
  if ( toneMappingExposure < 0. ) return color * -toneMappingExposure;   // off (see Sky.curve)
  vec3 x = max( color * toneMappingExposure, 0. );
  vec3 y = clamp( x * ( ${GRADE.a.toFixed(4)} * x + ${GRADE.b.toFixed(4)} ) / ( x * ( ${GRADE.c.toFixed(4)} * x + ${GRADE.d.toFixed(4)} ) + ${GRADE.e.toFixed(4)} ), 0., 1. );
  float keep = ${GRADE.sat.toFixed(4)} * ( 1. - ${GRADE.fade.toFixed(4)} * smoothstep( ${GRADE.fadeFrom.toFixed(4)}, 1., max( y.r, max( y.g, y.b ) ) ) );
  return clamp( mix( vec3( dot( y, vec3( .2126, .7152, .0722 ) ) ), y, keep ), 0., 1. );
}`,
);

// The same curve for one channel, to match its mid-tones when it's off.
function toneCurve(x: number) {
  if (!OLD_GRADE) return filmic(x);
  const c = (x * (1 + x / 36)) / (1 + x);
  const d = c * 0.65 + c * c * (3 - 2 * c) * 0.35;
  return d + 0.012 * (1 - d);
}

// The colour that the curve turns into `seen` (linear, as it should reach the screen): the curve
// undone step by step, lift, S-curve, saturation and roll-off. For what the WebGPU renderer mixes
// in before the curve but is meant as a colour on the screen (the fog).
function beforeCurve(seen: THREE.Color, exposure: number, out: THREE.Color) {
  if (exposure < 0) return out.copy(seen).multiplyScalar(1 / -exposure); // the curve is off (see Sky.curve)
  if (!OLD_GRADE) { ungrade(seen, exposure, out); return out; }
  const lift = [0.016, 0.012, 0.006], c = [seen.r, seen.g, seen.b].map((y, i) => {
    const h = Math.min(1, Math.max(0, (y - lift[i]) / (1 - lift[i])));
    let lo = 0, hi = 1; // the S-curve rises all the way: halve the interval
    for (let k = 0; k < 20; k++) { const m = (lo + hi) / 2; if (m * 0.65 + m * m * (3 - 2 * m) * 0.35 < h) lo = m; else hi = m; }
    return (lo + hi) / 2;
  });
  // (Mixing towards the brightness keeps the brightness, so it is known here.)
  const luma = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const x = c.map((v) => {
    const u = Math.min(0.999, Math.max(0, (v - 0.12 * luma) / 0.88)), k = 1 - u;
    return 18 * (Math.sqrt(k * k + u / 9) - k) / exposure;
  });
  return out.setRGB(x[0], x[1], x[2]);
}

export class Sky {
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  // From the light towards the target, and how far back the light sits.
  readonly offset = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer;
  private webgpu: boolean;
  // The tone curve (graphics.ts). Without it the light is only scaled so that mid-grey
  // comes out as bright as with it; highlights clip instead of rolling off.
  curve = true;
  // How dark it is, for the street lamps: 0 by day, 1 at night.
  dark = 0;
  // How hazy the air is (0 clear … about 0.55 in thick mist), for the lights' beams.
  murk = 0;
  // The view is from the street (first person): the haze there takes the horizon's colour, so
  // that the far end of a street fades into the sky behind it.
  street = false;
  // Always there (switching it on and off would compile every shader again); it
  // starts beyond the view when there's nothing to see.
  readonly fog = new THREE.Fog(0xffffff, 1e5, 1e5 + 1);
  // The colour of the fog and of the rain as seen, for WeatherFx.
  readonly haze = new THREE.Color();
  readonly tint = new THREE.Color();

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    this.webgpu = !!(renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer;
    renderer.toneMapping = THREE.CustomToneMapping;
    scene.add(this.hemi, this.sun, this.sun.target);
    scene.fog = this.fog;
  }

  // `sec`: seconds since midnight on the game's clock; `w` the weather; `height` how
  // high the camera is above the ground (the fog is measured from it); `date` the day
  // of the year.
  update(sec: number, w: Conditions = CLEAR, height = 100, date = 172) {
    const { el, az } = sunAt(sec, date);
    const deg = el * 180 / Math.PI;
    let i = 0;
    while (i < MOODS.length - 2 && deg > MOODS[i + 1][0]) i++;
    const [d0, a] = MOODS[i], [d1, b] = MOODS[i + 1];
    const t = THREE.MathUtils.clamp((deg - d0) / (d1 - d0), 0, 1);
    // (The clear sky's light as far as the clouds let it through.)
    const ac = lightIn(a, w.cloud, clearA), bc = lightIn(b, w.cloud, clearB);
    mix(ac.sun, bc.sun, t, this.sun.color);
    mix(ac.sky, bc.sky, t, this.hemi.color);
    mix(a.ground, b.ground, t, this.hemi.groundColor);
    this.sun.intensity = THREE.MathUtils.lerp(ac.sunI, bc.sunI, t);
    this.hemi.intensity = THREE.MathUtils.lerp(ac.skyI, bc.skyI, t);
    let exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);

    // Clouds: the sun hidden (and its shadows faint), the sky's light grey and a
    // little stronger, as the whole sky shines, or orange from the city at night.
    const night = THREE.MathUtils.clamp((2 - deg) / 8, 0, 1);
    this.sun.intensity *= 1 - 0.65 * w.cloud;
    // Drifting shadows of single clouds in fair weather only: under a clouded sky the sun is
    // hidden already, and at night there's no sun to hide.
    const patchy = 0.6 * (1 - THREE.MathUtils.smoothstep(w.cloud, 0.15, 0.6)) * (1 - w.mist) * THREE.MathUtils.smoothstep(deg, 4, 16);
    updateClouds(performance.now() / 1000, patchy);
    this.hemi.color.lerp(cc.copy(OVERCAST).lerp(CITY_GLOW, night), w.cloud * 0.35);
    this.hemi.intensity *= 1 + 0.15 * w.cloud * (1 - night);
    this.hemi.groundColor.lerp(SNOWY_GROUND, w.cover * 0.5 * (1 - night * 0.6));
    exposure *= 1 + 0.12 * w.cloud;
    // Lightning lights up everything for a moment, blue-white.
    if (w.flash > 0) {
      this.hemi.color.lerp(LIGHTNING, Math.min(1, w.flash));
      this.hemi.intensity += w.flash * 5;
    }
    // The lamps come on at dusk, earlier under heavy cloud.
    this.dark = THREE.MathUtils.clamp((3 + 3 * w.cloud - deg) / 7, 0, 1);
    const hour = Math.floor(sec / 3600) % 24;
    WINDOWS.value = THREE.MathUtils.lerp(LIT[hour], LIT[(hour + 1) % 24], (sec % 3600) / 3600) * this.dark;
    // Puddles mirror the sky above.
    SKY_REF.value.copy(this.hemi.color).multiplyScalar(this.hemi.intensity * 0.06 * (1 - night * 0.8));
    // Cars mirror the street round them under the sky: its walls and trees, lit like the
    // ground, darker than the sky (car.ts).
    STREET_REF.value.copy(this.hemi.groundColor).lerp(this.hemi.color, 0.25).multiplyScalar(this.hemi.intensity * 0.06 * 0.55 * (1 - night * 0.8));
    // Sunlight thrown back into the street by the sunlit walls and paving, warm, into what
    // lies in shade. The lower the sun, the more of it the walls catch (by the cosine of its
    // height) while the ground gets less: on a winter afternoon it is much of what lights a
    // shaded pavement. (After the reflections above: puddles mirror the sky, not the walls.)
    const bounce = BOUNCE * this.sun.intensity * Math.cos(el) * THREE.MathUtils.smoothstep(deg, -2, 4);
    cc.copy(this.hemi.color).multiplyScalar(this.hemi.intensity).add(lc.copy(this.sun.color).multiplyScalar(bounce));
    this.hemi.color.copy(cc.multiplyScalar(1 / this.hemi.intensity));

    // Fog, measured from the camera: `amount` of it on the ground right below, more
    // further off, less on the roofs.
    // Mist lies in banks (WeatherFx), so the air between them is only a little hazy; the
    // lights' beams show in it as in thick fog.
    // (Rain is thinner than it looks from the street: from above, a fifth of fog greyed the whole city.)
    const amount = Math.max(0.08 * w.cloud, 0.11 * w.rain, 0.3 * w.snow, MIST.haze * w.mist);
    this.murk = Math.max(amount, 0.55 * w.mist);
    const day = 1 - night;
    // (The old renderer mixes the fog in after its curve and its sRGB encoding, so it takes the
    // colour's sRGB numbers as they are; `seen` is the same colour in linear light.)
    seen.copy(FOG_NIGHT).lerp(FOG_GLOW, w.cloud).lerp(FOG_DAY, day);
    this.haze.copy(seen).convertLinearToSRGB();
    this.tint.copy(this.haze).multiplyScalar(0.8 + 0.3 * day);
    if (amount < 0.01) this.fog.near = this.fog.far = 1e5;
    else {
      // Mixed in before the curve and the sRGB encoding (WebGPU), the same share of fog lightens
      // dark ground more than mixed in on the screen's colours: measured on wet paving in rain at
      // 14:00, as much as 1.1 to 1.2 times the share would there (two runs). A smaller share makes
      // up for it, at no cost in the shader. (Surfaces as light as the fog get a little less of it than before.)
      const share = this.webgpu ? amount * FOG_SHARE : amount;
      const x = 0.5 - Math.sin(Math.asin(1 - 2 * share) / 3); // the inverse of smoothstep
      this.fog.near = 0.5 * height;
      this.fog.far = this.fog.near + (height - this.fog.near) / x;
    }
    if (!OLD_GRADE) exposure *= GRADE.gain;
    this.renderer.toneMappingExposure = this.curve ? exposure : -toneCurve(0.18 * exposure) / 0.18;
    // WebGPU mixes the fog in before the tone curve: there it gets the colour the curve turns into
    // the one meant. (Given the screen's colour, it came out far too light: by day a grey of 0.71
    // was drawn as 0.80, at night one of 0.10 as 0.45, which read as much thicker fog.)
    if (this.webgpu) beforeCurve(seen, this.renderer.toneMappingExposure, this.fog.color);
    else this.fog.color.copy(this.haze);

    // Kept a little above the horizon so shadows don't run off for hundreds of metres
    // at sunset; at night the moon stands high in the south-west.
    let lightEl: number, lightAz: number;
    if (deg > -4) { lightEl = Math.max(el, 15 * Math.PI / 180); lightAz = az; }
    else { lightEl = 50 * Math.PI / 180; lightAz = Math.PI + 0.5; }
    const dist = 300;
    this.offset.set(
      Math.sin(lightAz) * Math.cos(lightEl) * dist,
      Math.sin(lightEl) * dist,
      -Math.cos(lightAz) * Math.cos(lightEl) * dist,
    );
    // The sky from the street. (Each colour: clear to clouded by day, the same at night, then
    // between day and night; a low sun warms the clear day's.)
    const low = (1 - THREE.MathUtils.smoothstep(deg, 2, 14)) * (1 - w.cloud), ex = this.renderer.toneMappingExposure;
    const look = (c: { day: string; dayGrey: string; night: string; nightGrey: string; low: string }, out: THREE.Color) => {
      da.set(c.day).lerp(dl.set(c.low), low * 0.8).lerp(db.set(c.dayGrey), w.cloud);
      db.set(c.night).lerp(dl.set(c.nightGrey), w.cloud);
      return beforeCurve(da.lerp(db, night), ex, out);
    };
    look(DOME_LOOK.zenith, DOME.zenith.value);
    look(DOME_LOOK.horizon, DOME.horizon.value);
    look(DOME_LOOK.lit, DOME.cloudLit.value);
    look(DOME_LOOK.base, DOME.cloudBase.value);
    if (this.street && this.webgpu) this.fog.color.copy(DOME.horizon.value).lerp(this.fog.color, Math.min(1, amount * 2.5));
    // The sun where it really stands (the light is kept higher for the shadows' sake), the
    // moon once it is down; behind clouds the disc is gone and the glow is weak.
    const up = deg > -4, discEl = up ? el : lightEl, discAz = up ? az : lightAz, clear = 1 - w.cloud;
    DOME.sun.value.set(Math.sin(discAz) * Math.cos(discEl), Math.sin(discEl), -Math.cos(discAz) * Math.cos(discEl), up ? 0.99988 : 0.99975);
    DOME.shade.value.set(this.offset.x, this.offset.y, this.offset.z, 0).normalize();
    const sunUp = THREE.MathUtils.smoothstep(deg, -3, 2);
    if (up) {
      DOME.disc.value.copy(this.sun.color).multiplyScalar(40 * sunUp * clear * clear);
      DOME.glow.value.copy(this.sun.color).multiplyScalar((0.1 + 0.25 * low) * sunUp * (0.25 + 0.75 * clear) / Math.max(Math.abs(ex), 0.01) * 0.84);
    } else {
      beforeCurve(MOON, ex, DOME.disc.value).multiplyScalar(clear * clear);
      DOME.glow.value.copy(DOME.disc.value).multiplyScalar(0.02);
    }
    const fairSky = (1 - THREE.MathUtils.smoothstep(w.cloud, 0.15, 0.6)) * (1 - w.mist);
    DOME.air.value.set(fairSky, THREE.MathUtils.smoothstep(w.cloud, 0.1, 0.95), night * clear * (1 - w.mist), 0);

    // The water glitters towards it.
    SUN_DIR.value.copy(this.offset).normalize();
    SUN_LIGHT.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
  }
}
