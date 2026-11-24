import * as THREE from 'three';
import { fetchBinary } from './terrain.ts';
import { send } from './gpu.ts';
import { SCALE, type Anim } from './figures.ts';
import { lampLit } from './lamps.ts';
import { AVATARS } from './rocketboxClips.ts';
import { STREET_QUALITY } from './streetQuality.ts';
import { inStreetCone } from './streetView.ts';

// The same people as the individual Rocketbox avatars, with their photographed
// clothes and four baked motions. A batch shares one mesh for each identity.
type Motion = 'idle' | 'walk' | 'jog' | 'run';
interface Clip { row: number; frames: number; duration: number }
interface Model { name: string; vertices: number; uv: number; index: number; indices: number; clips: Record<Motion, Clip> }
interface Header { version: number; width: number; height: number; poses: number; models: Model[] }
interface Batch { model: Model; mesh: THREE.InstancedMesh; pose: THREE.InstancedBufferAttribute; next: number }
const MAX = 64;
const inverseScale = new THREE.Vector3(1 / SCALE, 1 / SCALE, 1 / SCALE);
const matrix = new THREE.Matrix4();

async function unpack(buffer: ArrayBuffer) {
  const length = new DataView(buffer).getUint32(0, true);
  const header: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  const words = new Uint16Array(buffer, 4 + length);
  const { version, width, height, poses, models } = header;
  const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (version !== 1 || !integer(width) || !integer(height) || !integer(poses) || !width || !height ||
      poses + width * height * 4 !== words.length || models.length !== AVATARS.length) throw Error('Invalid street crowd file');
  for (const [i, m] of models.entries()) {
    if (m.name !== AVATARS[i][0] || !integer(m.vertices) || !m.vertices || m.vertices > width ||
        !integer(m.uv) || m.uv + m.vertices * 2 > poses || !integer(m.index) || !integer(m.indices) ||
        !m.indices || m.indices % 3 || m.index + m.indices > poses) throw Error('Invalid crowd geometry');
    for (const key of ['idle', 'walk', 'jog', 'run'] as const) {
      const c = m.clips[key];
      if (!c || !integer(c.row) || !integer(c.frames) || !c.frames || c.row + c.frames > height ||
          !(c.duration > 0 && Number.isFinite(c.duration))) throw Error('Invalid crowd clip');
    }
  }
  const texels = words.subarray(poses), stride = width * 4;
  // Restore the exact half floats. Yield between slices on a slow phone.
  let since = performance.now();
  for (let row = 1; row < height; row++) {
    const end = (row + 1) * stride;
    for (let i = row * stride; i < end; i++) texels[i] += texels[i - stride];
    if (performance.now() - since > 4) {
      await new Promise(resolve => setTimeout(resolve, 0));
      since = performance.now();
    }
  }
  return { header, words, texels };
}

function bindPoses(material: THREE.MeshLambertMaterial | THREE.MeshDepthMaterial, vat: THREE.DataTexture, colour: boolean) {
  material.userData.crowdPoses = vat;
  material.customProgramCacheKey = () => colour ? 'street-crowd' : 'street-crowd-depth';
  material.onBeforeCompile = shader => {
    shader.uniforms.uCrowdPoses = { value: vat };
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
      uniform highp sampler2D uCrowdPoses;
      attribute vec3 crowdPose;
      vec3 crowdNormal(float word) {
        vec2 p = vec2(mod(word,32.),floor(word/32.))*(2./31.)-1.;
        float z = 1.-abs(p.x)-abs(p.y);
        if(z<0.) p=(1.-abs(p.yx))*sign(p);
        return vec3(p,z);
      }`).replace('void main() {', `void main() {
        vec4 crowdA=texelFetch(uCrowdPoses,ivec2(gl_VertexID,int(crowdPose.x)),0);
        vec4 crowdB=texelFetch(uCrowdPoses,ivec2(gl_VertexID,int(crowdPose.y)),0);`)
      .replace('#include <begin_vertex>', 'vec3 transformed=mix(crowdA.xyz,crowdB.xyz,crowdPose.z);')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal=normalize(mix(crowdNormal(crowdA.w),crowdNormal(crowdB.w),crowdPose.z));');
    if (colour) lampLit(shader);
  };
}

export class StreetCrowd {
  enabled = true;
  loading = false;
  private disposed = false;
  private retryAt = 0;
  private batches: Batch[] = [];
  private material?: THREE.MeshLambertMaterial;
  private depth?: THREE.MeshDepthMaterial;
  private vat?: THREE.DataTexture;
  private active = false;
  private elapsed = 0;
  private count = 0;
  private limit = 0;
  private range = 0;
  private reach = 0;
  private eye = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private cosHalf = 0;
  private sinHalf = 1;
  private offered: number[] = [];

  constructor(private group: THREE.Group) {}

  private async load() {
    this.loading = true;
    let atlas: THREE.Texture | undefined;
    try {
      const base = import.meta.env.BASE_URL + 'rocketbox/crowd';
      const [data, image] = await Promise.allSettled([fetchBinary(base + '.bin.gz', true), new THREE.TextureLoader().loadAsync(base + '.webp')]);
      if (image.status === 'fulfilled') atlas = image.value;
      if (!atlas || data.status !== 'fulfilled' || !data.value) throw Error('Could not load street crowd');
      const { header, words, texels } = await unpack(data.value);
      if (this.disposed) return;
      atlas.colorSpace = THREE.SRGBColorSpace; atlas.flipY = false; atlas.anisotropy = 4; atlas.needsUpdate = true;
      const vat = this.vat = new THREE.DataTexture(texels, header.width, header.height, THREE.RGBAFormat, THREE.HalfFloatType);
      vat.needsUpdate = true;
      this.material = new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide, alphaTest: .35 });
      this.depth = new THREE.MeshDepthMaterial({ map: atlas, side: THREE.DoubleSide, alphaTest: .35, depthPacking: THREE.RGBADepthPacking });
      atlas = undefined; // now owned by this.material
      bindPoses(this.material, vat, true); bindPoses(this.depth, vat, false);
      for (const model of header.models) {
        const geometry = new THREE.BufferGeometry(), positions = new Float32Array(model.vertices * 3);
        const idle = model.clips.idle.row * header.width;
        for (let i = 0; i < model.vertices; i++) for (let axis = 0; axis < 3; axis++)
          positions[i * 3 + axis] = THREE.DataUtils.fromHalfFloat(texels[(idle + i) * 4 + axis]);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(words.subarray(model.uv, model.uv + model.vertices * 2), 2, true));
        geometry.setIndex(new THREE.BufferAttribute(words.subarray(model.index, model.index + model.indices), 1));
        geometry.computeVertexNormals();
        const pose = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
        geometry.setAttribute('crowdPose', pose);
        const mesh = new THREE.InstancedMesh(geometry, this.material, MAX);
        mesh.name = 'Street crowd ' + model.name;
        mesh.userData.sharedMatrices = true;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.customDepthMaterial = this.depth;
        mesh.frustumCulled = false; // accepted around the eye; individual groups can cross tiles
        mesh.count = 0; mesh.visible = false;
        this.group.add(mesh);
        this.batches.push({ model, mesh, pose, next: 0 });
      }
    } catch {
      this.release();
      this.retryAt = performance.now() + 60000;
    } finally { atlas?.dispose(); this.loading = false; }
  }

  offer(catalogue: number, id: number, transform: THREE.Matrix4, anim: Anim) {
    if (!this.active || !this.enabled) return false;
    const motion = anim.name;
    if (motion !== 'idle' && motion !== 'walk' && motion !== 'jog' && motion !== 'run') return false;
    const e = transform.elements, dx = e[12] - this.eye.x, dz = e[14] - this.eye.z, d2 = dx * dx + dz * dz;
    if (d2 < .09 || d2 > this.range * this.range ||
        (this.cosHalf > 0 && !inStreetCone(dx, dz, this.direction.x, this.direction.z, this.sinHalf, this.cosHalf, 4))) return false;
    if (!this.batches.length) {
      if (!this.loading && performance.now() >= this.retryAt) void this.load();
      return false;
    }
    this.offered.push(d2);
    if (this.count >= this.limit || d2 > this.reach) return false;
    const batch = this.batches[catalogue];
    const gait = anim.blend ? (anim.gait < .5 ? 'walk' : anim.gait < 1.5 ? 'jog' : 'run') : motion;
    const clip = batch.model.clips[gait];
    const phase = gait === 'idle' ? this.elapsed / clip.duration + id * .618034 : anim.phase;
    const frame = (phase - Math.floor(phase)) * clip.frames, i = Math.floor(frame);
    batch.pose.setXYZ(batch.next, clip.row + i, clip.row + (i + 1) % clip.frames, frame - i);
    batch.mesh.setMatrixAt(batch.next++, matrix.copy(transform).scale(inverseScale));
    this.count++;
    return true;
  }

  frame(dt: number, street: boolean, camera: THREE.Camera) {
    const active = street && this.enabled && STREET_QUALITY.avatars >= 12;
    if (!active && !this.active) return;
    this.active = active;
    this.limit = Math.min(MAX, STREET_QUALITY.avatars * 2);
    this.range = Math.min(85, STREET_QUALITY.avatarReach * 1.9);
    this.reach = this.offered.length > this.limit ? this.offered.sort((a, b) => a - b)[this.limit - 1] : this.range * this.range;
    for (const batch of this.batches) {
      batch.mesh.count = batch.next;
      batch.mesh.visible = this.active && batch.next > 0;
      if (batch.mesh.visible) { send(batch.mesh.instanceMatrix, batch.next); send(batch.pose, batch.next); }
      batch.next = 0;
    }
    this.offered.length = this.count = 0;
    if (!this.active) return;
    this.elapsed += dt;
    this.eye.copy(camera.position);
    camera.getWorldDirection(this.direction);
    this.direction.y = 0;
    const perspective = camera as THREE.PerspectiveCamera;
    if (this.direction.lengthSq() < .04 || !perspective.isPerspectiveCamera) { this.cosHalf = 0; return; }
    this.direction.normalize();
    const half = Math.min(Math.PI / 2, Math.atan(Math.tan(perspective.fov * Math.PI / 360) * perspective.aspect) + .08);
    this.cosHalf = Math.cos(half); this.sinHalf = Math.sin(half);
  }

  private release() {
    for (const { mesh } of this.batches) { mesh.removeFromParent(); mesh.dispose(); mesh.geometry.dispose(); }
    this.batches.length = 0;
    this.material?.map?.dispose(); this.material?.dispose(); this.depth?.dispose(); this.vat?.dispose();
    this.material = this.depth = this.vat = undefined;
  }

  dispose() { this.disposed = true; this.release(); }
}
