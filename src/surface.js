import * as THREE from 'three';
import { signedArea } from './map/geo.js';
import { offsetLine } from './network.js';
import { PATTERN, patterned } from './shading.js';

// The present-day ground as real geometry: one mesh per surface kind, triangulated
// from OSM polygons, coloured by procedural shaders (shading.js). Paint, rails and
// kerb lines are thin strips on top. Layers are drawn in a fixed order with no depth
// writes, so they never z-fight however far the camera pulls back.

const COLORS = {
  pavement: '#c6c0b4', square: '#cbc4b6', path: '#d0cabe', dirt: '#bfa87e',
  park: '#86a85a', garden: '#8dab5e', wood: '#587a40', orchard: '#95ad64', pitch: '#6c9c55',
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
function skirts(ringsList, width, outside, skip = () => false) {
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
        if (skip(inner[i], inner[(i + 1) % n])) continue;
        const a = base + i * 2, b = base + ((i + 1) % n) * 2;
        idx.push(a, a + 1, b + 1, a, b + 1, b);
      }
    });
  }
  return finish(pos, idx, alpha);
}

// Split every edge longer than `max` metres (in halves, repeatedly) so a flat mesh can
// follow the terrain. The decision is per edge, so neighbours split the same edges and
// no cracks open between them. `extra`: an optional per-vertex value to interpolate.
function subdivide(pos, idx, extra, max) {
  const max2 = max * max;
  for (let pass = 0; pass < 12; pass++) {
    const mids = new Map();
    const long = (i, j) => {
      const dx = pos[i * 3] - pos[j * 3], dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      return dx * dx + dz * dz > max2;
    };
    const mid = (i, j) => {
      const k = i < j ? `${i},${j}` : `${j},${i}`;
      let m = mids.get(k);
      if (m === undefined) {
        m = pos.length / 3;
        pos.push((pos[i * 3] + pos[j * 3]) / 2, 0, (pos[i * 3 + 2] + pos[j * 3 + 2]) / 2);
        if (extra) extra.push((extra[i] + extra[j]) / 2);
        mids.set(k, m);
      }
      return m;
    };
    const out = [];
    let split = false;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const s0 = long(a, b), s1 = long(b, c), s2 = long(c, a);
      if (!s0 && !s1 && !s2) { out.push(a, b, c); continue; }
      split = true;
      const m0 = s0 ? mid(a, b) : -1, m1 = s1 ? mid(b, c) : -1, m2 = s2 ? mid(c, a) : -1;
      if (s0 && s1 && s2) out.push(a, m0, m2, m0, b, m1, m2, m1, c, m0, m1, m2);
      else if (s0 && s1) out.push(m0, b, m1, a, m0, m1, a, m1, c);
      else if (s1 && s2) out.push(m1, c, m2, a, b, m1, a, m1, m2);
      else if (s0 && s2) out.push(a, m0, m2, m0, b, c, m0, c, m2);
      else if (s0) out.push(a, m0, c, m0, b, c);
      else if (s1) out.push(a, b, m1, a, m1, c);
      else out.push(a, b, m2, m2, b, c);
    }
    idx = out;
    if (!split) break;
  }
  return idx;
}

// Set while a Surfaces is being built: terrain height (m) at a point, or null for flat.
let groundHeight = null;

function finish(pos, idx, extra = null) {
  // Wind every triangle to face up, so lighting never sees a back face.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const up = (pos[b + 2] - pos[a + 2]) * (pos[c] - pos[a]) - (pos[b] - pos[a]) * (pos[c + 2] - pos[a + 2]);
    if (up < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  if (groundHeight) {
    idx = subdivide(pos, idx, extra, 8);
    for (let i = 0; i < pos.length; i += 3) pos[i + 1] = groundHeight(pos[i], -pos[i + 2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (extra) g.setAttribute('alpha', new THREE.Float32BufferAttribute(extra, 1));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// One set of ground meshes for an area or a tile. `edges`: car network edges for the
// centre lines (already clipped to the area); `buildings`: the ones to shade round.
export class Surfaces {
  constructor(geo, { edges = [], buildings = geo.data.buildings, zones = null, time = { value: 0 }, relief = null, height = null } = {}) {
    groundHeight = height;
    try { this.build(geo, { edges, buildings, zones, time, relief }); } finally { groundHeight = null; }
  }

  build(geo, { edges, buildings, zones, time, relief }) {
    this.group = new THREE.Group();
    this.time = time;
    const d = geo.data, A = d.areas, R = d.roads;
    // Fixed order per layer (whether or not it has anything), so tiles layer consistently.
    let order = -1000;
    const add = (geometry, color, pattern = 'flat') => {
      const o = order++;
      if (!geometry.index?.count) return null;
      const mat = patterned(new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }), PATTERN[pattern], this.time, relief);
      const m = new THREE.Mesh(geometry, mat);
      m.renderOrder = o;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    const shade = (geometry, opacity) => {
      const o = order++;
      if (!geometry.index?.count) return;
      // Custom blending keeps it in the ordered ground pass, under buildings and cars.
      const mat = new THREE.ShaderMaterial({
        blending: THREE.CustomBlending, depthWrite: false, depthTest: false,
        uniforms: { opacity: { value: opacity } },
        vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float opacity; varying float vA; void main() { gl_FragColor = vec4(0.08, 0.07, 0.06, vA * vA * opacity); }',
      });
      const m = new THREE.Mesh(geometry, mat);
      m.renderOrder = o;
      this.group.add(m);
    };

    // Base: everything unmapped between streets and houses is paved; gardens round
    // family houses come from the pipeline (osm_area.py, _gardens).
    const [x0, y0, x1, y1] = [geo.minX, geo.minY, geo.maxX, geo.maxY];
    // Polygons are clipped to the tile: their edges along the tile border aren't real
    // shores or kerbs, so outlines and shading skip them.
    const cut = (a, b) => [[0, x0], [0, x1], [1, y0], [1, y1]].some(([k, v]) => Math.abs(a[k] - v) < 0.05 && Math.abs(b[k] - v) < 0.05);
    const outlines = (polys) => {
      const out = [];
      for (const rings of polys) {
        for (const ring of rings) {
          let cur = [];
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            if (cut(a, b)) { if (cur.length > 1) out.push(cur); cur = []; continue; }
            if (!cur.length) cur.push(a);
            cur.push(b);
          }
          if (cur.length > 1) out.push(cur);
        }
      }
      return out;
    };
    add(polygons([[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]]), COLORS.pavement, 'mosaic');
    add(polygons(A.garden || []), COLORS.garden, 'grass');
    add(polygons(A.park || []), COLORS.park, 'grass');
    add(polygons(A.orchard || []), COLORS.orchard, 'grass');
    add(polygons(A.wood || []), COLORS.wood, 'wood');
    add(polygons(A.pitch || []), COLORS.pitch, 'pitch');
    add(strips(outlines((A.pitch || []).map((r) => [r[0]])), 0.12), COLORS.paint);
    add(polygons(A.square || []), COLORS.square, 'slabs');
    add(polygons(A.water || []), COLORS.water, 'water');
    shade(skirts(A.water || [], 6, false, cut), 0.35);
    add(strips(outlines(A.water || []), 0.9), COLORS.quay, 'slabs');
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
      add(strips(outlines(rings.map((rs) => [rs[0]])), 0.15), color);
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

    // Road paint from OSM lanes: dashed lane dividers, a centre line (double solid on
    // roads of four lanes or more) and edge lines on the main roads. Cobbled streets
    // and the middle of tram streets stay unpainted.
    const cobbled = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones']);
    const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
    const EDGE_LINES = new Set(['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link']);
    const near = (p) => trams.some((pts) => pts.some((q, i) => i && segDistPts(p, pts[i - 1], q) < 3));
    const dashed = [], solid = [];
    for (const e of edges) {
      const n = e.lanes || 0;
      if (cobbled.has(e.surface) || (!MAJOR.has(e.hw) && n < 2)) continue;
      if (!e.oneway && e.u > e.v) continue; // a two-way street has an edge each way: paint it once
      const W = e.width, pts = e.pts;
      if (e.oneway) {
        const lanes = Math.max(1, n || 1), lw = W / lanes;
        for (let k = 1; k < lanes; k++) dashed.push(offsetLine(pts, -W / 2 + k * lw));
        if (EDGE_LINES.has(e.hw) || lanes > 1) solid.push(offsetLine(pts, W / 2 - 0.4), offsetLine(pts, -W / 2 + 0.4));
        continue;
      }
      const per = Math.max(1, Math.floor(Math.max(2, n || 2) / 2)), lw = W / (2 * per);
      if (![pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].some(near)) {
        if (per >= 2) solid.push(offsetLine(pts, 0.15), offsetLine(pts, -0.15));
        else dashed.push(pts);
      }
      for (let k = 1; k < per; k++) dashed.push(offsetLine(pts, k * lw), offsetLine(pts, -k * lw));
      if (EDGE_LINES.has(e.hw)) solid.push(offsetLine(pts, W / 2 - 0.4), offsetLine(pts, -W / 2 + 0.4));
    }
    add(strips(dashed, 0.13, [3, 6]), COLORS.paint);
    add(strips(solid, 0.13), COLORS.paint);
    // Zebra crossings: bars along the road, one every metre across it.
    const bars = [];
    for (const pts of d.crossings || []) {
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay);
        if (len < 1) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len, vx = -uy, vy = ux;
        for (let t = 0.5; t < len - 0.25; t += 1) {
          const px = ax + ux * t, py = ay + uy * t;
          bars.push([[px - vx * 1.5, py - vy * 1.5], [px + vx * 1.5, py + vy * 1.5]]);
        }
      }
    }
    add(strips(bars, 0.5), COLORS.paint);

    // Soft contact shadow round every building.
    shade(skirts(buildings.map((b) => b.rings), 1.8, true), 0.5);
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  }
}

function segDistPts(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
