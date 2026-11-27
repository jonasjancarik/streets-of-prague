// The shadows of the street lamps nearest you (CLOSE in ../lamps.ts), as the sun's are
// drawn: for each lamp, a depth map of what stands on LAMP_CAST_LAYER (the people, cars,
// two-wheelers and avatars), seen from its head looking straight down. Each material's own
// shadow position (castShadowPositionNode: a person in their pose of the moment) is used,
// as three.js does for the sun, through a shadow-pass material. The maps lie side by side
// in one depth texture; webgpu/lamps.ts reads them (lampLight).

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as THREE from 'three';
import { NodeMaterial, RenderTarget, RendererUtils as Utils } from 'three/webgpu';
import { vec4 } from 'three/tsl';
import { CLOSE, setClose } from '../lamps.ts';
import { LAMP_CAST_LAYER } from '../figures.ts';

// (three.js's own helpers for a pass of its own, as the sun's shadow uses: their typings lag.)
const RendererUtils = Utils as any;

setClose((renderer, scene) => {
  const r = renderer as any, size = CLOSE.size, n = CLOSE.count;
  const depth = new THREE.DepthTexture(size * n, size, THREE.FloatType);
  depth.minFilter = depth.magFilter = THREE.NearestFilter;
  // (Its colour, which nothing reads, as small as a texel can be.)
  const target = new RenderTarget(size * n, size, { depthTexture: depth, depthBuffer: true, format: THREE.RedFormat, type: THREE.UnsignedByteType });
  const material = new NodeMaterial() as any;
  material.colorNode = vec4(0, 0, 0, 1);
  material.isShadowPassMaterial = true;
  material.blending = THREE.NoBlending;
  material.fog = false;
  material.name = 'LampShadowMaterial';
  // (Only what casts a shadow: as the sun's shadow pass, _getShadowRenderObjectFunction.)
  const only = (object: THREE.Object3D, ...rest: unknown[]) => {
    if (object.castShadow) r.renderObject(object, ...rest);
  };
  let state: any;
  const clear = () => {
    state = RendererUtils.resetRendererAndSceneState(r, scene, state);
    r.setRenderTarget(target);
    r.clear(true, true, false);
    RendererUtils.restoreRendererAndSceneState(r, scene, state);
  };
  // (Set up on the GPU now, before any material binds the texture: see Lamps.wipe.)
  clear();
  return {
    texture: depth,
    // One camera a slot (null: nothing drawn there).
    draw(cams: (THREE.Camera | null)[]) {
      state = RendererUtils.resetRendererAndSceneState(r, scene, state);
      scene.overrideMaterial = material;
      r.setRenderObjectFunction(only);
      r.transparent = false; // (glass doesn't write depth)
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.autoClear = false;
      // (The scene's matrices are as the last frame left them: the casters move by their
      // instance matrices, which are up to date.)
      const auto = scene.matrixWorldAutoUpdate;
      scene.matrixWorldAutoUpdate = false;
      cams.forEach((cam, i) => {
        if (!cam) return;
        cam.layers.set(LAMP_CAST_LAYER);
        target.viewport.set(i * size, 0, size, size);
        target.scissor.set(i * size, 0, size, size);
        target.scissorTest = true;
        r.render(scene, cam);
      });
      target.viewport.set(0, 0, size * n, size);
      target.scissor.set(0, 0, size * n, size);
      target.scissorTest = false;
      scene.matrixWorldAutoUpdate = auto;
      RendererUtils.restoreRendererAndSceneState(r, scene, state);
    },
  };
});
