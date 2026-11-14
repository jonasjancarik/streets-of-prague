import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { LIFE_SIZE } from './figures.ts';
import { cutAway } from './shading.ts';
import type { Anim, Figures } from './figures.ts';

// First person: the passers-by near you are life-size people from the Microsoft Rocketbox
// avatar library (MIT), walking, jogging, running and standing with their own
// motion-captured clips (public/rocketbox/, built by assets/rocketbox/build.sh). From above
// they'd be a few pixels, so this is only for the street-level view; everyone further off,
// and anyone doing something the clips don't cover (falling, fleeing a car, getting up), stays
// the usual instanced figure.
//
// Each frame the crowd offers its people as it draws them (LIFE_SIZE.claim in figures.ts);
// one near enough is taken and their instance drawn at zero size, and frame() then poses the
// avatars taken this frame and lets go of the rest.

// Who appears, with which set of clips (women's or men's). The same list is in build.sh.
const AVATARS: [string, 'f' | 'm'][] = [
  ['female-adult-01', 'f'], ['female-adult-03', 'f'], ['female-adult-05', 'f'], ['female-adult-08', 'f'],
  ['female-adult-11', 'f'], ['female-adult-14', 'f'], ['business-female-02', 'f'],
  ['male-adult-01', 'm'], ['male-adult-04', 'm'], ['male-adult-07', 'm'], ['male-adult-10', 'm'],
  ['male-adult-13', 'm'], ['male-adult-17', 'm'], ['business-male-03', 'm'],
];
const CLIPS = { walk: 'walk_neutral_01', jog: 'run_slow_01', run: 'run_neutral_01', idle: 'idle_neutral_01' };
type Move = keyof typeof CLIPS;
const GAITS: Move[] = ['walk', 'jog', 'run'];
const REACH = 30; // metres: taken within this of the camera (less in a crowd, see frame())…
const SLACK = 6; // …and given back this much further off
const MOST = 24; // avatars at once
const TURN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2); // their front is +z, the figures' +x

interface Kind { template: THREE.Object3D; clips: Record<Move, THREE.AnimationClip>; stride: Record<Move, number> }
interface Person {
  kind: number;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<Move, THREE.AnimationAction>;
  w: Record<Move, number>; // how much of each clip shows
  want: Record<Move, number>;
  phase: number; // through a stride, 0 to 1
  idle: number; // seconds into the idle clip
  pos: THREE.Vector3;
  last: THREE.Vector3;
  turn: THREE.Quaternion;
  speed: number;
  seen: boolean;
}

export class LifeSize {
  group = new THREE.Group();
  enabled = true;
  private kinds: Kind[] = [];
  private state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private live = new Map<string, Person>();
  private spare: Person[][] = [];
  private ids = new WeakMap<Figures, number>();
  private on = false;
  private cam = new THREE.Vector3();
  private reach = REACH;
  private offered: number[] = []; // how far off this frame's candidates were
  private renderer: unknown;

  constructor(scene: THREE.Scene, renderer: unknown) {
    this.renderer = renderer;
    this.group.name = 'rocketbox';
    scene.add(this.group);
    LIFE_SIZE.claim = (fig, id, matrix, anim) => this.claim(fig, id, matrix, anim);
  }

  private async load() {
    this.state = 'loading';
    try {
      const ktx2 = new KTX2Loader().setTranscoderPath('rocketbox/');
      ktx2.detectSupport(this.renderer as never);
      const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
      const byName = readClips(await (await fetch('rocketbox/clips.bin')).arrayBuffer());
      this.kinds = await Promise.all(AVATARS.map(async ([name, sex]) => {
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
        const kind = { template: g.scene, clips: {} as Kind['clips'], stride: {} as Kind['stride'] };
        for (const move of Object.keys(CLIPS) as Move[]) {
          const [clip, stride] = inPlace(byName[`${sex}_${CLIPS[move]}`], hips);
          kind.clips[move] = clip;
          kind.stride[move] = stride;
        }
        return kind;
      }));
      this.spare = this.kinds.map(() => []);
      this.state = 'ready';
    } catch (e) {
      console.warn('Life-size people could not load', e);
      this.state = 'failed';
    }
  }

  // A person in the crowd, as they're drawn: true if they're shown life size instead.
  private claim(fig: Figures, id: number, matrix: THREE.Matrix4, anim: Anim) {
    if (!this.on) return false;
    if (anim.name !== 'idle' && !GAITS.includes(anim.name as Move)) return false;
    const pos = _p.setFromMatrixPosition(matrix);
    const d = Math.hypot(pos.x - this.cam.x, pos.z - this.cam.z);
    if (d < REACH + SLACK) this.offered.push(d);
    let gid = this.ids.get(fig);
    if (gid === undefined) this.ids.set(fig, (gid = this.ids_++));
    const key = `${gid}:${id}`;
    let p = this.live.get(key);
    if (!p) {
      // (Not you: the camera is in your own head.)
      if (d > this.reach || d < 1 || this.live.size >= MOST) return false;
      p = this.take((gid * 7919 + id * 104729) % this.kinds.length);
      p.pos.copy(pos);
      p.last.copy(pos);
      p.speed = 0;
      p.phase = anim.phase;
      p.idle = (id * 1.37) % p.actions.idle.getClip().duration;
      this.live.set(key, p);
      this.pose(p, anim);
      for (const m of Object.keys(p.w) as Move[]) p.w[m] = p.want[m];
    } else if (d > this.reach + SLACK) return false;
    p.pos.copy(pos);
    matrix.decompose(_v, p.turn, _s);
    this.pose(p, anim);
    p.seen = true;
    return true;
  }
  private ids_ = 0;

  // Which clips should show, from the figure's own animation.
  private pose(p: Person, anim: Anim) {
    for (const m of Object.keys(p.want) as Move[]) p.want[m] = 0;
    if (anim.name === 'idle') { p.want.idle = 1; return; }
    const g = anim.blend ? anim.gait : GAITS.indexOf(anim.name as Move);
    const lo = Math.min(Math.floor(g), GAITS.length - 2), mix = Math.min(1, Math.max(0, g - lo));
    p.want[GAITS[lo]] = 1 - mix;
    p.want[GAITS[lo + 1]] = mix;
  }

  private take(kind: number): Person {
    const reuse = this.spare[kind].pop();
    if (reuse) { reuse.root.visible = true; return reuse; }
    const k = this.kinds[kind], root = SkeletonUtils.clone(k.template);
    const mixer = new THREE.AnimationMixer(root);
    const actions = {} as Person['actions'];
    for (const m of Object.keys(CLIPS) as Move[]) {
      actions[m] = mixer.clipAction(k.clips[m]);
      actions[m].play();
    }
    this.group.add(root);
    const zero = () => ({ walk: 0, jog: 0, run: 0, idle: 0 });
    return { kind, root, mixer, actions, w: zero(), want: zero(), phase: 0, idle: 0, pos: new THREE.Vector3(), last: new THREE.Vector3(), turn: new THREE.Quaternion(), speed: 0, seen: false };
  }

  // Once a frame, after the crowd is drawn and before the picture: `eyes` is whether the
  // view is first person.
  frame(dt: number, eyes: boolean, camera: THREE.Camera) {
    eyes &&= this.enabled;
    if (eyes && this.state === 'idle') void this.load();
    this.on = eyes && this.state === 'ready';
    this.cam.copy(camera.position);
    // In a crowd there are more people near than avatars: the reach draws in to the
    // nearest MOST of them (those beyond it are let go) and widens again as the crowd thins.
    const o = this.offered.sort((a, b) => a - b);
    this.reach = o.length > MOST ? Math.min(REACH, o[MOST - 1]) : REACH;
    o.length = 0;
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
      let stride = 0, sum = 0;
      for (const m of Object.keys(p.w) as Move[]) {
        p.w[m] += (p.want[m] - p.w[m]) * Math.min(1, dt * 8);
        if (p.w[m] < 0.01 && p.want[m] === 0) p.w[m] = 0; // (a clip at no weight isn't worked out at all)
        if (m !== 'idle') { stride += k.stride[m] * p.w[m]; sum += p.w[m]; }
      }
      if (sum > 0.01) p.phase = (p.phase + (p.speed * dt) / (stride / sum)) % 1;
      p.idle += dt;
      for (const m of Object.keys(p.w) as Move[]) {
        const a = p.actions[m], len = a.getClip().duration;
        a.setEffectiveWeight(p.w[m]);
        a.time = m === 'idle' ? p.idle % len : p.phase * len;
      }
      p.mixer.update(0);
      p.root.position.copy(p.pos);
      p.root.quaternion.copy(p.turn).multiply(TURN);
    }
  }
}

const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3();

// The clips as assets/rocketbox/clips.mjs writes them: a header (JSON) with each clip's
// name, frames, fps and joints, then Bip01's positions and each joint's turns, frame by frame.
function readClips(buffer: ArrayBuffer) {
  const length = new DataView(buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as { clips: { name: string; frames: number; fps: number; joints: string[] }[] };
  const data = new Float32Array(buffer, 4 + length);
  const clips: Record<string, THREE.AnimationClip> = {};
  let at = 0;
  const take = (n: number) => data.slice(at, (at += n));
  for (const c of head.clips) {
    const times = Float32Array.from({ length: c.frames }, (_, i) => i / c.fps);
    const tracks: THREE.KeyframeTrack[] = [new THREE.VectorKeyframeTrack('Bip01.position', times, take(c.frames * 3))];
    for (const joint of c.joints) tracks.push(new THREE.QuaternionKeyframeTrack(`${joint}.quaternion`, times, take(c.frames * 4)));
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
