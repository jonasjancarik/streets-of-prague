import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Today's Prague trams: three-section articulated cars in red and white (15T-like).
// ../transit.js keeps moving each tram along its track; here every section follows
// the track on its own, so the tram bends round corners.

const SECTION = 10.2, GAP = 0.25, W = 2.5, H = 3.4;
const STEP = SECTION + GAP;

function sectionGeometry(kind) {
  const parts = [];
  const box = (sx, sy, sz, x, y, z, color) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    parts.push(g);
  };
  box(SECTION, 1.0, W, 0, 0.85, 0, '#c4161c');
  box(SECTION, 1.2, W * 0.99, 0, 1.95, 0, '#262b30');
  box(SECTION, 0.55, W, 0, 2.82, 0, '#ecebe6');
  box(SECTION - 0.4, 0.16, W * 0.9, 0, 3.17, 0, '#d4d4cf');
  box(SECTION * 0.45, 0.35, W * 0.55, 0, 3.4, 0, '#9fa2a3');
  // Cab ends: red nose with a dark windscreen, at the outer end of the first and last section.
  if (kind !== 'mid') {
    const x = (SECTION / 2) * (kind === 'front' ? 1 : -1);
    box(0.5, 1.6, W * 0.96, x * 0.96, 2.1, 0, '#1b1f23');
    box(0.7, 0.5, W, x * 0.96, 2.95, 0, '#c4161c');
  } else {
    box(1.4, 0.9, 0.08, -1, 3.6, 0, '#2d2f31'); // pantograph
    box(0.1, 0.1, 1.6, -1, 4.05, 0, '#2d2f31');
  }
  return mergeGeometries(parts);
}

const material = new THREE.MeshLambertMaterial({ vertexColors: true });
const geoms = {};
const sectionMesh = (kind) => {
  geoms[kind] ||= sectionGeometry(kind);
  const m = new THREE.Mesh(geoms[kind], material);
  m.castShadow = true;
  return m;
};

export class Trams {
  constructor(transit, scene) {
    // Transit gives trams a 5-part group and the funicular a 2-part one.
    this.list = transit.vehicles.filter((v) => v.mesh.children.length > 3);
    for (const v of this.list) {
      scene.remove(v.mesh);
      v.sections = [sectionMesh('back'), sectionMesh('mid'), sectionMesh('front')];
      for (const m of v.sections) scene.add(m);
      v.mesh = v.sections[1];
    }
    this.sync();
  }

  // Place the outer sections along the track behind and ahead of the middle one.
  // Trams far from (x, y) keep running but aren't drawn.
  sync(x = 0, y = 0, r = Infinity, height = () => 0) {
    for (const v of this.list) {
      const mid = v.path.at(v.s);
      const show = Math.hypot(mid.x - x, mid.y - y) < r;
      for (const m of v.sections) m.visible = show;
      if (!show) continue;
      [-STEP, 0, STEP].forEach((o, i) => {
        const p = v.path.at(v.s + o);
        const m = v.sections[i];
        const fx = Math.cos(p.ang) * SECTION / 2, fy = Math.sin(p.ang) * SECTION / 2;
        const hf = height(p.x + fx, p.y + fy), hb = height(p.x - fx, p.y - fy);
        m.position.set(p.x, (hf + hb) / 2, -p.y);
        m.rotation.set(0, p.ang, Math.atan2(hf - hb, SECTION), 'YZX');
      });
    }
  }

  // Collision and look-ahead data for traffic, trams stopping, and crashes.
  bodies() {
    return this.list.map((v) => {
      const moving = v.wait > 0 ? 0 : v.dir * v.speed;
      const circles = [];
      let head = null;
      [-STEP, 0, STEP].forEach((o) => {
        const p = v.path.at(v.s + o), c = Math.cos(p.ang), s = Math.sin(p.ang);
        for (const k of [-3.8, -1.3, 1.3, 3.8]) circles.push([p.x + c * k, p.y + s * k]);
        if (o === STEP * v.dir) head = { x: p.x + c * (SECTION / 2) * v.dir, y: p.y + s * (SECTION / 2) * v.dir, dirX: c * v.dir, dirY: s * v.dir };
      });
      const mid = v.path.at(v.s), c = Math.cos(mid.ang), s = Math.sin(mid.ang);
      return { v, x: mid.x, y: mid.y, vx: c * moving, vy: s * moving, head, circles };
    });
  }
}
