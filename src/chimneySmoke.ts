import * as THREE from 'three';

// Smoke from the chimneys in the cold months and whenever snow lies: mostly vapour, so a
// thin pale wisp that leans with the wind and is gone a few metres on. Only some chimneys
// smoke (the tile worker picks them, map/roofClutter.ts).
//
// Each tile has its own points, a few puffs for every smoking chimney, all drawn by one
// shared material. Nothing is written after a tile is made: a puff's age comes from the
// time in the shader, which moves it along, swells it and fades it.

const PUFFS = 10;   // to a chimney
const LIFE = 5.5;    // s a puff lasts
const RISE = 0.9;   // m/s, slowing as it cools
const REACH = 30;   // m a puff can get from its chimney (for leaving tiles out of the picture)

const uTime = { value: 0 }, uOn = { value: 0 }, uScale = { value: 800 };
const uWind = { value: new THREE.Vector2(1.5, 0.6) };
const tint = { value: new THREE.Color('#9aa3ad') };

// The WebGPU renderer's own version (webgpu/glows.ts), set before any smoke is made: points
// are one pixel wide there, so each puff is a small quad. It gets the numbers the update
// writes each frame, and returns the material for the puffs' quads.
export interface SmokeParts {
  scene: THREE.Scene; life: number; rise: number;
  uTime: { value: number }; uOn: { value: number }; uScale: { value: number };
  uWind: { value: THREE.Vector2 }; tint: { value: THREE.Color };
}
let smokeBy: ((parts: SmokeParts) => THREE.Material) | null = null;
export const setSmokeDrawing = (f: typeof smokeBy) => { smokeBy = f; };

let material: THREE.Material | null = null;
const live = new Set<THREE.Object3D>();
let shown = false;

function shared(scene: THREE.Scene) {
  if (material) return material;
  if (smokeBy) return (material = smokeBy({ scene, life: LIFE, rise: RISE, uTime, uOn, uScale, uWind, tint }));
  return (material = new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime, uOn, uScale, uWind, uTint: tint },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      attribute vec2 puff;
      uniform float uTime; uniform float uOn; uniform float uScale; uniform vec2 uWind;
      varying float vA;
      void main() {
        float life = ${LIFE.toFixed(1)} * (.8 + .4 * puff.x);
        float k = fract(uTime / life + puff.y), t = k * life;
        vec2 gust = vec2(sin(uTime * .5 + puff.x * 40. + k * 5.), cos(uTime * .4 + puff.x * 23. + k * 4.));
        vec3 p = position + vec3(uWind.x, 0., uWind.y) * t * (.35 + .65 * k) + vec3(gust.x, 0., gust.y) * .6 * k;
        p.y += ${RISE.toFixed(2)} * t * (1. - .45 * k);
        float wisp = fract(puff.y * 7.31); // each puff's own share: a plume comes in wisps
        vA = uOn * (.5 + .5 * puff.x) * (.25 + .75 * wisp) * smoothstep(0., .12, k) * pow(1. - k, 1.5);
        vec4 mvPosition = viewMatrix * vec4(p, 1.);
        gl_PointSize = uScale * mix(.6, 3.2, sqrt(k)) * (.7 + .6 * wisp) / -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <fog_pars_fragment>
      uniform vec3 uTint; varying float vA;
      void main() {
        float d = length(gl_PointCoord - .5) * 2.;
        float a = vA * smoothstep(1., 0., d) * .15;
        if (a < .004) discard;
        gl_FragColor = vec4(min(max(uTint * 1.25, vec3(.3, .32, .36)), vec3(.96)), a);
        #include <fog_fragment>
      }`,
    fog: true, transparent: true, depthWrite: false,
  }));
}

// The smoke of a tile's chimneys: `at`, the tops of those that smoke (x, height, z each).
export function chimneySmoke(at: Float32Array, scene: THREE.Scene): THREE.Object3D | null {
  const chimneys = at.length / 3, n = chimneys * PUFFS;
  if (!n) return null;
  const from = new Float32Array(n * 3), puff = new Float32Array(n * 2);
  const box = new THREE.Box3();
  for (let c = 0; c < chimneys; c++) {
    const x = at[c * 3], y = at[c * 3 + 1], z = at[c * 3 + 2], own = Math.random(), phase = Math.random();
    box.expandByPoint(new THREE.Vector3(x, y, z));
    for (let j = 0; j < PUFFS; j++) {
      const i = c * PUFFS + j;
      from.set([x, y, z], i * 3);
      puff.set([own, phase + j / PUFFS], i * 2);
    }
  }
  const m = shared(scene);
  let o: THREE.Points | THREE.Mesh;
  if (smokeBy) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('start', new THREE.InstancedBufferAttribute(from, 3));
    g.setAttribute('puff', new THREE.InstancedBufferAttribute(puff, 2));
    g.instanceCount = n;
    o = new THREE.Mesh(g, m);
  } else {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(from, 3));
    g.setAttribute('puff', new THREE.BufferAttribute(puff, 2));
    o = new THREE.Points(g, m);
  }
  o.geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  o.geometry.boundingSphere.radius += REACH;
  o.renderOrder = 8; // over the roofs, under the mist and what falls
  o.visible = shown;
  live.add(o);
  return o;
}

// A tile's smoke, when the tile's meshes go.
export function dropChimneySmoke(o: THREE.Object3D) {
  live.delete(o);
  (o as THREE.Mesh).geometry.dispose();
}

// `amount`: how much the chimneys smoke, 0-1; `t` the time (s); `wind` as the rain's and
// the snow's (m/s, x and z); `light` the light on things (WeatherFx.tint); `pixels` how
// tall the picture is, in pixels.
export function updateChimneySmoke(amount: number, t: number, wind: THREE.Vector2, light: THREE.Color, pixels: number) {
  uTime.value = t;
  uOn.value = amount;
  uScale.value = pixels * 1.4;
  uWind.value.copy(wind);
  tint.value.copy(light);
  const on = amount > 0.01;
  if (on === shown) return;
  shown = on;
  for (const o of live) o.visible = on;
}
