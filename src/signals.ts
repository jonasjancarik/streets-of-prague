import { dataUrl } from './data.ts';
import * as THREE from 'three';
import { mirrored, mirroredGlow } from './mirror.ts';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lampLit, LAMP_ON } from './lamps.ts';
import { Polyline, offsetLine } from './network.ts';
import type { DriveEdge, Route } from './network.ts';
import { send } from './gpu.ts';

// Traffic lights at junctions (pipeline/build_signals.py, data/<area>_now/signals.json).
// Each junction runs a cycle of two phases, the streets along its main street and
// those across it: green, amber, all red, then the other phase, with red and amber
// together just before a green, as in Czech lights. The traffic stops at red and at
// amber when it still can; each light stands on a pole at the kerb by the stop line.
// The crossings at a junction have the pedestrians' lights, red and green only, at
// their ends facing across: green while the street they cross has red.

// The WebGPU trial's own versions of the glow and the flare (webgpu/glows.ts), set before the signals are made.
let glowBy: (() => THREE.Material) | null = null;
export const setSignalGlow = (f: typeof glowBy) => { glowBy = f; };
let flareBy: (() => THREE.Material) | null = null;
export const setSignalFlare = (f: typeof flareBy) => { flareBy = f; };
// A car light's flare: the light leaving the head under its hoods, from their front edge
// (HOOD m ahead of the pole) down to the road FLARE[1] m further on, FLARE[0] m wide there.
const HOOD = 0.5, FLARE = [1.2, 2.2];
const NONE = new THREE.Matrix4().makeScale(0, 0, 0);

export const GREEN = 0, AMBER = 1, RED = 2, READY = 3; // READY: red and amber together
const AMBER_T = 3, CLEAR = 2, READY_T = 1.5;
// How far ahead cars look for a light (m), and the hardest they brake for one (m/s²):
// at amber they only stop if it's easy, at red unless it's too late.
const LOOK = 70, EASY = 3.5, HARD = 7;
const MAX_HEADS = 800;
const COLOURS = [new THREE.Color('#22ff88'), new THREE.Color('#ffae00'), new THREE.Color('#ff2414')];
const OFF = [new THREE.Color('#0c1a12'), new THREE.Color('#1c150a'), new THREE.Color('#1e0c0a')];
const WALK = 4, STOP = 5; // a crossing's light, as kept in Signals.shown

// Mark items [from, to) of `attr` to be sent, in one span with any range still waiting
// for the renderer (it clears them once sent), so that no write is lost when two
// updates come before a render.
function mark(attr: THREE.BufferAttribute, from: number, to: number) {
  if (to <= from) return;
  let start = from * attr.itemSize, end = to * attr.itemSize;
  for (const u of attr.updateRanges) { start = Math.min(start, u.start); end = Math.max(end, u.start + u.count); }
  attr.clearUpdateRanges();
  attr.addUpdateRange(start, end - start);
  attr.needsUpdate = true;
}

interface Junction { g0: number; g1: number; offset: number }
const GAP_M = 4; // the widest gap in the carriageway (tram tracks) a light is carried across to the kerb
export interface Signal { stop: number; j: Junction; phase: number; poles: [number, number][] } // poles: where its lights stand, surveyed
interface Head { e: DriveEdge; sig: Signal; x: number; y: number; ang: number; walk?: boolean } // walk: a crossing's
interface SignalsJSON { junctions: [number, number, number][]; edges: Record<string, number[]>; walk?: Record<string, number[]> }

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
  private walkById = new Map<string, { sig: Signal; x: number; y: number; ang: number }[]>(); // the crossings' lights by the street they cross
  private heads: Head[] = [];
  private known = new Set<DriveEdge>();
  private pending: DriveEdge[][] = [];
  private loaded = false;
  private time: () => number;
  private onRoad: (x: number, y: number) => boolean;
  private height: (x: number, y: number, bridge: boolean) => number;
  private near: Head[] = []; // the cars' lights, then the crossings'
  private cars = 0; // how many of near are the cars' lights
  private nearAt = { x: Infinity, y: Infinity, r: 0, asked: 0, t: 0 }; // r: the radius gathered, asked: the one asked for
  // What each slot of near shows as drawn (a phase, WALK or STOP), -1 to draw it afresh.
  private shown = new Int8Array(MAX_HEADS).fill(-1);
  private poles: THREE.InstancedMesh;
  private boxes: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  // (Both read by the streaks, streaks.ts.)
  glows: THREE.InstancedMesh;
  flares: THREE.InstancedMesh;
  private walkBoxes: THREE.InstancedMesh;
  private walkLamps: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private c = new THREE.Color();
  private m = new THREE.Matrix4();
  private local = new THREE.Matrix4();

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
    this.lamps = new THREE.InstancedMesh(lamp, new THREE.MeshBasicMaterial(), MAX_HEADS * 3);
    this.lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3 * 3), 3);
    // A crossing's light: a smaller head lower down, two square lamps (the red man over the
    // green), no hoods and no flare.
    const walkBox = mergeGeometries([
      new THREE.BoxGeometry(0.3, 0.62, 0.2).translate(0, 2.3, 0.1),
      new THREE.BoxGeometry(0.4, 0.74, 0.04).translate(0, 2.3, -0.02),
    ])!;
    this.walkBoxes = new THREE.InstancedMesh(walkBox, this.boxes.material, MAX_HEADS);
    this.walkLamps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.22, 0.03).translate(0, 0, 0.21), new THREE.MeshBasicMaterial(), MAX_HEADS * 2);
    this.walkLamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 2 * 3), 3);
    // A crossing's lit lamp's glow, flat, so the colour reads from above; brighter at night.
    this.glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), glowBy ? glowBy() : new THREE.ShaderMaterial({
      uniforms: { uOn: LAMP_ON },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vC;
        void main() { vUv = uv * 2. - 1.; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `
        uniform float uOn; varying vec2 vUv; varying vec3 vC;
        void main() {
          float d = length(vUv), f = smoothstep(1., 0., d);
          gl_FragColor = vec4(vC * (f * f * (.9 + .5 * uOn) + smoothstep(.3, .2, d) * .9), 1.);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }), MAX_HEADS);
    this.glows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3);
    this.glows.renderOrder = 5;
    // A car light's: the light seen leaving the front of the head (a lamp's own light can't
    // come through the top of the head), brightest just out from under the hoods and
    // widening and fading as it slopes down to the road, so that from above or aside it's
    // one cone from the head to the ground, and shows which way the light faces. It's
    // drawn from the lamp's height (1, scaled to it) down to the ground (0); uv.y is 1 at the head.
    const cone = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    const at = cone.attributes.position;
    for (let v = 0; v < at.count; v++) at.setY(v, -at.getZ(v));
    this.flares = new THREE.InstancedMesh(cone, flareBy ? flareBy() : new THREE.ShaderMaterial({
      uniforms: { uOn: LAMP_ON },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vC;
        void main() { vUv = uv; vC = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `
        uniform float uOn; varying vec2 vUv; varying vec3 vC;
        void main() {
          float along = 1. - vUv.y, x = (vUv.x - .5) * 2.;
          float fan = pow(1. - along, 1.5) * smoothstep(1., .55, abs(x) / (.3 + .7 * along));
          float core = smoothstep(1., .3, length(vec2(x / .4, (along - .06) / .13)));
          gl_FragColor = vec4(vC * (fan * (.9 + .4 * uOn) + core), 1.);
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
    }), MAX_HEADS);
    this.flares.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3);
    this.flares.renderOrder = 5;
    for (const m of [this.poles, this.boxes, this.lamps, this.glows, this.flares, this.walkBoxes, this.walkLamps]) {
      m.count = 0;
      m.frustumCulled = false;
    }
    // Puddles mirror the lights and their flares.
    for (const m of [this.poles, this.boxes, this.lamps, this.walkBoxes, this.walkLamps]) mirrored(m);
    mirroredGlow(this.glows);
    mirroredGlow(this.flares);
    scene.add(this.poles, this.boxes, this.lamps, this.glows, this.flares, this.walkBoxes, this.walkLamps);

    void fetch(dataUrl(area, 'signals.json')).then((r) => (r.ok ? r.json() as Promise<SignalsJSON> : null)).then((data) => {
      if (!data) return;
      const junctions = data.junctions.map(([g0, g1, offset]) => ({ g0, g1, offset }));
      for (const [id, [stop, j, phase, ...xy]] of Object.entries(data.edges)) {
        const poles: [number, number][] = [];
        for (let i = 0; i + 1 < xy.length; i += 2) poles.push([xy[i], xy[i + 1]]);
        this.byId.set(id, { stop, j: junctions[j], phase, poles });
      }
      // [junction, phase, x, y, the way it faces (degrees anticlockwise from east)] each.
      for (const [id, v] of Object.entries(data.walk ?? {})) {
        const list = [];
        for (let i = 0; i + 4 < v.length; i += 5) {
          list.push({ sig: { stop: 0, j: junctions[v[i]], phase: v[i + 1], poles: [] }, x: v[i + 2], y: v[i + 3], ang: (v[i + 4] * Math.PI) / 180 + Math.PI });
        }
        this.walkById.set(id, list);
      }
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
      const sig = this.byId.get(e.id), walk = this.walkById.get(e.id);
      if ((!sig && !walk) || e.tunnel || this.known.has(e)) continue;
      this.known.add(e);
      // (ang: the way the traffic it faces goes, as for the cars' lights.)
      for (const w of walk ?? []) this.heads.push({ e, sig: w.sig, x: w.x, y: w.y, ang: w.ang, walk: true });
      if (!sig) continue;
      // At the kerb, right of the street's centre line.
      const line = new Polyline(offsetLine(e.pts, e.width / 2 + 0.6));
      const p = line.at(line.length - sig.stop);
      // On its surveyed pole where the map has one (pipeline/build_signals.py).
      if (sig.poles.length) { for (const [x, y] of sig.poles) this.heads.push({ e, sig, x, y, ang: p.ang }); continue; }
      // Where the junction flares the carriageway is wider than the street: out to its kerb.
      const nx = Math.sin(p.ang), ny = -Math.cos(p.ang);
      // (The tram tracks beside it aren't carriageway: gaps up to GAP_M are crossed.)
      let out = 0;
      if (!e.bridge) {
        let last = -1;
        for (let s = 0; s < 16 && s - last <= GAP_M; s += 0.5) if (this.onRoad(p.x + nx * s, p.y + ny * s)) last = s;
        if (last >= 0) out = last + 1;
      }
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
    return this.near.some((q, i) => {
      if (i >= this.cars) return false;
      const dx = q.x - x, dy = q.y - y, ahead = dx * fx + dy * fy;
      return ahead > -2 && ahead < d && Math.abs(dx * fy - dy * fx) < 8 && Math.cos(q.ang - h) > 0.7 && light(q.sig, t) !== GREEN;
    });
  }

  private gather(x: number, y: number, r: number, now: number) {
    const a = this.nearAt;
    if (Math.hypot(x - a.x, y - a.y) < 25 && r + 25 <= a.r && r > a.asked * 0.6 && now - a.t < 3000) return;
    const R = r * 1.25 + 40;
    Object.assign(a, { x, y, r: R, asked: r, t: now });
    const round = this.heads.filter((h) => Math.abs(h.x - x) < R && Math.abs(h.y - y) < R);
    const cars = round.filter((h) => !h.walk), walks = round.filter((h) => h.walk);
    this.near = [...cars, ...walks].slice(0, MAX_HEADS);
    this.cars = Math.min(cars.length, MAX_HEADS);
    this.shown.fill(-1);
    const d = this.dummy;
    this.near.forEach((h, i) => {
      // Facing the traffic coming towards it (or the people across the crossing).
      d.position.set(h.x, this.height(h.x, h.y, !!h.e.bridge), -h.y);
      d.rotation.set(0, Math.atan2(-Math.cos(h.ang), Math.sin(h.ang)), 0);
      d.updateMatrix();
      this.poles.setMatrixAt(i, d.matrix);
      if (h.walk) {
        const w = i - this.cars;
        this.walkBoxes.setMatrixAt(w, d.matrix);
        for (let k = 0; k < 2; k++) {
          d.position.y += k ? -0.28 : 2.44;
          d.updateMatrix();
          this.walkLamps.setMatrixAt(w * 2 + k, d.matrix);
        }
        return;
      }
      this.boxes.setMatrixAt(i, d.matrix);
      for (let k = 0; k < 3; k++) {
        d.position.y += k ? -0.3 : 2.85;
        d.updateMatrix();
        this.lamps.setMatrixAt(i * 3 + k, d.matrix);
      }
    });
    this.poles.count = this.near.length;
    this.boxes.count = this.cars;
    this.lamps.count = this.cars * 3;
    this.walkBoxes.count = this.near.length - this.cars;
    this.walkLamps.count = this.walkBoxes.count * 2;
    for (const m of [this.poles, this.boxes, this.lamps, this.walkBoxes, this.walkLamps]) send(m.instanceMatrix, m.count);
  }

  // Once a frame: the lights round the view (x, y), within r. Only the lights whose
  // phase has changed are drawn again.
  update(x: number, y: number, r: number, now: number) {
    this.gather(x, y, r, now);
    const t = this.time(), d = this.dummy, m = this.m, shown = this.shown;
    // The slots drawn again: from lo to hi, the cars' lights' up to carsTo, the crossings' (counted among them) walks to walksTo.
    let lo = MAX_HEADS, hi = 0, carsTo = 0, walks = MAX_HEADS, walksTo = 0;
    this.near.forEach((h, i) => {
      if (h.walk) {
        // Green while the street has its red, the red man otherwise (no amber).
        const w = i - this.cars, go = light(h.sig, t) === GREEN;
        if (shown[i] === (go ? WALK : STOP)) return;
        shown[i] = go ? WALK : STOP;
        lo = Math.min(lo, i); hi = i + 1; walks = Math.min(walks, w); walksTo = w + 1;
        this.walkLamps.setColorAt(w * 2, go ? OFF[2] : COLOURS[2]);
        this.walkLamps.setColorAt(w * 2 + 1, go ? COLOURS[0] : OFF[0]);
        this.walkLamps.getMatrixAt(w * 2 + (go ? 1 : 0), m);
        d.position.setFromMatrixPosition(m);
        d.position.y += 0.2;
        d.rotation.set(0, 0, 0);
        d.scale.setScalar(0.8);
        d.updateMatrix();
        d.scale.setScalar(1);
        this.glows.setMatrixAt(i, d.matrix);
        this.glows.setColorAt(i, this.c.copy(COLOURS[go ? 0 : 2]));
        return;
      }
      const show = light(h.sig, t);
      if (shown[i] === show) return;
      shown[i] = show;
      lo = Math.min(lo, i); hi = carsTo = i + 1;
      // Top to bottom: red, amber, green.
      const on = [show === RED || show === READY, show === AMBER || show === READY, show === GREEN];
      for (let k = 0; k < 3; k++) this.lamps.setColorAt(i * 3 + k, on[k] ? COLOURS[2 - k] : OFF[2 - k]);
      // The flare of the lowest lamp that's lit, out from the head as it's turned; no round glow.
      const k = on[2] ? 2 : on[1] ? 1 : 0;
      this.boxes.getMatrixAt(i, m);
      const up = 2.85 - 0.3 * k;
      this.local.makeScale(FLARE[0], up - 0.05, FLARE[1]).setPosition(0, up, HOOD);
      this.flares.setMatrixAt(i, m.multiply(this.local));
      this.flares.setColorAt(i, this.c.copy(COLOURS[2 - k]));
      this.glows.setMatrixAt(i, NONE);
    });
    this.glows.count = this.near.length;
    this.flares.count = this.cars;
    mark(this.glows.instanceMatrix, lo, hi);
    if (this.glows.instanceColor) mark(this.glows.instanceColor, lo, hi);
    mark(this.flares.instanceMatrix, lo, carsTo);
    if (this.flares.instanceColor) mark(this.flares.instanceColor, lo, carsTo);
    if (this.lamps.instanceColor) mark(this.lamps.instanceColor, lo * 3, carsTo * 3);
    if (this.walkLamps.instanceColor) mark(this.walkLamps.instanceColor, walks * 2, walksTo * 2);
  }
}
