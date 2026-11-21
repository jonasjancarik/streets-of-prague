import * as THREE from 'three';

type Finish = 'wall' | 'soffit';
const materials: Partial<Record<Finish, THREE.MeshBasicMaterial>> = {};
let street = false;
const retry: Record<Finish, number> = { wall: 0, soffit: 0 };

function textureFor(kind: Finish, material: THREE.MeshBasicMaterial) {
  if (material.map || performance.now() < retry[kind]) return;
  retry[kind] = Infinity;
  new THREE.TextureLoader().load(
    import.meta.env.BASE_URL + 'tunnel-' + kind + '.webp',
    (map) => {
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.RepeatWrapping;
      map.anisotropy = 4;
      material.map = map;
      material.color.setScalar(1);
      material.needsUpdate = true;
    },
    undefined,
    () => {
      retry[kind] = performance.now() + 60000;
    },
  );
}
export function tunnelFinish(kind: Finish) {
  const material = materials[kind] ??= new THREE.MeshBasicMaterial({
    color: kind === 'wall' ? '#554f46' : '#46443e',
    side: kind === 'wall' ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.visible = street;
  if (street) textureFor(kind, material);
  return material;
}
export function isTunnelFinish(material: THREE.Material) {
  return material === materials.wall || material === materials.soffit;
}
export function tunnelFinishesView(on: boolean) {
  if (on === street) return;
  street = on;
  for (const kind of ['wall', 'soffit'] as const) {
    const material = materials[kind];
    if (!material) continue;
    material.visible = on;
    if (on) textureFor(kind, material);
  }
}
