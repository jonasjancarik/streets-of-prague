import * as THREE from 'three';

// The light of the time of day: where the sun is over Prague, and the colour and
// strength of the sunlight and of the sky's light, blended between a few moods by the
// sun's height. Weather can later swap these moods for overcast or rainy ones.

const LAT = 50.08 * Math.PI / 180;

// The sun's height and bearing (radians; bearing from north, clockwise) for the time of
// day in Prague and today's date. Near enough for light: no equation of time.
function sunAt(secOfDay: number, date: Date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = (date.getTime() - start) / 86400000;
  const decl = -23.44 * Math.PI / 180 * Math.cos(2 * Math.PI / 365 * (dayOfYear + 10));
  // Solar noon in Prague is about 12:04 in winter time and 13:04 in summer time.
  const month = date.getUTCMonth();
  const noon = 12.04 + (month >= 3 && month <= 9 ? 1 : 0);
  const h = (secOfDay / 3600 - noon) * 15 * Math.PI / 180;
  const sinEl = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(h);
  const el = Math.asin(sinEl);
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(LAT) - Math.tan(decl) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

type Mood = { sun: string; sunI: number; sky: string; ground: string; skyI: number; exposure: number };
// By the sun's height in degrees. Below the horizon the moon takes over (see update).
const MOODS: [number, Mood][] = [
  [-10, { sun: '#8fa6d8', sunI: 0.9, sky: '#2c3a5c', ground: '#16151c', skyI: 1.6, exposure: 2.03 }],
  [-4, { sun: '#8fa6d8', sunI: 0.0, sky: '#4a4e72', ground: '#2a2230', skyI: 1.7, exposure: 1.96 }],
  [1, { sun: '#ffa060', sunI: 1.8, sky: '#948aa4', ground: '#4c3a34', skyI: 1.3, exposure: 1.82 }],
  [8, { sun: '#ffaa66', sunI: 3.0, sky: '#a8aec4', ground: '#6a5444', skyI: 0.95, exposure: 1.69 }],
  [20, { sun: '#ffd1a0', sunI: 3.4, sky: '#b4c2d8', ground: '#7a6a52', skyI: 0.95, exposure: 1.62 }],
  [40, { sun: '#fff0dc', sunI: 3.6, sky: '#c4d4e6', ground: '#857a62', skyI: 1.0, exposure: 1.62 }],
];

const ca = new THREE.Color(), cb = new THREE.Color();
function mix(a: string, b: string, t: number, out: THREE.Color) {
  return out.copy(ca.set(a).convertSRGBToLinear()).lerp(cb.set(b).convertSRGBToLinear(), t).convertLinearToSRGB();
}

// Tone mapping: an extended Reinhard per channel, so bright colours drift towards
// white as on film, a little less saturation and a gentle S-curve. It runs in every
// material, for every ground layer drawn over a pixel; AgX looked much the same and
// cost about 12% of the frame on a big high-density screen, this about 7%.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
  'vec3 CustomToneMapping( vec3 color ) { return color; }',
  `vec3 CustomToneMapping( vec3 color ) {
  if ( toneMappingExposure < 0. ) return color * -toneMappingExposure;   // off (see Sky.curve)
  color *= toneMappingExposure;
  vec3 c = color * ( 1. + color / 36. ) / ( 1. + color );
  c = mix( c, vec3( dot( c, vec3( .2126, .7152, .0722 ) ) ), .2 );
  return mix( c, c * c * ( 3. - 2. * c ), .35 );
}`,
);

// The same curve for one channel, to match its mid-tones when it's off.
function toneCurve(x: number) {
  const c = (x * (1 + x / 36)) / (1 + x);
  return c * 0.65 + c * c * (3 - 2 * c) * 0.35;
}

export class Sky {
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  // From the light towards the target, and how far back the light sits.
  readonly offset = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer;
  // The tone curve (graphics.ts). Without it the light is only scaled so that mid-grey
  // comes out as bright as with it; highlights clip instead of rolling off.
  curve = true;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    renderer.toneMapping = THREE.CustomToneMapping;
    scene.add(this.hemi, this.sun, this.sun.target);
  }

  // `sec`: seconds since midnight on the game's clock.
  update(sec: number) {
    const { el, az } = sunAt(sec, new Date());
    const deg = el * 180 / Math.PI;
    let i = 0;
    while (i < MOODS.length - 2 && deg > MOODS[i + 1][0]) i++;
    const [d0, a] = MOODS[i], [d1, b] = MOODS[i + 1];
    const t = THREE.MathUtils.clamp((deg - d0) / (d1 - d0), 0, 1);
    mix(a.sun, b.sun, t, this.sun.color);
    mix(a.sky, b.sky, t, this.hemi.color);
    mix(a.ground, b.ground, t, this.hemi.groundColor);
    this.sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, t);
    this.hemi.intensity = THREE.MathUtils.lerp(a.skyI, b.skyI, t);
    const exposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);
    this.renderer.toneMappingExposure = this.curve ? exposure : -toneCurve(0.18 * exposure) / 0.18;

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
  }
}
