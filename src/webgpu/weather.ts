// The falling rain, the snow and the mist (WeatherFx in ../weather.ts) in TSL. The rain is
// line segments and the mist a plane, as there; the snow is a small quad for each flake,
// because points are one pixel wide on WebGPU.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, positionGeometry, positionWorld, cameraProjectionMatrix, cameraViewMatrix, screenSize,
  sRGBTransferEOTF, toneMappingExposure, fract, sin, cos, exp, normalize, step, smoothstep, length, max, min, select,
} from 'three/tsl';
import { setFx, type FxParts } from '../weather.ts';
import { type N, follow, followVec, fbm2, vnoise } from './common.ts';
import { lampLight } from './lamps.ts';

const FALL = 9, FLAKE_FALL = 1.1; // m/s, as in ../weather.ts

// The colours here are display colours (what WebGL writes, after its tone curve). Blending
// happens before the curve here, so a colour goes in as the value the curve turns into it
// (the curve in webgpu.ts, undone step by step; its 12% desaturation is left out, these
// colours are near grey). A blend of a see-through layer then comes out a little different from
// WebGL's, which mixes the display colours: nearly the same at high opacity (the snow), a
// little off at low (the rain and mist).
const linear = (d: N): N => Fn(() => {
  const y: N = sRGBTransferEOTF(d);
  const e: N = toneMappingExposure;
  const lift = vec3(0.016, 0.012, 0.006);
  const h = y.sub(lift).div(lift.oneMinus()).clamp(0, 1);
  const c = h.toVar();
  for (let i = 0; i < 4; i++) { // the S curve
    c.subAssign(c.mul(0.65).add(c.mul(c).mul(c.mul(-2).add(3)).mul(0.35)).sub(h).div(c.mul(c.oneMinus()).mul(2.1).add(0.65)));
  }
  const k = c.oneMinus();
  const x = k.mul(k).add(c.div(9)).sqrt().sub(k).mul(18); // the roll-off towards white
  return select(e.lessThan(0), y.div(e.negate()), x.div(max(e, 0.001)));
})();

function build(f: FxParts) {
  const uCentre: N = followVec(f.shared.uCentre as any), uBox: N = followVec(f.shared.uBox as any), uWind: N = followVec(f.shared.uWind as any);
  const uTime = follow(f.shared.uTime), uTint: N = followVec(f.tint as any), uFog: N = followVec(f.fog as any);
  const uScale = follow(f.scale);
  const uOn = { rain: follow(f.rainOn), snow: follow(f.snowOn), mist: follow(f.mistOn) };

  // Where a drop is: in a box over the view that stays put in the world (WRAP_GLSL).
  const dropAt = (seed: N, fall: N, sway: number) => {
    const size = uBox.x;
    let drift: N = uWind.mul(uTime);
    if (sway) drift = drift.add(vec2(sin(uTime.mul(0.9).add(seed.w.mul(6.28))), cos(uTime.mul(0.7).add(seed.w.mul(4.1)))).mul(sway));
    const lo = uCentre.xz.sub(size.mul(0.5));
    const xz = lo.add(fract(seed.xz.add(drift.sub(lo).div(size))).mul(size));
    const y = uCentre.y.add(fract(seed.y.sub(uTime.mul(fall).div(uBox.y))).mul(uBox.y));
    return vec3(xz.x, y, xz.y);
  };
  const seed = attribute('seed', 'vec4');
  const blend = (m: NodeMaterial) => {
    Object.assign(m, { transparent: true, depthWrite: false, fog: false, toneMapped: false });
    return m;
  };

  // Rain: a streak for each drop, its head and its tail.
  const rainMaterial = blend(new NodeMaterial());
  {
    const tail = attribute('tail', 'float');
    const head = dropAt(seed, float(FALL), 0);
    const p = head.sub(normalize(vec3(uWind.x, -FALL, uWind.y)).mul(tail).mul(seed.w.mul(0.6).add(0.9)));
    const lit = Fn(() => exp(lampLight(vec3(p.x, uCentre.y, p.z)).mul(-2.5)).oneMinus())();
    const a = step(seed.w, uOn.rain).mul(tail.mul(-0.7).add(1)).mul(max(lit.r, lit.g).mul(0.6).add(0.35));
    const out = vec4(linear(uTint.add(lit)), a).toVarying('vRain');
    rainMaterial.vertexNode = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1));
    rainMaterial.fragmentNode = out;
  }

  // Snow: soft flakes, swaying as they come down; a quad about `size` pixels across.
  const snowMaterial = blend(new NodeMaterial());
  {
    const p = dropAt(seed, seed.w.mul(0.6).add(0.7).mul(FLAKE_FALL), 0.8);
    const lit = Fn(() => exp(lampLight(vec3(p.x, uCentre.y, p.z)).mul(-1.5)).oneMinus())();
    const mv = cameraViewMatrix.mul(vec4(p, 1));
    const size = max(float(1.5), uScale.mul(seed.w.mul(0.1).add(0.12)).div(mv.z.negate()));
    const clip = cameraProjectionMatrix.mul(mv);
    const corner = positionGeometry.xy;
    snowMaterial.vertexNode = vec4(clip.xy.add(corner.mul(size).div(screenSize).mul(clip.w)), clip.z, clip.w);
    const vCorner = corner.toVarying('vCorner');
    const colour = min(max(uTint.mul(1.3), vec3(0.32, 0.34, 0.38)).add(lit), vec3(1));
    const rgba = vec4(linear(colour), step(seed.w, uOn.snow).mul(0.9)).toVarying('vSnow');
    snowMaterial.fragmentNode = Fn(() => vec4(rgba.rgb, rgba.a.mul(float(1).sub(smoothstep(0.3, 1, length(vCorner))))))();
    snowMaterial.side = THREE.DoubleSide;
  }

  // Mist: a drifting sheet a few metres above the ground.
  const mistMaterial = blend(new NodeMaterial());
  mistMaterial.fragmentNode = Fn(() => {
    const p = positionWorld.xz.mul(0.014).add(uTime.mul(vec2(0.01, 0.004))).toVar();
    const n = fbm2(p.add(fbm2(p.mul(0.6).add(3)).mul(0.5)).sub(uTime.mul(vec2(0.004, 0.007)))).mul(0.75).add(vnoise(p.mul(4.1).add(5)).mul(0.25));
    const a = uOn.mist.mul(smoothstep(0.3, 0.75, n).mul(0.5).add(0.18));
    const c = uFog.add(exp(lampLight(positionWorld).mul(-0.5)).oneMinus().mul(0.6));
    return vec4(linear(c), a);
  })();

  // The flakes' quad, drawn once for each of them.
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  g.setAttribute('seed', new THREE.InstancedBufferAttribute(f.snowSeeds, 4));
  g.instanceCount = f.snowSeeds.length / 4;

  return {
    rain: new THREE.LineSegments(f.rain, rainMaterial),
    snow: new THREE.Mesh(g, snowMaterial),
    mist: new THREE.Mesh(f.mist, mistMaterial),
  };
}

setFx(build);
