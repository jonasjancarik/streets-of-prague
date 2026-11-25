import * as THREE from 'three';
import { send } from './gpu.ts';

// Short-lived bits of flying stuff, worked out on the CPU and drawn as one instanced quad
// each: the smoke and flames of burning cars (fire.ts), and the sparks, broken glass and
// bits of bodywork thrown off when cars hit things (debris.ts).
//
// Each kind has its own look:
// - 'smoke': a billowing puff that faces the camera, drawn over the scene (lit by the day).
// - 'glow': a flame or a flash, added to what is behind it.
// - 'spark': a white-hot streak drawn along the way it flies, cooling to red, added.
// - 'chip': a small hard fragment (glass, paint, plastic) that tumbles as it flies.
// A sprite can also lie flat on the ground instead of facing the camera (a scorch mark).

export type SpriteKind = 'smoke' | 'glow' | 'spark' | 'chip';

export interface Sprite {
  x: number; y: number; z: number; // game metres, z up
  vx: number; vy: number; vz: number; // m/s
  r0: number; r1: number; // radius (m) when made and at the end (grows as the square root of age)
  age: number; life: number; // s
  rgb: [number, number, number]; a: number;
  rot: number; spin: number; // rad, rad/s
  seed: number; // 0-1, its own pattern
  fall: number; // m/s² of gravity
  drag: number; // 1/s: how quickly the air slows it
  floor: number; // ground height under it (it bounces off this); -Infinity: no ground
  bounce: number; // what share of its fall it keeps when it bounces
  flat: boolean; // lies flat on the ground
  heat: boolean; // a spark: white-hot to red as it cools
}

export type SpriteInit = Partial<Sprite> & Pick<Sprite, 'x' | 'y' | 'z' | 'r0' | 'life' | 'rgb' | 'a'>;

// The light on things (WeatherFx.tint) and how tall the picture is, shared by every kind.
export const SPRITE_LIGHT = { value: new THREE.Color(1, 1, 1) };
export const SPRITE_PIXELS = { value: 800 };

export interface SpriteParts { kind: SpriteKind; scene: THREE.Scene; light: { value: THREE.Color }; pixels: { value: number } }
// The WebGPU renderer's own version of the materials (webgpu/glows.ts), set before any sprites are made.
let spriteBy: ((parts: SpriteParts) => THREE.Material) | null = null;
export const setSpriteShade = (f: typeof spriteBy) => { spriteBy = f; };

// The old WebGL renderer's: plain soft discs and streaks, no texture.
const VERT = /* glsl */ `
  attribute vec4 at; attribute vec4 tint; attribute vec4 motion;
  uniform float uHalfH;
  varying vec2 vQ; varying vec4 vTint;
  void main() {
    vTint = tint;
    vQ = position.xy;
    vec4 c = modelViewMatrix * vec4(at.xyz, 1.);
    vec2 q = position.xy;
    #ifdef SPARK
      vec3 vel = (modelViewMatrix * vec4(motion.xyz, 0.)).xyz;
      float px = -c.z / (projectionMatrix[1][1] * uHalfH);
      float w = max(at.w, px * 0.8);
      vec2 dir = length(vel.xy) > 1e-4 ? normalize(vel.xy) : vec2(1., 0.);
      float len = max(length(vel.xy) * motion.w, w);
      c.xy += dir * (q.x * .5 - .5) * len + vec2(-dir.y, dir.x) * q.y * w;
      gl_Position = projectionMatrix * c;
    #else
      vec2 r = vec2(motion.x * q.x - motion.y * q.y, motion.y * q.x + motion.x * q.y);
      #ifdef CHIP
        r.x *= motion.z;
      #endif
      if (at.w < 0.) gl_Position = projectionMatrix * modelViewMatrix * vec4(at.xyz + vec3(r.x, 0., r.y) * -at.w, 1.);
      else { c.xy += r * at.w; gl_Position = projectionMatrix * c; }
    #endif
  }`;
const FRAG = /* glsl */ `
  uniform vec3 uLight;
  varying vec2 vQ; varying vec4 vTint;
  void main() {
    #ifdef SPARK
      float a = (1. - vQ.y * vQ.y) * (.35 + .65 * (vQ.x * .5 + .5)) * vTint.a;
      gl_FragColor = vec4(vTint.rgb * a, 1.);
    #elif defined(CHIP)
      if (max(abs(vQ.x), abs(vQ.y)) > .9) discard;
      gl_FragColor = vec4(vTint.rgb * uLight, vTint.a);
    #else
      float a = smoothstep(1., .15, length(vQ)) * vTint.a;
      if (a < .004) discard;
      #ifdef GLOW
        gl_FragColor = vec4(vTint.rgb * a, 1.);
      #else
        gl_FragColor = vec4(vTint.rgb * uLight, a);
      #endif
    #endif
  }`;

function glslMaterial(kind: SpriteKind) {
  const add = kind === 'glow' || kind === 'spark';
  return new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG,
    defines: kind === 'spark' ? { SPARK: 1 } : kind === 'chip' ? { CHIP: 1 } : kind === 'glow' ? { GLOW: 1 } : {},
    uniforms: { uLight: { value: SPRITE_LIGHT.value }, uHalfH: { value: 400 } },
    transparent: true, depthWrite: kind === 'chip', blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
}

const QUAD = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const ORDER: Record<SpriteKind, number> = { chip: 1, smoke: 2, glow: 3, spark: 3 };

export class Sprites {
  readonly mesh: THREE.Mesh;
  readonly kind: SpriteKind;
  list: Sprite[] = [];
  cap: number;
  private at: THREE.InstancedBufferAttribute;
  private tint: THREE.InstancedBufferAttribute;
  private move: THREE.InstancedBufferAttribute;
  private geometry: THREE.InstancedBufferGeometry;
  private material: THREE.Material;

  constructor(scene: THREE.Scene, cap: number, kind: SpriteKind) {
    this.cap = cap;
    this.kind = kind;
    const g = (this.geometry = new THREE.InstancedBufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.at = attr('at');
    this.tint = attr('tint');
    this.move = attr('motion');
    g.instanceCount = 0;
    this.material = spriteBy ? spriteBy({ kind, scene, light: SPRITE_LIGHT, pixels: SPRITE_PIXELS }) : glslMaterial(kind);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ORDER[kind];
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  add(p: SpriteInit) {
    if (this.list.length >= this.cap) this.list.shift();
    this.list.push({
      vx: 0, vy: 0, vz: 0, r1: p.r0, rot: Math.random() * Math.PI * 2, spin: 0, seed: Math.random(),
      fall: 0, drag: 0, floor: -Infinity, bounce: 0, flat: false, heat: false, ...p, age: 0,
    });
  }

  update(dt: number) {
    const at = this.at.array as Float32Array, tint = this.tint.array as Float32Array, mv = this.move.array as Float32Array;
    const spark = this.kind === 'spark', chip = this.kind === 'chip';
    let n = 0;
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k; }
      p.vz -= p.fall * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.rot += p.spin * dt;
      if (p.z < p.floor) {
        // Off the ground: up again with some of its fall, slowed along the ground.
        p.z = p.floor;
        if (p.vz < 0) {
          p.vz = -p.vz * p.bounce;
          p.vx *= 0.55; p.vy *= 0.55;
          p.spin *= 0.5;
          if (p.vz < 0.4) { p.vz = 0; p.vx *= 0.6; p.vy *= 0.6; p.spin *= 0.3; p.fall = 0; }
        }
      }
      const k = p.age / p.life;
      const r = p.r0 + (p.r1 - p.r0) * Math.sqrt(k);
      const o = n * 4;
      at[o] = p.x; at[o + 1] = p.z; at[o + 2] = -p.y; at[o + 3] = p.flat ? -r : r;
      let a: number, cr = p.rgb[0], cg = p.rgb[1], cb = p.rgb[2];
      if (spark) {
        // White-hot, then orange, then a dull red as it cools.
        const h = 1 - k;
        cr *= 0.55 + 0.45 * h; cg *= h * h; cb *= h * h * h;
        a = p.a * (k < 0.75 ? 1 : (1 - k) / 0.25);
        mv[o] = p.vx; mv[o + 1] = p.vz; mv[o + 2] = -p.vy; mv[o + 3] = 0.045;
      } else {
        // In quickly, out slowly (smoke holds for a while first; a chip stays whole and goes in its last quarter).
        const fade = chip ? Math.min(1, (1 - k) / 0.25) : this.kind === 'smoke' ? Math.min(1, (1 - k) * 1.6) : 1 - k;
        a = p.a * fade * (chip ? 1 : Math.min(1, p.age / Math.min(0.12, p.life * 0.2)));
        mv[o] = Math.cos(p.rot); mv[o + 1] = Math.sin(p.rot);
        mv[o + 2] = chip ? 0.25 + 0.75 * Math.abs(Math.cos(p.rot * 1.7 + p.seed * 6)) : p.seed;
        mv[o + 3] = chip ? p.seed : k;
      }
      tint[o] = cr; tint[o + 1] = cg; tint[o + 2] = cb; tint[o + 3] = a;
      n++;
    }
    if (n < this.list.length) this.list = this.list.filter((p) => p.age < p.life);
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    send(this.at, n);
    send(this.tint, n);
    send(this.move, n);
    if (this.material instanceof THREE.ShaderMaterial) {
      this.material.uniforms.uHalfH.value = SPRITE_PIXELS.value / 2;
    }
  }

  clear() { this.list = []; }
}
