import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LIFE_SIZE } from './figures.ts';
import { STREET_QUALITY } from './streetQuality.ts';
import { cutAway } from './shading.ts';
import { fireGear } from './responderGear.ts';
import type { Anim, Figures, UniformRole } from './figures.ts';
import { shape as umbrellaShape, material as umbrellaMaterial, colour as umbrellaColour, chance } from './umbrellas.ts';

// First person: the passers-by near you are life-size people from the Microsoft Rocketbox
// avatar library (MIT), walking, jogging, running and standing about with their own
// motion-captured clips (public/rocketbox/, built by assets/rocketbox/build.sh). From above
// they'd be a few pixels, so this is only for the street-level view; everyone further off
// stays the usual instanced figure. Special actions use the figure clips fitted to Bip01.
//
// Each frame the crowd offers its people as it draws them (LIFE_SIZE.claim in figures.ts);
// one near enough is taken and their instance drawn at zero size, and frame() then poses the
// avatars taken this frame and lets go of the rest.
//
// Standing, each takes turns with a few ways of waiting (shifting their weight, looking
// round, a text or a call on the phone). In the rain anyone with their umbrella up holds it
// in the left hand: standing, with Rocketbox's umbrella clip, walking, with that clip's
// left arm over the walk.

// Who appears, with which set of clips (women's or men's). The same list is in build.sh.
const AVATARS: [string, 'f' | 'm'][] = [
  ['female-adult-01', 'f'], ['female-adult-03', 'f'], ['female-adult-05', 'f'], ['female-adult-08', 'f'],
  ['female-adult-11', 'f'], ['female-adult-14', 'f'], ['business-female-02', 'f'],
  ['male-adult-01', 'm'], ['male-adult-04', 'm'], ['male-adult-07', 'm'], ['male-adult-10', 'm'],
  ['male-adult-13', 'm'], ['male-adult-17', 'm'], ['business-male-03', 'm'],
];
// Uniform variants keep each donor’s rig, head, mesh and normal maps.
const UNIFORM_AVATARS: Record<UniformRole, string[]> = {
  dustman: ['male-adult-10', 'male-adult-17'],
  police: ['male-adult-10', 'female-adult-05'],
  medic: ['male-adult-10', 'female-adult-05'],
  fire: ['male-adult-10', 'male-adult-17'],
};
const CLIPS = { walk: 'walk_neutral_01', jog: 'run_slow_01', run: 'run_neutral_01' };
type Move = keyof typeof CLIPS;
const GAITS: Move[] = ['walk', 'jog', 'run'];
// Ways of standing about, taken in turns; in those with "phone" they have one in hand.
const STANDING = {
  f: ['idle_neutral_01', 'idle_neutral_02', 'idle_neutral_09', 'idle_look_around_01', 'cell_phone_textmessage'],
  m: ['idle_neutral_01', 'idle_neutral_02', 'idle_neutral_09', 'idle_look_around_01', 'cell_phone_textmessage', 'cell_phone_talk_01'],
};
const UMBRELLA = { f: 'umbrella_idle_01', m: 'umbrella_idle_02' };
const LEFT_ARM = /^Bip01_L_(Clavicle|UpperArm|Forearm|Hand|Finger)/;
const OVER = 50; // how much more the umbrella arm counts than the walk's own
const REACH = 30; // metres: taken within this of the camera (less in a crowd, see frame())…
const SLACK = 6; // …and given back this much further off
const MOST = 24; // avatars at once
// Lower tiers keep the instanced people further away, including their animations.
// The player's own avatar always keeps its slot.
const TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); // their front is +z, the figures' +x

// The clips by name: the gaits, the ways of standing, 'umbrella' (standing with one) and
// 'arm' (just its left arm).
interface Kind { template: THREE.Object3D; clips: Record<string, THREE.AnimationClip>; stride: Record<Move, number>; standing: string[]; uniform?: THREE.MeshStandardMaterial; role?: UniformRole }
interface Person {
  kind: number;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  w: Record<string, number>; // how much of each clip shows
  want: Record<string, number>;
  t: Record<string, number>; // seconds into each clip that isn't a gait
  phase: number; // through a stride, 0 to 1
  rest: string; // the way they're standing about now
  umbrella: number; // the serial number of the umbrella they have up, or -1
  hand: THREE.Object3D; // the left, for the umbrella
  phone: THREE.Mesh; // in the right
  pos: THREE.Vector3;
  last: THREE.Vector3;
  turn: THREE.Quaternion;
  speed: number;
  seen: boolean;
  self: boolean;
  yieldSlot: boolean;
  nozzle?: THREE.Mesh;
}

export class LifeSize {
  group = new THREE.Group();
  enabled = true;
  private kinds: Kind[] = [];
  // An avatar keeps its catalogue identity as individual models finish loading.
  private baseKinds: (number | undefined)[] = [];
  private uniforms = new Map<string, number | null>();
  private uniformLoader?: KTX2Loader;
  private pendingUniforms = 0;
  private gear?: ReturnType<typeof fireGear>;
  private figureActions: Record<string, THREE.AnimationClip> = {};
  private state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private live = new Map<string, Person>();
  private spare: Person[][] = [];
  private ids = new WeakMap<Figures, number>();
  private on = false;
  private cam = new THREE.Vector3();
  private reach = REACH;
  private waitingCrew = 0;
  private reserved = 0;
  private offered: number[] = []; // how far off this frame's candidates were
  private renderer: unknown;
  private umbrellas = new THREE.InstancedMesh(gripped(umbrellaShape()), umbrellaMaterial(), MOST);

  constructor(scene: THREE.Scene, renderer: unknown) {
    this.renderer = renderer;
    this.group.name = 'rocketbox';
    scene.add(this.group);
    this.umbrellas.frustumCulled = false;
    this.umbrellas.count = 0;
    this.umbrellas.setColorAt(0, new THREE.Color());
    this.umbrellas.castShadow = true;
    this.group.add(this.umbrellas);
    LIFE_SIZE.claim = (fig, id, matrix, anim, umbrella) => this.claim(fig, id, matrix, anim, umbrella);
  }

  private async load() {
    this.state = 'loading';
    let ktx2: KTX2Loader | undefined;
    try {
      ktx2 = new KTX2Loader().setTranscoderPath('rocketbox/');
      ktx2.detectSupport(this.renderer as never);
      const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const [byName, figureActions] = await Promise.all(['clips', 'actions'].map(async (file) =>
        readClips(await (await fetch(`rocketbox/${file}.bin`)).arrayBuffer())));
      this.figureActions = figureActions;
      const loads = AVATARS.map(async ([name, sex], avatar) => {
        const g = await loader.loadAsync(`rocketbox/${name}.glb`);
        g.scene.traverse((o) => {
          if (!(o instanceof THREE.SkinnedMesh)) return;
          // (175 face shapes we never use: each would cost every vertex every frame.)
          o.geometry.morphAttributes = {};
          o.morphTargetInfluences = undefined;
          o.morphTargetDictionary = undefined;
          o.castShadow = o.receiveShadow = true;
          // (Lit by the street lamps at night, like the rest of the street.)
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) cutAway(m, 'rocketbox');
          o.frustumCulled = false; // (their bounds are of the bind pose)
        });
        const hips = g.scene.getObjectByName('Bip01')?.position.y ?? 0.9;
        const kind: Kind = { template: g.scene, clips: {}, stride: {} as Kind['stride'], standing: STANDING[sex] };
        for (const move of GAITS) [kind.clips[move], kind.stride[move]] = inPlace(byName[`${sex}_${CLIPS[move]}`], hips);
        for (const name of STANDING[sex]) kind.clips[name] = inPlace(byName[`${sex}_${name}`], hips)[0];
        const umbrella = (kind.clips.umbrella = inPlace(byName[`${sex}_${UMBRELLA[sex]}`], hips)[0]);
        kind.clips.arm = new THREE.AnimationClip('arm', umbrella.duration, umbrella.tracks.filter((t) => LEFT_ARM.test(t.name)));
        for (const [name, clip] of Object.entries(figureActions)) {
          // actions.mjs stores travel in units of the reference avatar's hip height.
          const position = clip.tracks[0].clone();
          for (let i = 0; i < position.values.length; i++) position.values[i] *= hips;
          kind.clips[name] = new THREE.AnimationClip(name, clip.duration, [position, ...clip.tracks.slice(1)]);
        }
        this.baseKinds[avatar] = this.kinds.push(kind) - 1;
        this.spare.push([]);
      });
      // Keep the shared decoder alive until the last request settles, even if
      // one model fails. Each ready character can already be drawn meanwhile.
      const results = await Promise.allSettled(loads);
      results.forEach((result, i) => {
        if (result.status === 'rejected') console.warn('Avatar could not load', AVATARS[i][0], result.reason);
      });
      this.state = this.kinds.length ? 'ready' : 'failed';
    } catch (e) {
      console.warn('Life-size people could not load', e);
      this.state = 'failed';
    } finally {
      ktx2?.dispose(); // (its decoding workers: everything's decoded by now)
    }
  }

  // The person can keep their instanced outfit while this particular texture
  // loads. The first crew to appear shares one decoder across concurrent loads.
  private uniformKind(role: UniformRole, id: number) {
    const donors = UNIFORM_AVATARS[role], name = donors[id % donors.length], key = role + '-' + name;
    if (!this.uniforms.has(key)) {
      const base = this.baseKinds[AVATARS.findIndex(([avatar]) => avatar === name)];
      if (base === undefined) return null;
      this.uniforms.set(key, null);
      void this.loadUniform(key, this.kinds[base], role);
    }
    return this.uniforms.get(key);
  }

  private async loadUniform(key: string, base: Kind, role: UniformRole) {
    let body: THREE.MeshStandardMaterial | undefined;
    base.template.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh && o.material instanceof THREE.MeshStandardMaterial && o.material.name.endsWith('_body')) body = o.material;
    });
    if (!body) return;
    this.pendingUniforms++;
    try {
      this.uniformLoader ??= new KTX2Loader().setTranscoderPath('rocketbox/').detectSupport(this.renderer as never);
      const map = await this.uniformLoader.loadAsync(`rocketbox/${key}.ktx2`);
      map.colorSpace = THREE.SRGBColorSpace;
      const uniform = body.clone();
      uniform.map = map;
      cutAway(uniform, 'rocketbox');
      const index = this.kinds.push({ ...base, role, uniform, standing: ['idle_neutral_01', 'idle_neutral_02'] }) - 1;
      this.spare[index] = [];
      this.uniforms.set(key, index);
    } catch (e) { console.warn('Crew uniform could not load', key, e); }
    finally {
      if (--this.pendingUniforms === 0) {
        this.uniformLoader?.dispose();
        this.uniformLoader = undefined;
      }
    }
  }

  // Not in the middle of loading (so dispose() leaves nothing behind).
  get idle() { return this.state !== 'loading' && this.pendingUniforms === 0; }

  // Lets go of the avatars, their clips and textures, and stops offering to draw anyone.
  dispose() {
    if (LIFE_SIZE.claim) LIFE_SIZE.claim = null;
    this.group.removeFromParent();
    const textures = new Set<THREE.Texture>();
    const seen = new Set<object>();
    const free = (o: THREE.Object3D) => o.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      if (m.geometry !== PHONE && !seen.has(m.geometry)) { seen.add(m.geometry); m.geometry.dispose(); }
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        if (mat === PHONE_LOOK || seen.has(mat)) continue;
        seen.add(mat);
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture) textures.add(v);
        mat.dispose();
      }
    });
    for (const k of this.kinds) {
      if (!k.uniform) { free(k.template); continue; }
      if (k.uniform.map) textures.add(k.uniform.map);
      k.uniform.dispose();
    }
    if (this.gear) { free(this.gear.helmet); free(this.gear.nozzle); }
    for (const t of textures) t.dispose();
    for (const p of [...this.live.values(), ...this.spare.flat()]) {
      p.mixer.uncacheRoot(p.root);
      p.root.traverse((m) => { if (m instanceof THREE.SkinnedMesh) m.skeleton.dispose(); });
    }
    this.umbrellas.dispose();
    this.umbrellas.geometry.dispose();
    (this.umbrellas.material as THREE.Material).dispose();
    this.kinds = [];
    this.baseKinds = [];
    this.live.clear();
    this.spare = [];
  }

  // A person in the crowd, as they're drawn: true if they're shown life size instead.
  private claim(fig: Figures, id: number, matrix: THREE.Matrix4, anim: Anim, umbrella: number) {
    if (!this.on) return false;
    if (anim.name !== 'idle' && !GAITS.includes(anim.name as Move) && !this.figureActions[anim.name]) return false;
    const pos = _p.setFromMatrixPosition(matrix);
    const d = Math.hypot(pos.x - this.cam.x, pos.z - this.cam.z);
    if (d < STREET_QUALITY.avatarReach + SLACK && !fig.self) this.offered.push(d);
    let gid = this.ids.get(fig);
    if (gid === undefined) this.ids.set(fig, (gid = this.ids_++));
    const key = `${gid}:${id}`;
    let p = this.live.get(key);
    if (p?.yieldSlot) return false;
    if (!p) {
      // (Not someone the camera is inside; you, though, always: see Figures.self.)
      if (!fig.self && (d > this.reach || d < 1)) return false;
      const role = typeof fig.lifeSize === 'string' ? fig.lifeSize : undefined;
      const kind = role ? this.uniformKind(role, id) : this.baseKinds[(fig.avatarSeed ?? (gid * 7919 + id * 104729)) % AVATARS.length];
      if (kind == null) return false;
      if (!fig.self && this.live.size >= STREET_QUALITY.avatars - (role ? 0 : this.reserved)) {
        if (role) this.waitingCrew++;
        return false;
      }
      p = this.take(kind);
      p.self = fig.self;
      p.yieldSlot = false;
      p.pos.copy(pos);
      p.last.copy(pos);
      p.speed = 0;
      p.phase = anim.phase;
      const k = this.kinds[p.kind];
      p.rest = k.standing[(gid * 31 + id * 17) % k.standing.length];
      for (const c in p.t) p.t[c] = 0;
      p.t[p.rest] = chance(id, 9) * k.clips[p.rest].duration;
      p.t.umbrella = p.t.arm = chance(id, 10) * k.clips.umbrella.duration;
      p.umbrella = umbrella;
      this.live.set(key, p);
      this.pose(p, anim);
      for (const c in p.w) p.w[c] = p.want[c] ?? 0;
    } else if (!fig.self && (d > this.reach + SLACK || (this.live.size > STREET_QUALITY.avatars && !this.kinds[p.kind].role))) return false;
    p.pos.copy(pos);
    matrix.decompose(_v, p.turn, _s);
    p.umbrella = umbrella;
    this.pose(p, anim);
    p.seen = true;
    return true;
  }
  private ids_ = 0;

  // Gameplay can hold, restart or scrub an action, including the jump apex.
  private setActionTime(p: Person, anim: Anim, name: string, time: number) {
    const clip = this.kinds[p.kind].clips[name];
    if (!p.actions[name]) {
      p.actions[name] = p.mixer.clipAction(clip).play();
      p.w[name] = p.want[name] = 0;
    }
    const len = clip.duration;
    p.t[name] = anim.clips[name].loop ? ((time % len) + len) % len : Math.max(0, Math.min(time, len));
  }

  // Which clips should show, from the figure's own animation.
  private pose(p: Person, anim: Anim) {
    for (const c in p.want) p.want[c] = 0;
    const up = p.umbrella >= 0;
    if (anim.from && anim.w > 0 && this.figureActions[anim.from] && anim.from !== anim.name) {
      this.setActionTime(p, anim, anim.from, anim.ft);
    }
    if (this.figureActions[anim.name]) {
      this.setActionTime(p, anim, anim.name, anim.t);
      p.want[anim.name] = 1;
      return;
    }
    if (anim.name === 'idle') { p.want[up ? 'umbrella' : p.rest] = 1; return; }
    const g = anim.blend ? anim.gait : GAITS.indexOf(anim.name as Move);
    const lo = Math.min(Math.floor(g), GAITS.length - 2), mix = Math.min(1, Math.max(0, g - lo));
    p.want[GAITS[lo]] = 1 - mix;
    p.want[GAITS[lo + 1]] = mix;
    if (up) p.want.arm = 1;
  }

  private take(kind: number): Person {
    const reuse = this.spare[kind].pop();
    if (reuse) { reuse.root.visible = true; return reuse; }
    const k = this.kinds[kind], root = SkeletonUtils.clone(k.template);
    const uniform = k.uniform;
    if (uniform) root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh && o.material.name === uniform.name) o.material = uniform;
    });
    let nozzle: THREE.Mesh | undefined;
    if (k.role === 'fire') {
      this.gear ??= fireGear();
      const head = root.getObjectByName('Bip01_Head')!, helmet = this.gear.helmet.clone();
      head.getWorldPosition(helmet.position);
      // attach preserves the upright orientation and metre scale on the cm rig.
      head.attach(helmet);
      nozzle = this.gear.nozzle.clone();
      nozzle.visible = false;
      root.add(nozzle);
    }
    const mixer = new THREE.AnimationMixer(root);
    const actions: Person['actions'] = {}, w: Person['w'] = {}, want: Person['want'] = {}, t: Person['t'] = {};
    for (const c in k.clips) {
      if (this.figureActions[c]) continue; // bound on the first use of this action
      actions[c] = mixer.clipAction(k.clips[c]);
      actions[c].play();
      w[c] = want[c] = t[c] = 0;
    }
    const phone = new THREE.Mesh(PHONE, PHONE_LOOK);
    phone.visible = false;
    const right = root.getObjectByName('Bip01_R_Hand');
    if (right) {
      // (The skeleton is in centimetres under Bip01: the phone is sized back up to metres.)
      root.updateMatrixWorld(true);
      const cm = 1 / right.getWorldScale(_s).x;
      phone.scale.setScalar(cm);
      phone.position.set(0.06, 0.022, 0.012).multiplyScalar(cm);
      right.add(phone);
    }
    this.group.add(root);
    return {
      kind, root, mixer, actions, w, want, t, nozzle, phase: 0, rest: k.standing[0], umbrella: -1,
      hand: root.getObjectByName('Bip01_L_Hand') ?? root, phone,
      pos: new THREE.Vector3(), last: new THREE.Vector3(), turn: new THREE.Quaternion(), speed: 0, seen: false, self: false, yieldSlot: false,
    };
  }

  // Once a frame, after the crowd is drawn and before the picture: `eyes` is whether the
  // view is first person.
  frame(dt: number, eyes: boolean, camera: THREE.Camera) {
    eyes &&= this.enabled;
    if (eyes && this.state === 'idle') void this.load();
    this.on = eyes && this.kinds.length > 0;
    this.cam.copy(camera.position);
    // In a crowd there are more people near than avatars: the reach draws in to the
    // nearest tier budget of them (those beyond it are let go), widening as the crowd thins.
    const o = this.offered.sort((a, b) => a - b);
    const limit = STREET_QUALITY.avatars;
    this.reach = o.length > limit ? Math.min(STREET_QUALITY.avatarReach, o[limit - 1]) : STREET_QUALITY.avatarReach;
    o.length = 0;
    // A nearby responder can arrive after all slots are held by civilians.
    // Give the farthest civilians back to their instanced figures on the next
    // claim, reserving the released slots until the waiting crew can take them.
    this.reserved = this.waitingCrew;
    if (this.waitingCrew) {
      const present = [...this.live.values()].filter(p => p.seen);
      const need = Math.max(0, present.length + this.waitingCrew - limit);
      const civilians = present.filter(p => !p.self && !this.kinds[p.kind].role)
        .sort((a, b) => b.pos.distanceToSquared(this.cam) - a.pos.distanceToSquared(this.cam));
      for (let i = 0; i < Math.min(need, civilians.length); i++) civilians[i].yieldSlot = true;
      this.waitingCrew = 0;
    }
    let held = 0;
    for (const [key, p] of this.live) {
      if (!p.seen || !this.on) {
        p.root.visible = false;
        this.live.delete(key);
        this.spare[p.kind].push(p);
        continue;
      }
      p.seen = false;
      const k = this.kinds[p.kind];
      // How fast they're going, from how far they moved: the feet keep pace with the ground.
      if (dt > 0) {
        const v = Math.hypot(p.pos.x - p.last.x, p.pos.z - p.last.z) / dt;
        p.speed += (Math.min(v, 12) - p.speed) * Math.min(1, dt * 8);
      }
      p.last.copy(p.pos);
      // Done with one way of standing, they go on to another (the last fades out as it ends).
      if (p.want[p.rest] > 0 && p.t[p.rest] >= k.clips[p.rest].duration - 0.3) {
        const others = k.standing.filter((c) => c !== p.rest && p.w[c] === 0);
        if (others.length) {
          p.rest = others[Math.floor(Math.random() * others.length)];
          p.t[p.rest] = 0;
          p.want[p.rest] = 1;
        }
      }
      let stride = 0, sum = 0;
      for (const c in p.w) {
        p.w[c] += (p.want[c] - p.w[c]) * Math.min(1, dt * 8);
        if (p.w[c] < 0.01 && p.want[c] === 0) p.w[c] = 0; // (a clip at no weight isn't worked out at all)
        if (c in k.stride) { stride += k.stride[c as Move] * p.w[c]; sum += p.w[c]; }
      }
      if (sum > 0.01) p.phase = (p.phase + (p.speed * dt) / (stride / sum)) % 1;
      let phone = 0;
      for (const c in p.w) {
        const a = p.actions[c], len = a.getClip().duration;
        a.setEffectiveWeight(c === 'arm' ? p.w[c] * OVER : p.w[c]);
        if (p.w[c] === 0) continue;
        if (c in k.stride) { a.time = p.phase * len; continue; }
        if (this.figureActions[c]) { a.time = p.t[c]; continue; }
        p.t[c] += dt;
        // (The umbrella's clips go round; a way of standing is held at its end as it fades.)
        a.time = c === 'umbrella' || c === 'arm' ? p.t[c] % len : Math.min(p.t[c], len);
        if (c.includes('phone')) phone += p.w[c];
      }
      p.phone.visible = phone > 0.5;
      if (p.nozzle) p.nozzle.visible = (p.w.hose ?? 0) + (p.w.hosewalk ?? 0) > 0.5;
      p.mixer.update(0);
      p.root.position.copy(p.pos);
      p.root.quaternion.copy(p.turn).multiply(TURN);
      if (p.umbrella >= 0 && held < MOST) {
        // In the left hand, leant in over the head, each a little their own way.
        p.root.updateMatrixWorld(true);
        p.hand.getWorldPosition(_v);
        _q.copy(p.turn).multiply(_tilt.setFromAxisAngle(AHEAD, 0.16 + 0.12 * chance(p.umbrella, 5)));
        this.umbrellas.setMatrixAt(held, _m.compose(_v, _q, _s.setScalar(0.96 + 0.1 * chance(p.umbrella, 3))));
        this.umbrellas.setColorAt(held, umbrellaColour(p.umbrella));
        held++;
      }
    }
    this.umbrellas.count = held;
    this.umbrellas.visible = held > 0;
    this.umbrellas.instanceMatrix.needsUpdate = true;
    if (this.umbrellas.instanceColor) this.umbrellas.instanceColor.needsUpdate = true;
  }
}

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _q = new THREE.Quaternion(), _tilt = new THREE.Quaternion(), _m = new THREE.Matrix4();
const AHEAD = new THREE.Vector3(1, 0, 0);
// A phone: 7 by 14.5 cm, dark glass. In the hand's own axes the fingers point along +x and
// the palm faces +y.
const PHONE = new THREE.BoxGeometry(0.145, 0.008, 0.07);
const PHONE_LOOK = new THREE.MeshLambertMaterial({ color: '#15161a' });

// The crowd's umbrella moved so that the hand holds it 7 cm up the stick.
function gripped(g: THREE.BufferGeometry) {
  return g.translate(-0.1, -1.22, 0);
}

// The clips as assets/rocketbox/clips.mjs writes them: a header (JSON) with each clip's
// name, frames, fps, moving and still joints, then int16s: Bip01's positions (millimetres)
// and each joint's turns (in 32767ths), frame by frame, then the still joints' once.
function readClips(buffer: ArrayBuffer) {
  const length = new DataView(buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as { clips: { name: string; frames: number; fps: number; joints: string[]; still: string[] }[] };
  const data = new Int16Array(buffer, 4 + length);
  const clips: Record<string, THREE.AnimationClip> = {};
  let at = 0;
  const take = (n: number, unit: number) => Float32Array.from(data.subarray(at, (at += n)), (v) => v / unit);
  for (const c of head.clips) {
    const times = Float32Array.from({ length: c.frames }, (_, i) => i / c.fps);
    const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack('Bip01.position', times, take(c.frames * 3, 1000))];
    for (const joint of c.joints) tracks.push(new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, times, take(c.frames * 4, 32767)));
    for (const joint of c.still) tracks.push(new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, [0], take(4, 32767)));
    clips[c.name] = new THREE.AnimationClip(c.name, (c.frames - 1) / c.fps, tracks);
  }
  return clips;
}

// A clip that walks off along +z, made to walk on the spot: only the joints' turns and the
// hips' height (scaled to these hips) are kept. Returns it with the distance one cycle covers.
function inPlace(source: THREE.AnimationClip, hips: number): [THREE.AnimationClip, number] {
  const clip = source.clone();
  clip.tracks = clip.tracks.filter((t) => t.name.endsWith('.quaternion') || t.name === 'Bip01.position');
  const root = clip.tracks.find((t) => t.name === 'Bip01.position');
  if (!root) return [clip, 0];
  const t = root.times, v = root.values, n = t.length, t0 = t[0], T = t[n - 1] - t0;
  const x0 = v[0], y0 = v[1], z0 = v[2], dx = v[(n - 1) * 3] - x0, dz = v[(n - 1) * 3 + 2] - z0;
  for (let i = 0; i < n; i++) {
    const f = T > 0 ? (t[i] - t0) / T : 0;
    v[i * 3] -= x0 + dx * f;
    v[i * 3 + 1] *= hips / y0;
    v[i * 3 + 2] -= z0 + dz * f;
  }
  for (const tr of clip.tracks) for (let i = 0; i < tr.times.length; i++) tr.times[i] -= t0;
  clip.duration = T;
  return [clip, Math.hypot(dx, dz)];
}
