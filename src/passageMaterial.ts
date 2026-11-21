import * as THREE from 'three';
import { facadeFinishes, loadFacadeFinishes } from './facadeFinishes.ts';
import type { PassageLining } from './map/passageLining.ts';

const neutral = new THREE.DataTexture(new Uint8Array([180, 173, 157, 255]), 1, 1);
neutral.colorSpace = THREE.SRGBColorSpace;
neutral.magFilter = THREE.LinearFilter;
neutral.minFilter = THREE.LinearMipmapLinearFilter;
neutral.generateMipmaps = true;
neutral.needsUpdate = true;
export const passageAtlas: { value: THREE.Texture } = { value: neutral };
// The stone surrounds stand on the street side of the opening and take the
// same sun and shadow as the façade. The lighting inside comes from its fittings.
const surround = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const lining = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, map: neutral });
lining.visible = false;
lining.customProgramCacheKey = () => 'passage-lining';
lining.onBeforeCompile = (shader) => {
  shader.uniforms.uPassageStock = {
    get value() {
      return facadeFinishes.shops ?? neutral;
    },
  };
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    '#include <common>\nattribute float finish; varying float vFinish;',
  )
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFinish = finish;');
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    '#include <common>\nuniform sampler2D uPassageStock; varying float vFinish;',
  )
    .replace(
      '#include <map_fragment>',
      `if (vFinish < 3.5) {
      vec2 at = (clamp(fract(vMapUv), .003, .997) + vec2(mod(vFinish, 2.), 1. - floor(vFinish*.5))) * .5;
      diffuseColor.rgb *= textureGrad(map, at, dFdx(vMapUv)*.5, dFdy(vMapUv)*.5).rgb;
    } else if (vFinish > 4.5) {
      float slot = vFinish - 5.;
      vec2 at = (clamp(vMapUv, .005, .995) + vec2(mod(slot,2.), 1.-floor(slot*.5)))*.5;
      diffuseColor.rgb *= texture2D(uPassageStock, at).rgb;
    }`,
    );
};
let loading = false, retry = 0;
export function passageView(street: boolean) {
  lining.visible = street;
  if (street) loadFacadeFinishes();
  if (!street || passageAtlas.value !== neutral || loading || performance.now() < retry) return;
  loading = true;
  new THREE.TextureLoader().load(
    import.meta.env.BASE_URL + 'passage-finishes.webp',
    (map) => {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      lining.map = map;
      passageAtlas.value = map;
      loading = false;
    },
    undefined,
    () => {
      loading = false;
      retry = performance.now() + 60000;
    },
  );
}
export function liningMesh(data: PassageLining) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
  g.setAttribute('finish', new THREE.BufferAttribute(data.finish, 1));
  const mesh = new THREE.Mesh(g, lining);
  if (data.portalPosition.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.portalPosition, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.portalColor, 3));
    geometry.computeVertexNormals();
    const portal = new THREE.Mesh(geometry, surround);
    portal.receiveShadow = true;
    mesh.add(portal);
  }
  mesh.name = 'Covered passage';
  return mesh;
}
