import * as THREE from 'three';

// Who appears, with which set of clips (women's or men's). The same list is in build.sh.
export const AVATARS: [string, 'f' | 'm'][] = [
  ['female-adult-01', 'f'], ['female-adult-03', 'f'], ['female-adult-05', 'f'], ['female-adult-08', 'f'],
  ['female-adult-11', 'f'], ['female-adult-14', 'f'], ['business-female-02', 'f'],
  ['male-adult-01', 'm'], ['male-adult-04', 'm'], ['male-adult-07', 'm'], ['male-adult-10', 'm'],
  ['male-adult-13', 'm'], ['male-adult-17', 'm'], ['business-male-03', 'm'],
];
export const CLIPS = { walk: 'walk_neutral_01', jog: 'run_slow_01', run: 'run_neutral_01' };
export const avatarIndex = (seed: number | undefined, group: number, person: number) =>
  (seed ?? (group * 7919 + person * 104729)) % AVATARS.length;

// The clips as assets/rocketbox/clips.mjs writes them: a header (JSON) with each clip's
// name, frames, fps, moving and still joints, then int16s: Bip01's positions (millimetres)
// and each joint's turns (in 32767ths), frame by frame, then the still joints' once.
export function readClips(buffer: ArrayBuffer) {
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
export function inPlace(source: THREE.AnimationClip, hips: number): [THREE.AnimationClip, number] {
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
