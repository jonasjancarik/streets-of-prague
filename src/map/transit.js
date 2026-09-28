import * as THREE from 'three';
import { rng } from './geo.js';

// The Petřín funicular's cars, shuttling up and down its track. (Trams run their
// real lines: ../trams.js.)

// OSM splits tracks into many short ways. Stitch them back into long, smooth chains
// so a car can run along them.
function chainLines(lines, maxTurnDeg = 40) {
  const key = ([x, y]) => `${Math.round(x)},${Math.round(y)}`;
  const byEnd = new Map();
  lines.forEach((pts, i) => {
    for (const k of [key(pts[0]), key(pts[pts.length - 1])]) {
      if (!byEnd.has(k)) byEnd.set(k, []);
      byEnd.get(k).push(i);
    }
  });
  const used = new Set();
  const dir = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const extend = (chain) => {
    for (;;) {
      const end = chain[chain.length - 1], prev = chain[chain.length - 2];
      const heading = dir(prev, end);
      let best = null, bestTurn = (maxTurnDeg * Math.PI) / 180;
      for (const i of byEnd.get(key(end)) || []) {
        if (used.has(i)) continue;
        let pts = lines[i];
        if (key(pts[0]) !== key(end)) pts = pts.slice().reverse();
        if (pts.length < 2) continue;
        let turn = Math.abs(dir(pts[0], pts[1]) - heading);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < bestTurn) { bestTurn = turn; best = [i, pts]; }
      }
      if (!best) return;
      used.add(best[0]);
      chain.push(...best[1].slice(1));
    }
  };
  const chains = [];
  lines.forEach((pts, i) => {
    if (used.has(i) || pts.length < 2) return;
    used.add(i);
    const chain = pts.slice();
    extend(chain);
    chain.reverse();
    extend(chain);
    chains.push(chain);
  });
  return chains;
}

class Path {
  constructor(pts) {
    this.pts = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }
  at(s) {
    s = Math.max(0, Math.min(this.length, s));
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < s) i++;
    const a = this.pts[i - 1], b = this.pts[i];
    const t = (s - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  }
}

function funicularMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 2.6), new THREE.MeshLambertMaterial({ color: '#7b2e27' }));
  body.position.y = 1.6;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.3, 2.8), new THREE.MeshLambertMaterial({ color: '#d9cfb6' }));
  roof.position.y = 3.0;
  g.add(body, roof);
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

export function buildTransit(data, scene) {
  const r = rng(5);
  const vehicles = [];
  const add = (lines, make, speed, minLen) => {
    for (const pts of chainLines(lines)) {
      const path = new Path(pts);
      if (path.length < minLen) continue;
      const n = path.length > 600 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const mesh = make();
        scene.add(mesh);
        vehicles.push({ path, mesh, s: r() * path.length, dir: r() > 0.5 ? 1 : -1, speed, wait: 0 });
      }
    }
  };
  add(data.rails.filter((x) => x.kind === 'funicular').map((x) => x.pts), funicularMesh, 3, 40);

  return {
    vehicles,
    update(dt) {
      for (const v of vehicles) {
        if (v.wait > 0) { v.wait -= dt; continue; }
        v.s += v.dir * v.speed * dt;
        if (v.s <= 0 || v.s >= v.path.length) {
          v.dir *= -1;
          v.wait = 4 + r() * 4;
        }
        const p = v.path.at(v.s);
        v.mesh.position.set(p.x, 0, -p.y);
        v.mesh.rotation.y = p.ang;
      }
    },
  };
}
