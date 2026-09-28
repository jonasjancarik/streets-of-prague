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
  [-10, { sun: '#8fa6d8', sunI: 0.9, sky: '#2c3a5c', ground: '#16151c', skyI: 1.6, exposure: 1.5 }],
  [-4, { sun: '#8fa6d8', sunI: 0.0, sky: '#4a4e72', ground: '#2a2230', skyI: 1.7, exposure: 1.45 }],
  [1, { sun: '#ffa060', sunI: 1.8, sky: '#948aa4', ground: '#4c3a34', skyI: 1.3, exposure: 1.35 }],
  [8, { sun: '#ffaa66', sunI: 3.0, sky: '#a8aec4', ground: '#6a5444', skyI: 0.95, exposure: 1.25 }],
  [20, { sun: '#ffd1a0', sunI: 3.4, sky: '#b4c2d8', ground: '#7a6a52', skyI: 0.95, exposure: 1.2 }],
  [40, { sun: '#fff0dc', sunI: 3.6, sky: '#c4d4e6', ground: '#857a62', skyI: 1.0, exposure: 1.2 }],
];

const ca = new THREE.Color(), cb = new THREE.Color();
function mix(a: string, b: string, t: number, out: THREE.Color) {
  return out.copy(ca.set(a).convertSRGBToLinear()).lerp(cb.set(b).convertSRGBToLinear(), t).convertLinearToSRGB();
}

export class Sky {
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  // From the light towards the target, and how far back the light sits.
  readonly offset = new THREE.Vector3();
  private renderer: THREE.WebGLRenderer;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    renderer.toneMapping = THREE.AgXToneMapping;
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
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exposure, b.exposure, t);

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
