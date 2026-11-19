import fs from 'node:fs';
import * as THREE from 'three';

// The GLB avatar as a bare skeleton (its textures aren't needed, and Node can't read them).
export function glbSkeleton(p) {
  const b = fs.readFileSync(p), j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  const objs = j.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = THREE.PropertyBinding.sanitizeNodeName(n.name);
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  j.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
  const root = new THREE.Object3D();
  for (const i of j.scenes[0].nodes) root.add(objs[i]);
  const joints = j.skins[0].joints.map((i) => objs[i].name);
  root.updateMatrixWorld(true);
  return { root, joints };
}

export function writeClips(out, clips, data) {
  const header = Buffer.from(JSON.stringify({ clips }));
  const head = Buffer.alloc(4);
  // (Padded so the numbers start on an even byte.)
  const pad = Buffer.alloc(header.length % 2, 0x20);
  const floats = Buffer.concat(data.map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
  head.writeUInt32LE(header.length + pad.length);
  fs.writeFileSync(out, Buffer.concat([head, header, pad, floats]));
}
