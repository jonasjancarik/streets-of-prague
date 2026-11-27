import * as THREE from 'three';
import { fetchBinary } from './terrain.ts';
import { send } from './gpu.ts';
import { SCALE, LAMP_CAST_LAYER, type Anim } from './figures.ts';
import { lampLit } from './lamps.ts';
import { AVATARS } from './rocketboxClips.ts';
import { STREET_QUALITY } from './streetQuality.ts';
import { inStreetCone } from './streetView.ts';
import { DYES, DYE_GLSL, dyeRegions, dyeUniforms, outfit, wear } from './avatarDyes.ts';

// The same people as the individual Rocketbox avatars, with their photographed
// clothes and four baked motions. A batch shares one mesh for each identity.
type Motion = 'idle' | 'walk' | 'jog' | 'run';
interface Clip { row: number; frames: number; duration: number }
interface Model { name: string; vertices: number; uv: number; index: number; indices: number; clips: Record<Motion, Clip> }
interface Header { version: number; width: number; height: number; poses: number; models: Model[] }
// `dye`: for an avatar with colourways (avatarDyes.ts), each instance's top and bottom.
interface Batch { model: Model; mesh: THREE.InstancedMesh; pose: THREE.InstancedBufferAttribute; next: number; dye?: THREE.InstancedBufferAttribute[] }
const MAX = 64;
// The atlas's cells, as assets/rocketbox/crowd.mjs lays them out: four materials an avatar,
// the body first, each in a square cell with a gutter round it.
const CELL = 128, GUTTER = 4, PARTS = 4;
const inverseScale = new THREE.Vector3(1 / SCALE, 1 / SCALE, 1 / SCALE);
const matrix = new THREE.Matrix4();
const DYED: number[] = [];

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

// `dye`: an avatar with colourways, dyed in each instance's (crowdTop, crowdBottom) at the
// body's place in the atlas (`material.userData.dyeCell`). Every avatar shares the shader:
// the regions are uniforms (webgpu/avatars.ts reads them from the batch's mesh).
function bindPoses(material: THREE.MeshLambertMaterial | THREE.MeshDepthMaterial, vat: THREE.DataTexture, colour: boolean, dye = false) {
  material.userData.crowdPoses = vat;
  material.customProgramCacheKey = () => colour ? (dye ? 'street-crowd-dye' : 'street-crowd') : 'street-crowd-depth';
  material.onBeforeCompile = shader => {
    if (dye) {
      Object.assign(shader.uniforms, dyeUniforms(material.userData.dye), { uDyeCell: { value: material.userData.dyeCell } });
      shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        attribute vec4 crowdTop, crowdBottom;
        varying vec4 vDyeTop, vDyeBottom;`).replace('#include <uv_vertex>', '#include <uv_vertex>\nvDyeTop = crowdTop; vDyeBottom = crowdBottom;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
        ${DYE_GLSL}
        uniform vec4 uDyeCell;
        varying vec4 vDyeTop, vDyeBottom;`).replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = dyed(diffuseColor.rgb, vMapUv * uDyeCell.xy + uDyeCell.zw, vDyeTop, vDyeBottom);`);
    }
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
  // Compiles an object's shaders (renderer.compileAsync, from lifesize.ts): the batches'
  // are compiled once loaded, before anyone is drawn in them, so they don't stall a frame.
  compile?: (o: THREE.Object3D) => Promise<unknown>;
  // Batches still to be drawn once, shrunk to nothing, before anyone walks in the crowd:
  // one a frame, for what compile doesn't cover (each batch's own builds, the shadow pass).
  private warming = 0;
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
      const { width: atlasWidth, height: atlasHeight } = atlas.image as HTMLImageElement, atlasSize = [atlasWidth, atlasHeight];
      const vat = this.vat = new THREE.DataTexture(texels, header.width, header.height, THREE.RGBAFormat, THREE.HalfFloatType);
      vat.needsUpdate = true;
      this.material = new THREE.MeshLambertMaterial({ map: atlas, side: THREE.DoubleSide, alphaTest: .35 });
      this.depth = new THREE.MeshDepthMaterial({ map: atlas, side: THREE.DoubleSide, alphaTest: .35, depthPacking: THREE.RGBADepthPacking });
      atlas = undefined; // now owned by this.material
      bindPoses(this.material, vat, true); bindPoses(this.depth, vat, false);
      // The batches while their shaders compile: out of the scene, so none is drawn (the
      // scene's lights still go into the compile).
      const staging = new THREE.Group();
      for (const [catalogue, model] of header.models.entries()) {
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
        let material = this.material, dye: Batch['dye'];
        if (DYES[model.name]) {
          // The body texture's 512 units from the atlas's uv: its cell's corner and size.
          const slot = catalogue * PARTS, across = atlasSize[0] / CELL, inner = CELL - 2 * GUTTER;
          const x = slot % across * CELL + GUTTER, y = Math.floor(slot / across) * CELL + GUTTER;
          // (Not a clone: that would copy userData, the pose texture included.)
          material = new THREE.MeshLambertMaterial({ map: this.material.map, side: THREE.DoubleSide, alphaTest: .35 });
          material.userData.dye = dyeRegions(model.name);
          material.userData.dyeCell = new THREE.Vector4(atlasSize[0] * 512 / inner, atlasSize[1] * 512 / inner, -x * 512 / inner, -y * 512 / inner);
          bindPoses(material, vat, true, true);
          dye = ['crowdTop', 'crowdBottom'].map(name => {
            const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
            geometry.setAttribute(name, a);
            return a;
          });
        }
        const mesh = new THREE.InstancedMesh(geometry, material, MAX);
        mesh.name = 'Street crowd ' + model.name;
        if (dye) { mesh.userData.dye = material.userData.dye; mesh.userData.dyeCell = material.userData.dyeCell; }
        mesh.userData.sharedMatrices = true;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.layers.enable(LAMP_CAST_LAYER);
        mesh.customDepthMaterial = this.depth;
        mesh.frustumCulled = false; // accepted around the eye; individual groups can cross tiles
        mesh.count = 1; // (for the compile)
        staging.add(mesh);
        this.batches.push({ model, mesh, pose, next: 0, dye });
      }
      try { await this.compile?.(staging); } catch (e) { console.warn('Street crowd shaders', e); }
      for (const { mesh } of this.batches) { mesh.count = 0; mesh.visible = false; this.group.add(mesh); }
      this.warming = this.batches.length;
      if (this.disposed) this.release();
    } catch {
      this.release();
      this.retryAt = performance.now() + 60000;
    } finally { atlas?.dispose(); this.loading = false; }
  }

  // `wearing`: the person's colours (Figures.colours), for the colourway they wear up close.
  offer(catalogue: number, id: number, transform: THREE.Matrix4, anim: Anim, wearing?: ArrayLike<number>) {
    if (!this.active || !this.enabled) return false;
    const motion = anim.name;
    if (motion !== 'idle' && motion !== 'walk' && motion !== 'jog' && motion !== 'run') return false;
    const e = transform.elements, dx = e[12] - this.eye.x, dz = e[14] - this.eye.z, d2 = dx * dx + dz * dz;
    if (d2 < .09 || d2 > this.range * this.range ||
        (this.cosHalf > 0 && !inStreetCone(dx, dz, this.direction.x, this.direction.z, this.sinHalf, this.cosHalf, 4))) return false;
    if (!this.batches.length || this.loading || this.warming) {
      if (!this.batches.length && !this.loading && performance.now() >= this.retryAt) void this.load();
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
    if (batch.dye) {
      wear(batch.model.name, outfit(batch.model.name, wearing), DYED);
      batch.dye[0].setXYZW(batch.next, DYED[0], DYED[1], DYED[2], DYED[3]);
      batch.dye[1].setXYZW(batch.next, DYED[4], DYED[5], DYED[6], DYED[7]);
    }
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
    for (const batch of this.loading ? [] : this.batches) { // (none drawn while compiling)
      batch.mesh.count = batch.next;
      batch.mesh.visible = this.active && batch.next > 0;
      if (batch.mesh.visible) {
        send(batch.mesh.instanceMatrix, batch.next); send(batch.pose, batch.next);
        for (const d of batch.dye ?? []) send(d, batch.next);
      }
      batch.next = 0;
    }
    if (this.warming && active && !this.loading) {
      const { mesh } = this.batches[--this.warming];
      mesh.setMatrixAt(0, matrix.makeScale(1e-4, 1e-4, 1e-4).setPosition(camera.position));
      mesh.count = 1; mesh.visible = true;
      send(mesh.instanceMatrix, 1);
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
    for (const { mesh } of this.batches) {
      mesh.removeFromParent(); mesh.dispose(); mesh.geometry.dispose();
      if (mesh.material !== this.material) (mesh.material as THREE.Material).dispose(); // (an avatar's dyed one: the atlas is this.material's)
    }
    this.batches.length = this.warming = 0;
    this.material?.map?.dispose(); this.material?.dispose(); this.depth?.dispose(); this.vat?.dispose();
    this.material = this.depth = this.vat = undefined;
  }

  dispose() { this.disposed = true; this.release(); }
}
