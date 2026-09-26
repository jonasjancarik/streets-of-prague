import * as THREE from 'three';
import { signedArea } from '../geo.js';
import { offsetLine } from './network.js';
import { PATTERN, patterned } from './shading.js';

// The present-day ground as real geometry: one mesh per surface kind, triangulated
// from OSM polygons, coloured by procedural shaders (shading.js). Paint, rails and
// kerb lines are thin strips on top. Layers are drawn in a fixed order with no depth
// writes, so they never z-fight however far the camera pulls back.

const COLORS = {
  pavement: '#c6c0b4', square: '#cbc4b6', path: '#d0cabe', dirt: '#bfa87e',
  park: '#86a85a', wood: '#587a40', orchard: '#95ad64', pitch: '#6c9c55',
  water: '#4d7680', asphalt: '#5c5f63', sett: '#8a847a', parking: '#666a6e',
  bridge: '#62656a', trackbed: '#8a8a85', steel: '#3a3b3d', paint: '#efede4',
  quay: '#7c776c', funicular: '#6e6a62',
};
const ZONE = { RES: '#3d7be0', MIX: '#9b59d0', VIS: '#e8962c' };

function polygons(polys) {
  const pos = [], idx = [];
  for (const rings of polys) {
    const contour = rings[0].map(([x, y]) => new THREE.Vector2(x, y));
    const holes = rings.slice(1).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const base = pos.length / 3;
    for (const v of [contour, ...holes].flat()) pos.push(v.x, 0, -v.y);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) idx.push(base + a, base + b, base + c);
  }
  return finish(pos, idx);
}

// Quads along polylines, `w` metres wide. `dash` = [on, off] in metres for dashed lines.
function strips(lines, w, dash = null) {
  const pos = [], idx = [];
  const quad = (a, b) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = ((b[1] - a[1]) / len) * w / 2, ny = (-(b[0] - a[0]) / len) * w / 2;
    const i = pos.length / 3;
    pos.push(a[0] + nx, 0, -(a[1] + ny), a[0] - nx, 0, -(a[1] - ny), b[0] - nx, 0, -(b[1] - ny), b[0] + nx, 0, -(b[1] + ny));
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const pts of lines) {
    if (!dash) {
      // Extend each segment by half the width so joints overlap instead of gapping.
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ex = ((b[0] - a[0]) / len) * w * 0.5, ey = ((b[1] - a[1]) / len) * w * 0.5;
        quad(i ? [a[0] - ex, a[1] - ey] : a, i < pts.length - 2 ? [b[0] + ex, b[1] + ey] : b);
      }
      continue;
    }
    const [on, off] = dash;
    let s = 0, drawing = true, left = on;
    for (let i = 0; i < pts.length - 1; i++) {
      let a = pts[i];
      const b = pts[i + 1];
      let seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      while (seg > 1e-6) {
        const step = Math.min(seg, left);
        const t = step / seg;
        const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (drawing) quad(a, c);
        a = c;
        seg -= step;
        left -= step;
        s += step;
        if (left <= 1e-6) { drawing = !drawing; left = drawing ? on : off; }
      }
    }
  }
  return finish(pos, idx);
}

// A soft band just outside each ring, fading from `alpha` at the ring to 0.
function skirts(ringsList, width, outside) {
  const pos = [], alpha = [], idx = [];
  for (const rings of ringsList) {
    rings.forEach((ring, k) => {
      const ccw = signedArea(ring) > 0;
      // Outer rings fade outwards, holes (courtyards) fade into the hole.
      const d = (k === 0) === ccw ? width : -width;
      const closed = [...ring, ring[0], ring[1]];
      const off = offsetLine(closed, outside ? d : -d).slice(1, -1);
      const inner = closed.slice(1, -1);
      const n = inner.length;
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos.push(inner[i][0], 0, -inner[i][1], off[i][0], 0, -off[i][1]);
        alpha.push(1, 0);
      }
      for (let i = 0; i < n; i++) {
        const a = base + i * 2, b = base + ((i + 1) % n) * 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
    });
  }
  const g = finish(pos, idx);
  g.setAttribute('alpha', new THREE.Float32BufferAttribute(alpha, 1));
  return g;
}

function finish(pos, idx) {
  // Wind every triangle to face up, so lighting never sees a back face.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const up = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (up < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

export class Surfaces {
  constructor(geo, traffic, zones) {
    this.group = new THREE.Group();
    this.time = { value: 0 };
    const d = geo.data, A = d.areas, R = d.roads;
    let order = -1000;
    const add = (geometry, color, pattern = 'flat') => {
      if (!geometry.index?.count) return null;
      const mat = patterned(new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[pattern], this.time);
      const m = new THREE.Mesh(geometry, mat);
      m.renderOrder = order++;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    const shade = (geometry, opacity, width) => {
      if (!geometry.index?.count) return;
      // Custom blending keeps it in the ordered ground pass, under buildings and cars.
      const mat = new THREE.ShaderMaterial({
        blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
        uniforms: { opacity: { value: opacity } },
        vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float opacity; varying float vA; void main() { gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
      });
      const m = new THREE.Mesh(geometry, mat);
      m.renderOrder = order++;
      m.frustumCulled = false;
      this.group.add(m);
    };

    // Base: everything unmapped between streets and houses is paved.
    const [x0, y0, x1, y1] = [geo.minX, geo.minY, geo.maxX, geo.maxY];
    add(polygons([[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]]), COLORS.pavement, 'mosaic');
    add(polygons(A.park || []), COLORS.park, 'grass');
    add(polygons(A.orchard || []), COLORS.orchard, 'grass');
    add(polygons(A.wood || []), COLORS.wood, 'wood');
    add(polygons(A.pitch || []), COLORS.pitch, 'pitch');
    add(strips((A.pitch || []).map((r) => [...r[0], r[0][0]]), 0.12), COLORS.paint);
    add(polygons(A.square || []), COLORS.square, 'slabs');
    add(polygons(A.water || []), COLORS.water, 'water');
    shade(skirts(A.water || [], 6, false), 0.35);
    add(strips((A.water || []).flatMap((r) => r.map((ring) => [...ring, ring[0]])), 0.9), COLORS.quay, 'slabs');
    add(strips(d.weirs || [], 2.4), '#9a978d', 'concrete');
    add(strips((d.weirs || []).map((w) => offsetLine(w, -1.6)), 2.2), '#dfe6e2');

    add(polygons(A.parking || []), COLORS.parking, 'asphalt');
    add(polygons(R.dirt || []), COLORS.dirt, 'dirt');
    add(polygons(R.path || []), COLORS.path, 'mosaic');
    add(polygons(R.sett || []), COLORS.sett, 'setts');
    add(polygons(R.road || []), COLORS.asphalt, 'asphalt');
    // Bay outlines in the paid zone's colour: blue residents, violet mixed, orange visitors.
    for (const [cat, color] of [...Object.entries(ZONE), [null, COLORS.paint]]) {
      const rings = (A.parking || []).filter((rs) => {
        const r = rs[0], cx = r.reduce((a, p) => a + p[0], 0) / r.length, cy = r.reduce((a, p) => a + p[1], 0) / r.length;
        return (zones?.at(cx, cy)?.category || null) === cat;
      });
      add(strips(rings.map((rs) => [...rs[0], rs[0][0]]), 0.15), color);
    }

    // Bridges: a soft shadow on the water, then the deck.
    const bridges = [...(A.bridge || []), ...(R.bridge || [])];
    const shadow = polygons(bridges);
    shadow.translate(3, 0, 3.5);
    const sh = add(shadow, '#000000');
    if (sh) { sh.material.blending = THREE.CustomBlending; sh.material.opacity = 0.28; }
    add(polygons(bridges), COLORS.bridge, 'asphalt');

    // Tram tracks: concrete bed and two rails at standard gauge.
    const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
    add(strips(trams, 2.5), COLORS.trackbed, 'concrete');
    add(strips(trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), 0.1), COLORS.steel);
    add(strips(d.rails.filter((r) => r.kind === 'funicular').map((r) => r.pts), 3), COLORS.funicular, 'concrete');

    // Road paint: dashed centre lines on two-way asphalt streets without trams, zebras.
    const cobbled = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones']);
    const near = (p) => trams.some((pts) => pts.some((q, i) => i && segDistPts(p, pts[i - 1], q) < 3));
    const centre = traffic.drive.edges.filter((e) => !e.oneway && e.u < e.v && !cobbled.has(e.surface)
      && ['primary', 'secondary', 'tertiary', 'tertiary_link'].includes(e.hw)
      && ![e.pts[0], e.pts[Math.floor(e.pts.length / 2)], e.pts[e.pts.length - 1]].some(near)).map((e) => e.pts);
    add(strips(centre, 0.13, [3, 6]), COLORS.paint);
    const bars = [];
    for (const pts of d.crossings || []) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay);
        if (len < 1) continue;
        const vx = -(by - ay) / len, vy = (bx - ax) / len;
        for (let o = -1.5; o <= 1.51; o += 1) bars.push([[ax + vx * o, ay + vy * o], [bx + vx * o, by + vy * o]]);
      }
    }
    add(strips(bars, 0.5), COLORS.paint);

    // Soft contact shadow round every building.
    shade(skirts(d.buildings.map((b) => b.rings), 1.8, true), 0.5);
  }

  update(dt) { this.time.value += dt; }
}

function segDistPts(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
