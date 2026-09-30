import type * as THREE from 'three';

// Send the GPU only the part of a buffer that's drawn, and nothing when none of it is.
// Instance buffers are sized for the most there can be (4000 of each lamp model), and
// sending each whole one every frame came to about 3 MB a frame by the Old Town Square
// (a sixth of the main thread's time on WebGPU).
export function send(attr: THREE.BufferAttribute, items: number) {
  if (items <= 0) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, Math.min(items, attr.count) * attr.itemSize);
  attr.needsUpdate = true;
}

// An instanced mesh's matrices and colours, as far as its count.
export function sendInstances(mesh: THREE.InstancedMesh) {
  send(mesh.instanceMatrix, mesh.count);
  if (mesh.instanceColor) send(mesh.instanceColor, mesh.count);
}
