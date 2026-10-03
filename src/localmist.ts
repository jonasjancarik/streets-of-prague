import * as THREE from 'three';

export type MistMode = 'sheets' | 'volume';
export const MIST_MODE = { value: 'sheets' as MistMode };
export const LOCAL_MIST = {
  density: 0.28, width: 40, length: 28, spacing: 64,
  low: 0.15, high: 2.2, edge: 0.25, noiseSize: 8, speed: 0.35, steps: 12,
  river: 1,
};
export const LOCAL_MIST_DEFAULT = { ...LOCAL_MIST };
export type LocalMistSettings = typeof LOCAL_MIST;
export interface LocalMistParts {
  geometry: THREE.BufferGeometry;
  time: { value: number }; amount: { value: number }; fog: { value: THREE.Color };
  shape: { value: THREE.Vector4 }; // density, edge fade, noise scale, drift speed
  steps: { value: number };
}
let materialBy: ((parts: LocalMistParts) => THREE.Material) | null = null;
export const setLocalMist = (factory: typeof materialBy) => { materialBy = factory; };
export const supportsLocalMist = () => materialBy !== null;

// Separate, world-anchored banks, batched into one draw. Reuse all buffers when the
// view moves; only their placement is refreshed, never the shader or the mesh.
const RINGS = 6, CAPACITY = (RINGS * 2 + 1) ** 2;
const NO_WATER = () => null;
const seed = (x: number, z: number) => {
  let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

export class LocalMistVolume {
  readonly mesh: THREE.Mesh | null;
  private geometry = new THREE.BufferGeometry();
  private positions = new THREE.Float32BufferAttribute(new Float32Array(CAPACITY * 24 * 3), 3);
  private centres = new THREE.Float32BufferAttribute(new Float32Array(CAPACITY * 24 * 3), 3);
  private sizes = new THREE.Float32BufferAttribute(new Float32Array(CAPACITY * 24 * 3), 3);
  private slopes = new THREE.Float32BufferAttribute(new Float32Array(CAPACITY * 24 * 3), 3);
  private water = new THREE.Float32BufferAttribute(new Float32Array(CAPACITY * 24), 1);
  private corners: THREE.BufferAttribute;
  private shape = { value: new THREE.Vector4() };
  private steps = { value: 12 };
  private amount = { value: 0 };
  private cellX = NaN;
  private cellZ = NaN;
  private rings = -1;
  private nextGround = 0;
  private previous = { width: NaN, length: NaN, spacing: NaN, low: NaN, high: NaN, river: NaN };

  constructor(scene: THREE.Scene, time: { value: number }, fog: { value: THREE.Color }) {
    const box = new THREE.BoxGeometry(2, 2, 2);
    this.corners = box.getAttribute('position') as THREE.BufferAttribute;
    const indices = new Uint16Array(CAPACITY * 36);
    for (let k = 0; k < CAPACITY; k++) for (let i = 0; i < 36; i++) indices[k * 36 + i] = box.index!.getX(i) + k * 24;
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setAttribute('position', this.positions);
    this.geometry.setAttribute('mistCentre', this.centres);
    this.geometry.setAttribute('mistHalfSize', this.sizes);
    this.geometry.setAttribute('mistSlope', this.slopes);
    this.geometry.setAttribute('mistWater', this.water);
    this.geometry.setDrawRange(0, 0);
    const material = materialBy?.({ geometry: this.geometry, time, amount: this.amount, fog, shape: this.shape, steps: this.steps });
    this.mesh = material ? new THREE.Mesh(this.geometry, material) : null;
    if (this.mesh) {
      this.mesh.name = 'Local mist volumes';
      this.mesh.frustumCulled = false;
      this.mesh.visible = false;
      this.mesh.renderOrder = 9;
      this.mesh.onBeforeRender = (renderer) => { material?.userData.prepare?.(renderer); };
      scene.add(this.mesh);
    }
    box.dispose();
  }

  // `waterAt`: water-surface height, or null on land and outside loaded tiles.
  update(amount: number, time: number, x: number, z: number, radius: number, groundAt: (x: number, z: number) => number,
    waterAt: (x: number, z: number) => number | null = NO_WATER) {
    if (!this.mesh) return;
    this.mesh.visible = MIST_MODE.value === 'volume' && amount > 0.01;
    if (!this.mesh.visible) return;
    const m = LOCAL_MIST;
    this.amount.value = Math.min(1, amount);
    this.shape.value.set(Math.max(0, m.density), Math.max(0.02, m.edge), 1 / Math.max(1, m.noiseSize), m.speed);
    this.steps.value = Math.max(8, Math.min(16, Math.round(m.steps)));
    const spacing = Math.max(24, m.spacing), cellX = Math.round(x / spacing), cellZ = Math.round(z / spacing);
    const rings = Math.min(RINGS, Math.max(1, Math.ceil(radius / spacing) + 1));
    if (cellX === this.cellX && cellZ === this.cellZ && rings === this.rings && time < this.nextGround
      && this.previous.width === m.width && this.previous.length === m.length && this.previous.spacing === m.spacing
      && this.previous.low === m.low && this.previous.high === m.high && this.previous.river === m.river) return;
    this.cellX = cellX; this.cellZ = cellZ; this.rings = rings; this.nextGround = time + 2;
    for (const key of Object.keys(this.previous) as (keyof typeof this.previous)[]) this.previous[key] = m[key];
    let count = 0;
    for (let dz = -rings; dz <= rings; dz++) for (let dx = -rings; dx <= rings; dx++) {
      const gx = cellX + dx, gz = cellZ + dz, s = seed(gx, gz);
      const cx = gx * spacing + (s - 0.5) * spacing * 0.12;
      const cz = gz * spacing + (seed(gz, gx + 13) - 0.5) * spacing * 0.12;
      const river = THREE.MathUtils.clamp(m.river, 0, 1);
      const level = river > 0 ? waterAt(cx, cz) : null;
      let wet = level !== null ? river : 0;
      if (river > 0 && level === null) {
        // Broader, gentler mist on nearby banks too. Query only when placement
        // refreshes, using real water polygons rather than a guessed river line.
        const reach = spacing * 0.4;
        wet = river * 0.15 * (Number(waterAt(cx - reach, cz) !== null) + Number(waterAt(cx + reach, cz) !== null)
          + Number(waterAt(cx, cz - reach) !== null) + Number(waterAt(cx, cz + reach) !== null));
      }
      // Dry streets retain separate banks. Over water their soft edges overlap,
      // covering most of the river instead of leaving large checkerboard gaps.
      const hx = THREE.MathUtils.lerp(Math.min(spacing * 0.4, Math.max(2, m.width * (0.45 + s * 0.1))), spacing * 0.56, wet);
      const hz = THREE.MathUtils.lerp(Math.min(spacing * 0.4, Math.max(2, m.length * (0.55 - s * 0.1))), spacing * 0.56, wet);
      const hy = Math.max(0.1, m.high - m.low) * 0.5;
      // River mist starts at the water surface, even beside a tall quay. Don't
      // tilt it up the bank or onto a bridge whose deck is several metres higher.
      const g = level ?? groundAt(cx, cz);
      const sx = level !== null ? 0 : THREE.MathUtils.clamp((groundAt(cx + hx, cz) - groundAt(cx - hx, cz)) / (2 * hx), -0.5, 0.5);
      const sz = level !== null ? 0 : THREE.MathUtils.clamp((groundAt(cx, cz + hz) - groundAt(cx, cz - hz)) / (2 * hz), -0.5, 0.5);
      const cy = g + m.low + hy, boxHeight = hy + Math.abs(sx) * hx + Math.abs(sz) * hz;
      for (let v = 0; v < 24; v++) {
        const i = count * 24 + v;
        this.positions.setXYZ(i, cx + this.corners.getX(v) * hx, cy + this.corners.getY(v) * boxHeight, cz + this.corners.getZ(v) * hz);
        this.centres.setXYZ(i, cx, cy, cz);
        this.sizes.setXYZ(i, hx, boxHeight, hz);
        this.slopes.setXYZ(i, sx, sz, hy);
        this.water.setX(i, wet);
      }
      count++;
    }
    for (const attribute of [this.positions, this.centres, this.sizes, this.slopes, this.water]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, count * 24 * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, count * 36);
  }
}
