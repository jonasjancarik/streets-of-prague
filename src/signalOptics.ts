import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Stroke = [number, number, number, number, number];
const standing: Stroke[] = [[0, .43, 0, .43, .135], [0, .22, 0, -.12, .126], [-.10, .21, -.22, -.09, .048], [.10, .21, .22, -.09, .048], [-.058, -.08, -.071, -.49, .058], [.058, -.08, .071, -.49, .058]];
const walking: Stroke[] = [[.091, .40, .091, .40, .126], [.025, .20, -.070, -.09, .11], [-.02, .15, -.22, .02, .048], [-.22, .02, -.30, -.10, .043], [.07, .15, .17, .016, .047], [.17, .016, .31, .035, .042], [-.065, -.09, -.23, -.42, .056], [-.05, -.09, .08, -.25, .057], [.08, -.25, .22, -.46, .052]];
const size = 128;
function lensAtlas(people: boolean) {
  const cols = people ? 2 : 1, data = new Uint8Array(cols * size * size * 4);
  for (let y = 0; y < size; y++)for (let x = 0; x < cols * size; x++) {
    const u = 2 * ((x % size + .5) / size) - 1, v = 2 * ((y + .5) / size) - 1;
    const edge = Math.hypot(u, v), cell = Math.hypot(((x + .5) % 5) - 2.5, ((y + .5) % 5) - 2.5);
    let light = 1;
    if (people) {
      light = 0;
      for (const [a, b, c, d, r] of (x < size ? standing : walking)) {
        const dx = c - a, dy = d - b, k = Math.max(0, Math.min(1, ((u - a) * dx + (v - b) * dy) / (dx * dx + dy * dy || 1)));
        light = Math.max(light, 1 - THREE.MathUtils.smoothstep(Math.hypot(u - a - k * dx, v - b - k * dy), r - .014, r + .014));
      }
    }
    const diode = .38 + .62 * (1 - THREE.MathUtils.smoothstep(cell, 1.05, 2.65));
    const level = .024 + .97 * light * diode * (1 - THREE.MathUtils.smoothstep(edge, .82, 1) * .60);
    const i = (y * cols * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(level * 255); data[i + 3] = 255;
  }
  const map = new THREE.DataTexture(data, cols * size, size, THREE.RGBAFormat);
  map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter; map.generateMipmaps = true; map.needsUpdate = true; return map;
}
let walkMap: THREE.DataTexture | undefined;
export const pedestrianLens = () => walkMap ??= lensAtlas(true);

function head(walk: boolean) {
  const at = walk ? [2.44, 2.16] : [2.85, 2.55, 2.25], radius = walk ? .120 : .135, back = walk ? .205 : .246;
  const box = (w: number, h: number, d: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(0, y, z);
  const parts: THREE.BufferGeometry[] = [box(walk ? .299 : .343, walk ? .602 : .929, back, walk ? 2.30 : 2.55, back / 2),
  box(walk ? .37 : .50, walk ? .70 : 1.035, .037, walk ? 2.3 : 2.55, -.020)];
  for (const y of at) {
    parts.push(new THREE.TorusGeometry(radius - .010, .011, 5, 20).translate(0, y, back + .009));
    // Open underneath; the cut back at either cheek keeps the lens visible across a lane.
    const pos: number[] = [], idx: number[] = [], uv: number[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = -.25 + (Math.PI + .50) * i / 12, c = Math.cos(a), s = Math.sin(a);
      const reach = (walk ? .082 : .124) + (walk ? .057 : .085) * Math.max(0, s);
      for (const [r, z] of [[radius - .006, back], [radius - .006, back + reach], [radius + .002, back + reach], [radius + .002, back]]) {
        pos.push(c * r, y + s * r, z); uv.push(0, 0);
      }
      if (i) for (let j = 0; j < 3; j++) {
        const k = i * 4 + j;
        idx.push(k - 4, k - 3, k, k, k - 3, k + 1);
      }
    }
    const visor = new THREE.BufferGeometry();
    visor.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); visor.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    visor.setIndex(idx); visor.computeVertexNormals(); parts.push(visor);
  }
  return mergeGeometries(parts)!;
}
export function signalOptics() {
  const pedestrians = new THREE.MeshBasicMaterial({ map: pedestrianLens() });
  pedestrians.customProgramCacheKey = () => 'pedestrian-lenses';
  pedestrians.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv.x = (vMapUv.x + float(gl_InstanceID % 2)) * .5;'); };
  return {
    head: head(false), walk: head(true),
    lens: new THREE.CircleGeometry(.106, 24).translate(0, 0, .260),
    pedestrian: new THREE.CircleGeometry(.102, 24).translate(0, 0, .219),
    lit: new THREE.MeshBasicMaterial({ map: lensAtlas(false) }), pedestrians
  };
}
