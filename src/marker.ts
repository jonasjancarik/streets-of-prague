import * as THREE from 'three';

// Where a job wants you: a pillar of light with a bobbing arrow over the spot, and, while
// the spot is out of the picture, an arrow at the edge of the screen pointing at it with
// the distance. (The taxi you ordered has a pillar of its own in taxi.ts, in yellow.)

const EDGE = 54; // px the arrow keeps from the edge of the screen

export class Marker {
  private group = new THREE.Group();
  private pillar: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private arrow: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private clock = 0;
  private at: { x: number; y: number } | null = null;
  private v = new THREE.Vector3();
  private shown = '';

  constructor(scene: THREE.Scene, private camera: THREE.Camera, private el: HTMLElement, private height: (x: number, y: number) => number, colour = '#5ee6a8') {
    const mat = () => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 40, 16, 1, true), mat());
    this.pillar.position.y = 22;
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.6, 4), mat());
    this.arrow.rotation.x = Math.PI;
    this.arrow.material.opacity = 0.95;
    this.group.add(this.pillar, this.arrow);
    this.group.visible = false;
    scene.add(this.group);
    el.hidden = true;
  }

  show(x: number, y: number) { this.at = { x, y }; }
  hide() { this.at = null; }
  get place() { return this.at; }

  // Once a frame: `from` is where you are (for the distance).
  update(dt: number, from: { x: number; y: number }) {
    const at = this.at;
    this.group.visible = !!at;
    if (!at) {
      if (this.shown) { this.shown = ''; this.el.hidden = true; }
      return;
    }
    this.clock += dt;
    const h = this.height(at.x, at.y);
    this.group.position.set(at.x, h, -at.y);
    this.arrow.position.y = 3.6 + Math.sin(this.clock * 3) * 0.3;
    this.pillar.material.opacity = 0.26 + Math.sin(this.clock * 4) * 0.06;
    // On the screen, or which way off it.
    const v = this.v.set(at.x, h + 2, -at.y).project(this.camera);
    const behind = v.z > 1;
    let sx = behind ? -v.x : v.x, sy = behind ? -v.y : v.y;
    if (!behind && Math.abs(sx) < 0.92 && Math.abs(sy) < 0.88) {
      if (this.shown) { this.shown = ''; this.el.hidden = true; }
      return;
    }
    const k = Math.max(Math.abs(sx), Math.abs(sy)) || 1;
    sx /= k;
    sy /= k;
    const w = innerWidth, hh = innerHeight;
    const left = Math.round(Math.max(EDGE, Math.min(w - EDGE, (sx * 0.5 + 0.5) * w)));
    const top = Math.round(Math.max(EDGE + 30, Math.min(hh - EDGE - 30, (-sy * 0.5 + 0.5) * hh)));
    const turn = Math.round((Math.atan2(sx * w, sy * hh) * 180) / Math.PI);
    const d = Math.hypot(at.x - from.x, at.y - from.y);
    const far = d < 1000 ? `${Math.round(d / 10) * 10} m` : `${(d / 1000).toFixed(1)} km`;
    const face = `${left}|${top}|${turn}|${far}`;
    if (face === this.shown) return;
    this.shown = face;
    this.el.hidden = false;
    this.el.style.transform = `translate(${left}px, ${top}px) translate(-50%, -50%)`;
    this.el.innerHTML = `<i style="transform:rotate(${turn}deg)">▲</i><span>${far}</span>`;
  }
}
