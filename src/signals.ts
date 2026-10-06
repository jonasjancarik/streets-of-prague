import { dataUrl } from './data.ts';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lampLit, LAMP_ON } from './lamps.ts';
import { Polyline, offsetLine } from './network.ts';
import type { DriveEdge, Route } from './network.ts';
import { send, sendInstances } from './gpu.ts';

// Traffic lights at junctions (pipeline/build_signals.py, data/<area>_now/signals.json).
// Each junction runs a cycle of two phases, the streets along its main street and
// those across it: green, amber, all red, then the other phase, with red and amber
// together just before a green, as in Czech lights. The traffic stops at red and at
// amber when it still can; each light stands on a pole at the kerb by the stop line.

// The WebGPU trial's own version of the glow (webgpu/glows.ts), set before the signals are made.
let glowBy: (() => THREE.Material) | null = null;
export const setSignalGlow = (f: typeof glowBy) => { glowBy = f; };

export const GREEN = 0, AMBER = 1, RED = 2, READY = 3; // READY: red and amber together
const AMBER_T = 3, CLEAR = 2, READY_T = 1.5;
// How far ahead cars look for a light (m), and the hardest they brake for one (m/s²):
// at amber they only stop if it's easy, at red unless it's too late.
const LOOK = 70, EASY = 3.5, HARD = 7;
const MAX_HEADS = 800;
const COLOURS = [new THREE.Color('#22ff88'), new THREE.Color('#ffae00'), new THREE.Color('#ff2414')];
const OFF = [new THREE.Color('#0c1a12'), new THREE.Color('#1c150a'), new THREE.Color('#1e0c0a')];

interface Junction { g0: number; g1: number; offset: number }
export interface Signal { stop: number; j: Junction; phase: number; pole?: [number, number] } // pole: where it stands, surveyed
interface Head { e: DriveEdge; sig: Signal; x: number; y: number; ang: number }
interface SignalsJSON { junctions: [number, number, number][]; edges: Record<string, [number, number, number, number?, number?]> }

// What a light shows at time t (s).
export function light(sig: Signal, t: number) {
  const j = sig.j, cycle = j.g0 + j.g1 + 2 * (AMBER_T + CLEAR);
  const start = sig.phase ? j.g0 + AMBER_T + CLEAR : 0, green = sig.phase ? j.g1 : j.g0;
  const k = (((t + j.offset - start) % cycle) + cycle) % cycle;
  if (k < green) return GREEN;
  if (k < green + AMBER_T) return AMBER;
  return k > cycle - READY_T ? READY : RED;
}

export class Signals {
  private byId = new Map<string, Signal>();
  private heads: Head[] = [];
  private known = new Set<DriveEdge>();
  private pending: DriveEdge[][] = [];
  private loaded = false;
  private time: () => number;
  private onRoad: (x: number, y: number) => boolean;
  private height: (x: number, y: number, bridge: boolean) => number;
  private near: Head[] = [];
  private nearAt = { x: Infinity, y: Infinity, r: 0, asked: 0, t: 0 }; // r: the radius gathered, asked: the one asked for
  private poles: THREE.InstancedMesh;
  private boxes: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  private glows: THREE.InstancedMesh;
  private beams: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private c = new THREE.Color();
  private m = new THREE.Matrix4();

  // `height(x, y, bridge)`: of the ground, or of a bridge's deck where there is one.
  // `onRoad(x, y)`: whether the ground there is carriageway, to keep the poles off it.
  constructor(scene: THREE.Scene, area: string, time: () => number, height: (x: number, y: number, bridge: boolean) => number, onRoad: (x: number, y: number) => boolean = () => false) {
    this.time = time;
    this.onRoad = onRoad;
    this.height = height;
    const lit = (m: THREE.MeshLambertMaterial, key: string) => {
      m.onBeforeCompile = (sh) => lampLit(sh);
      m.customProgramCacheKey = () => key;
      return m;
    };
    // A pole, and on it a head with three lamps facing the traffic (+z before it's turned).
    const pole = new THREE.CylinderGeometry(0.06, 0.08, 3.1, 6).translate(0, 1.55, 0);
    // The head: a housing with a hood over it and a wider backplate behind, so the way it faces reads from above.
    const box = mergeGeometries([
      new THREE.BoxGeometry(0.36, 0.98, 0.26).translate(0, 2.55, 0.12),
      new THREE.BoxGeometry(0.62, 1.16, 0.05).translate(0, 2.55, -0.03),
      new THREE.BoxGeometry(0.3, 0.03, 0.42).translate(0, 3.06, 0.3),
      new THREE.BoxGeometry(0.3, 0.03, 0.34).translate(0, 2.87, 0.3),
      new THREE.BoxGeometry(0.3, 0.03, 0.34).translate(0, 2.55, 0.3),
      new THREE.BoxGeometry(0.3, 0.03, 0.34).translate(0, 2.25, 0.3),
    ])!;
    const lamp = new THREE.SphereGeometry(0.105, 10, 6).scale(1, 1, 0.8).translate(0, 0, 0.23);
    this.poles = new THREE.InstancedMesh(pole, lit(new THREE.MeshLambertMaterial({ color: '#3b3d3f' }), 'signal-pole'), MAX_HEADS);
    this.boxes = new THREE.InstancedMesh(box, lit(new THREE.MeshLambertMaterial({ color: '#23251f' }), 'signal-head'), MAX_HEADS);
    // The lit lamp's beam on the ground, a wedge widening towards the traffic it faces.
    const beam = new THREE.BufferGeometry();
    beam.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.3, -0.25, 0, 0.3, 0.25, 0, 0.3, -0.9, 0, 3, 0.9, 0, 3, -1.8, 0, 6.5, 1.8, 0, 6.5], 3));
    beam.setAttribute('color', new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1, .3, .3, .3, .3, .3, .3, 0, 0, 0, 0, 0, 0], 3));
    beam.setIndex([0, 3, 1, 1, 3, 4, 1, 4, 2, 3, 5, 4, 4, 5, 6]);
    this.beams = new THREE.InstancedMesh(beam, new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    }), MAX_HEADS);
    this.beams.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3);
    this.beams.renderOrder = 4;
    this.lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial(), MAX_HEADS * 3);
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3 * 3), 3);
    // The lit lamp's glow, flat and larger than life, so it shows from above; brighter at night.
    this.glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glowBy ? glowBy() : new THREE.ShaderMaterial({
      uniforms: { uOn: LAMP_ON },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vC;
        void main() { vUv = uv * 2. - 1.; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `
        uniform float uOn; varying vec2 vUv; varying vec3 vC;
        void main() {
          float d = length(vUv), f = smoothstep(1., 0., d);
          gl_FragColor = vec4(vC * (f * f * (.8 + uOn) + smoothstep(.3, .2, d) * .5), 1.);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }), MAX_HEADS);
    this.glows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3);
    this.glows.renderOrder = 5;
    for (const m of [this.poles, this.boxes, this.lamps, this.glows, this.beams]) {
      m.count = 0;
      m.frustumCulled = false;
    }
    scene.add(this.poles, this.boxes, this.lamps, this.glows, this.beams);

    void fetch(dataUrl(area, 'signals.json')).then((r) => (r.ok ? r.json() as Promise<SignalsJSON> : null)).then((data) => {
      if (!data) return;
      const junctions = data.junctions.map(([g0, g1, offset]) => ({ g0, g1, offset }));
      for (const [id, [stop, j, phase, px, py]] of Object.entries(data.edges)) this.byId.set(id, { stop, j: junctions[j], phase, ...(px !== undefined && py !== undefined ? { pole: [px, py] as [number, number] } : {}) });
    }).catch(() => {}).finally(() => {
      this.loaded = true;
      for (const edges of this.pending) this.add(edges);
      this.pending.length = 0;
    });
  }

  // Streets as their tiles load: a light at each one's stop line.
  add(edges: DriveEdge[]) {
    if (!this.loaded) { this.pending.push(edges); return; }
    for (const e of edges) {
      const sig = this.byId.get(e.id);
      if (!sig || e.tunnel || this.known.has(e)) continue;
      this.known.add(e);
      // At the kerb, right of the street's centre line.
      const line = new Polyline(offsetLine(e.pts, e.width / 2 + 0.6));
      const p = line.at(line.length - sig.stop);
      // On its surveyed pole where the map has one (pipeline/build_signals.py).
      if (sig.pole) { this.heads.push({ e, sig, x: sig.pole[0], y: sig.pole[1], ang: p.ang }); continue; }
      // Where the junction flares the carriageway is wider than the street: out to its kerb.
      const nx = Math.sin(p.ang), ny = -Math.cos(p.ang);
      let out = 0;
      if (!e.bridge) while (out < 12 && this.onRoad(p.x + nx * out, p.y + ny * out)) out += 0.5;
      if (out) out += 0.5;
      this.heads.push({ e, sig, x: p.x + nx * out, y: p.y + ny * out, ang: p.ang });
    }
    this.nearAt.x = Infinity;
  }

  // Streets that have left the graph (their tiles are far behind): their lights go too.
  forget(edges: DriveEdge[]) {
    let any = false;
    for (const e of edges) any = this.known.delete(e) || any;
    if (!any) return;
    this.heads = this.heads.filter((h) => this.known.has(h.e));
    this.nearAt.x = Infinity;
  }

  // How far ahead a car on `route` (its front `front` metres ahead of it, going at
  // `speed`) has to stop for a light, Infinity if it needn't; `waiting` whether a light
  // ahead is against it at all (it's queueing, not stuck). The reckless don't stop at amber.
  held = false;
  ahead(route: Route, front: number, speed: number, reckless = false) {
    const t = this.time();
    let d = 0, from = route.s, stop = Infinity;
    this.held = false;
    for (let i = 0; i < route.legs.length && d < LOOK; i++) {
      const leg = route.legs[i], e = leg.edge, sig = e && this.byId.get(e.id);
      if (sig) {
        const at = Math.min(Math.max(e.path.length - sig.stop, leg.s0), leg.s1);
        const gap = d + at - from - front;
        const show = at >= from ? light(sig, t) : GREEN;
        if (show !== GREEN && gap < LOOK) {
          this.held = true;
          // (Braking this hard to stop in time.)
          const brake = (speed * speed) / (2 * Math.max(gap, 0.1));
          if (gap > -0.5 && brake < (show === AMBER ? (reckless ? 1 : EASY) : HARD)) { stop = Math.max(0, gap); break; }
        }
      }
      d += leg.s1 - from;
      from = route.legs[i + 1]?.s0 ?? 0;
    }
    return stop;
  }

  // Whether a light against traffic stands within `d` metres ahead of a vehicle at (x, y)
  // heading `h` (only those gathered round the view).
  against(x: number, y: number, h: number, d: number) {
    const t = this.time(), fx = Math.cos(h), fy = Math.sin(h);
    return this.near.some((q) => {
      const dx = q.x - x, dy = q.y - y, ahead = dx * fx + dy * fy;
      return ahead > -2 && ahead < d && Math.abs(dx * fy - dy * fx) < 8 && Math.cos(q.ang - h) > 0.7 && light(q.sig, t) !== GREEN;
    });
  }

  private gather(x: number, y: number, r: number, now: number) {
    const a = this.nearAt;
    if (Math.hypot(x - a.x, y - a.y) < 25 && r + 25 <= a.r && r > a.asked * 0.6 && now - a.t < 3000) return;
    const R = r * 1.25 + 40;
    Object.assign(a, { x, y, r: R, asked: r, t: now });
    this.near = this.heads.filter((h) => Math.abs(h.x - x) < R && Math.abs(h.y - y) < R).slice(0, MAX_HEADS);
    const d = this.dummy;
    this.near.forEach((h, i) => {
      // Facing the traffic coming towards it.
      d.position.set(h.x, this.height(h.x, h.y, !!h.e.bridge), -h.y);
      d.rotation.set(0, Math.atan2(-Math.cos(h.ang), Math.sin(h.ang)), 0);
      d.updateMatrix();
      this.poles.setMatrixAt(i, d.matrix);
      this.boxes.setMatrixAt(i, d.matrix);
      d.position.y += 0.15;
      d.updateMatrix();
      this.beams.setMatrixAt(i, d.matrix);
      d.position.y -= 0.15;
      for (let k = 0; k < 3; k++) {
        d.position.y += k ? -0.3 : 2.85;
        d.updateMatrix();
        this.lamps.setMatrixAt(i * 3 + k, d.matrix);
      }
    });
    this.poles.count = this.boxes.count = this.beams.count = this.near.length;
    this.lamps.count = this.near.length * 3;
    for (const m of [this.poles, this.boxes, this.lamps, this.beams]) send(m.instanceMatrix, m.count);
  }

  // Once a frame: the lights round the view (x, y), within r.
  update(x: number, y: number, r: number, now: number) {
    this.gather(x, y, r, now);
    const t = this.time(), d = this.dummy, m = this.m;
    this.near.forEach((h, i) => {
      const show = light(h.sig, t);
      // Top to bottom: red, amber, green.
      const on = [show === RED || show === READY, show === AMBER || show === READY, show === GREEN];
      for (let k = 0; k < 3; k++) this.lamps.setColorAt(i * 3 + k, on[k] ? COLOURS[2 - k] : OFF[2 - k]);
      // The glow round the lowest lamp that's lit.
      const k = on[2] ? 2 : on[1] ? 1 : 0;
      this.lamps.getMatrixAt(i * 3 + k, m);
      d.position.setFromMatrixPosition(m);
      d.position.y += 0.2;
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(2.6);
      d.updateMatrix();
      d.scale.setScalar(1);
      this.glows.setMatrixAt(i, d.matrix);
      this.glows.setColorAt(i, this.c.copy(COLOURS[2 - k]));
      this.beams.setColorAt(i, this.c.copy(COLOURS[2 - k]).multiplyScalar(0.22 + 0.3 * LAMP_ON.value));
    });
    this.glows.count = this.beams.count = this.near.length;
    sendInstances(this.glows);
    if (this.beams.instanceColor) send(this.beams.instanceColor, this.beams.count);
    if (this.lamps.instanceColor) send(this.lamps.instanceColor, this.lamps.count);
  }
}
