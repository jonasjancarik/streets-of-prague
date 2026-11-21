import * as THREE from 'three';

// Heights under street-level rain and snow. Sample the actual roofs, decks and
// ground in strips, then publish a complete square. While walking, the old square
// still covers the view. A teleport drops it immediately.
const CELLS = 36, STEP = 2, SPAN = CELLS * STEP, SNAP = 8;
export class PrecipitationCover {
  readonly box = { value: new THREE.Vector4(0, 0, SPAN, 0) }; // x/z of first corner, span, ready
  private pixels = new Uint8Array(CELLS * CELLS * 4);
  private next = new Uint8Array(this.pixels.length);
  readonly texture = new THREE.DataTexture(this.pixels, CELLS, CELLS);
  private x = 0; private z = 0;
  private revision = -1;
  private row = CELLS;
  constructor() {
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  sheltered(x: number, z: number, head: number) {
    const box = this.box.value;
    if (!box.w) return false;
    const i = Math.floor((x - box.x) / STEP), j = Math.floor((z - box.y) / STEP);
    if (i < 0 || i >= CELLS || j < 0 || j >= CELLS) return false;
    const k = (j * CELLS + i) * 4;
    const top = (this.pixels[k] * 256 + this.pixels[k + 1]) / 16 - 1024;
    return top > head + .25;
  }

  update(x: number, z: number, revision: number, topAt: (x: number, z: number) => number) {
    const ox = Math.floor(x / SNAP) * SNAP - SPAN / 2, oz = Math.floor(z / SNAP) * SNAP - SPAN / 2;
    const old = this.box.value;
    if (Math.abs(ox - old.x) >= SPAN / 2 || Math.abs(oz - old.y) >= SPAN / 2) old.w = 0;
    if (this.row === CELLS || Math.abs(ox - this.x) >= SPAN / 2 || Math.abs(oz - this.z) >= SPAN / 2) {
      if (this.x === ox && this.z === oz && this.revision === revision && old.w) return;
      this.x = ox; this.z = oz; this.revision = revision; this.row = 0;
    }
    const end = Math.min(this.row + 4, CELLS);
    for (; this.row < end; this.row++) {
      const pz = this.z + (this.row + .5) * STEP;
      for (let col = 0; col < CELLS; col++) {
        const h = topAt(this.x + (col + .5) * STEP, pz);
        const bits = Math.max(0, Math.min(65535, Math.round((h + 1024) * 16)));
        const i = (this.row * CELLS + col) * 4;
        this.next[i] = bits >> 8; this.next[i + 1] = bits & 255;
      }
    }
    if (this.row === CELLS) {
      this.pixels.set(this.next); this.texture.needsUpdate = true;
      old.set(this.x, this.z, SPAN, 1);
    }
  }
}
