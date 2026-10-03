import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, If, Loop, Break, float, vec3, vec4, attribute, positionWorld, cameraPosition,
  cameraViewMatrix, cameraNear, cameraFar, viewportDepthTexture, perspectiveDepthToViewZ,
  texture3D, abs, max, min, step, normalize, smoothstep, exp,
} from 'three/tsl';
import type { LocalMistParts } from '../localmist.ts';
import { type N, follow, followVec, followColor } from './common.ts';
import { lampLight } from './lamps.ts';

// A seeded lattice with trilinear filtering gives continuous procedural 3D noise.
// Two reads per step, one shared texture binding, no per-fragment corner hashing.
const SIZE = 32, data = new Uint8Array(SIZE ** 3);
let random = 0x6d697374;
for (let i = 0; i < data.length; i++) {
  random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
  data[i] = random >>> 24;
}
const noiseTexture = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
noiseTexture.format = THREE.RedFormat;
noiseTexture.minFilter = noiseTexture.magFilter = THREE.LinearFilter;
noiseTexture.wrapS = noiseTexture.wrapT = noiseTexture.wrapR = THREE.RepeatWrapping;
noiseTexture.unpackAlignment = 1;
noiseTexture.needsUpdate = true;
const noise = texture3D(noiseTexture);

export function localMistMaterial(f: LocalMistParts, linear: (colour: N) => N) {
  const m = new NodeMaterial();
  Object.assign(m, { transparent: true, depthWrite: false, depthTest: false, side: THREE.BackSide, fog: false, toneMapped: false });
  const shape: N = followVec(f.shape), steps: N = follow(f.steps), amount: N = follow(f.amount), time: N = follow(f.time);
  const fog: N = followColor(f.fog);
  // One depth copy after opaque scenery, shared by every bank in this one draw.
  const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);
  depthTexture.format = THREE.DepthStencilFormat; // the game needs stencil for tunnels
  const depth: N = (viewportDepthTexture as N)(undefined, null, depthTexture);
  let samples = 0;
  const cacheKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => `${cacheKey()}:mist-depth-${samples}`;
  m.userData.prepare = (renderer: N) => {
    if (samples === renderer.currentSamples) return;
    samples = renderer.currentSamples;
    // Lowest changes the depth texture from multisampled to single-sample even
    // at the same resolution. Rebuild its binding and WGSL declaration together.
    depth.value.dispose();
    m.dispose();
    m.needsUpdate = true;
  };
  const copyDepth = depth.updateBefore.bind(depth);
  depth.updateBefore = (frame: N) => {
    copyDepth(frame);
    // r186 builds an "all" aspect view for sampled stencil textures. Sampling
    // requires depth-only; seed its existing view cache for this texture alone.
    const data = frame.renderer.backend.get(depth.value), gpu = data.texture;
    const key = `view-${gpu.width}-${gpu.height}-${gpu.mipLevelCount}-0`;
    data[key] ??= gpu.createView({ aspect: 'depth-only', dimension: '2d', mipLevelCount: gpu.mipLevelCount, baseMipLevel: 0 });
  };
  m.fragmentNode = Fn(() => {
    const centre: N = attribute('mistCentre', 'vec3');
    const half: N = attribute('mistHalfSize', 'vec3');
    const slope: N = attribute('mistSlope', 'vec3');
    const origin = cameraPosition.sub(centre).toVar();
    const ray: N = normalize(positionWorld.sub(cameraPosition)).toVar();
    const viewRay: N = cameraViewMatrix.mul(vec4(ray, 0)).z.negate().toVar();
    const inverse: N = vec3(1).div(step(0, ray).mul(2).sub(1).mul(max(abs(ray), vec3(0.00001))));
    const a = half.negate().sub(origin).mul(inverse), b = half.sub(origin).mul(inverse);
    const near: N = min(a, b), far: N = max(a, b);
    const enter = max(max(near.x, max(near.y, near.z)), cameraNear.div(viewRay));
    // Stop at the nearest opaque surface: a wall cannot receive mist behind it,
    // while the segment between the camera and the wall still contains mist.
    const sceneDistance = perspectiveDepthToViewZ(depth.r, cameraNear, cameraFar).negate().div(viewRay);
    const leave = min(min(far.x, min(far.y, far.z)), sceneDistance).toVar();
    const opacity = float(0).toVar();
    const mid = cameraPosition.add(ray.mul(enter.add(leave).mul(0.5)));
    const colour = linear(fog.add(exp(lampLight(mid).mul(-0.5)).oneMinus().mul(0.6))).toVar();
    If(leave.greaterThan(enter), () => {
      const stride = leave.sub(enter).div(steps).toVar();
      const optical = float(0).toVar();
      const drift = vec3(time.mul(shape.w), 0, time.mul(shape.w).mul(0.4));
      Loop(16, ({ i }) => {
        If(float(i).greaterThanEqual(steps), () => { Break(); });
        const p = cameraPosition.add(ray.mul(enter.add(float(i).add(0.5).mul(stride)))).toVar();
        const local = p.sub(centre);
        const h = local.y.sub(local.x.mul(slope.x)).sub(local.z.mul(slope.y)).div(slope.z);
        const q = p.sub(drift).mul(shape.z).div(SIZE);
        const n = noise.sample(q).level(float(0)).r.mul(0.7)
          .add(noise.sample(q.mul(2.03).add(vec3(0.17, 0.31, 0.53))).level(float(0)).r.mul(0.3));
        const edge = smoothstep(0, shape.y, float(1).sub(abs(local.x).div(half.x)))
          .mul(smoothstep(0, shape.y, float(1).sub(abs(local.z).div(half.z))))
          .mul(smoothstep(-1, -0.7, h)).mul(float(1).sub(smoothstep(-0.2, 1, h)));
        optical.addAssign(smoothstep(0.3, 0.7, n).mul(edge).mul(stride));
      });
      opacity.assign(exp(optical.mul(shape.x).mul(amount).negate()).oneMinus());
    });
    return vec4(colour, opacity);
  })();
  return m;
}
