import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BridgeWalk } from './bridgeWalk.ts';
import type { Bounds, Point2 } from './geo.ts';
import type { GroundLayer } from '../surface.ts';
import type { RawStreetEdge } from '../network.ts';

export interface MappedStair { pts: Point2[]; width: number }
// A flight of stairs as the technical map has it (pipeline/dtm_stairs.py): its treads,
// each [height of the top in m a.s.l., x0, y0, x1, y1, …] round its outline, and the
// front edges of the treads, each [height, x0, y0, …] along the edge.
export interface SurveyedStair { t: number[][]; n: number[][] }

const pairs = (flat: number[]): Point2[] => {
  const out: Point2[] = [];
  for (let i = 1; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};

function nearRing([x, y]: Point2, ring: Point2[], reach: number) {
  let inside = false, best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    if ((by > y) !== (ay > y) && x < ((ax - bx) * (y - by)) / (ay - by) + bx) inside = !inside;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return inside || best <= reach;
}

// OSM's stairs that a surveyed flight already draws, left out: the middle of the line
// on the flight or within a metre of it.
export function notSurveyed(stairs: MappedStair[], flights: SurveyedStair[] = []): MappedStair[] {
  if (!flights.length) return stairs;
  const rings = flights.flatMap((f) => f.t.map(pairs));
  return stairs.filter(({ pts }) => {
    if (pts.length < 2) return true;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let left = total / 2, mid = pts[0];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (l >= left) { const f = l ? left / l : 0; mid = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; break; }
      left -= l;
    }
    return !rings.some((r) => nearRing(mid, r, 1));
  });
}

// The surveyed flights' treads: each tread a block from the ground (or a step below its
// top) up to its surveyed height, `ref` the game's zero in m a.s.l.; the front edges as
// thin strips on top. Heights are the survey's, not moved onto the terrain.
export function surveyedStairGeometry(flights: SurveyedStair[], ref: number, height: (x: number, y: number) => number) {
  const mesh = () => ({ position: [] as number[], normal: [] as number[], index: [] as number[] });
  const body = mesh(), edges = mesh();
  // A face from points [x, height, y] (plan y), turned to face `n` ([x, up, y]).
  const face = (m: ReturnType<typeof mesh>, pts: [number, number, number][], n: [number, number, number]) => {
    const i = m.position.length / 3;
    for (const [x, h, y] of pts) { m.position.push(x, h, -y); m.normal.push(n[0], n[1], -n[2]); }
    const [a, b, c] = pts;
    const u = [b[0] - a[0], b[1] - a[1], -(b[2] - a[2])], v = [c[0] - a[0], c[1] - a[1], -(c[2] - a[2])];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const flip = cross[0] * n[0] + cross[1] * n[1] - cross[2] * n[2] < 0;
    for (let k = 1; k + 1 < pts.length; k++) m.index.push(...(flip ? [i, i + k + 1, i + k] : [i, i + k, i + k + 1]));
  };
  for (const flight of flights) {
    // The game's terrain is smoother than the survey, so a flight drawn at its surveyed
    // heights floats over the ground in places and sinks into it in others. Each tread is
    // lifted or lowered by how far the ground under its back edge is from it, averaged
    // over its neighbours so the risers stay as even as the survey has them, and never
    // left below the ground.
    const rings = flight.t.map(pairs);
    const need = flight.t.map((tread, k) => {
      let g = -Infinity;
      for (const [x, y] of rings[k]) { const h = height(x, y); if (Number.isFinite(h)) g = Math.max(g, h); }
      return Number.isFinite(g) ? g + 0.02 - (tread[0] - ref) : 0;
    });
    const lift = need.map((_, k) => {
      let sum = 0, n = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(need.length - 1, k + 2); j++) { sum += need[j]; n++; }
      return Math.max(sum / n, need[k]);
    });
    const tops = flight.t.map((tread, k) => tread[0] - ref + lift[k]);
    const liftAt = (h: number) => {
      let best = 0, d = Infinity;
      flight.t.forEach((tread, k) => { const e = Math.abs(tread[0] - ref - h); if (e < d) { d = e; best = lift[k]; } });
      return best;
    };
    for (let k = 0; k < flight.t.length; k++) {
      const ring = rings[k];
      if (ring.length < 3) continue;
      const top = tops[k];
      let area = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      const ccw = area > 0;
      const tris = THREE.ShapeUtils.triangulateShape(ring.map(([x, y]) => new THREE.Vector2(x, y)), []);
      for (const [a, b, c] of tris) face(body, [a, b, c].map((k) => [ring[k][0], top, ring[k][1]] as [number, number, number]), [0, 1, 0]);
      const bottom = ring.map(([x, y]) => { const g = height(x, y); return Math.min(Number.isFinite(g) ? g : top - 0.3, top - 0.2); });
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j], [bx, by] = ring[i], l = Math.hypot(bx - ax, by - ay);
        if (l < 1e-3) continue;
        const nx = (ccw ? by - ay : ay - by) / l, ny = (ccw ? ax - bx : bx - ax) / l;
        face(body, [[ax, top, ay], [bx, top, by], [bx, bottom[i], by], [ax, bottom[j], ay]], [nx, 0, ny]);
      }
    }
    for (const nose of flight.n) {
      const line = pairs(nose), h = nose[0] - ref + liftAt(nose[0] - ref) + 0.004;
      for (let i = 1; i < line.length; i++) {
        const [ax, ay] = line[i - 1], [bx, by] = line[i], l = Math.hypot(bx - ax, by - ay);
        if (l < 1e-3) continue;
        const ox = (-(by - ay) / l) * 0.03, oy = ((bx - ax) / l) * 0.03;
        face(edges, [[ax + ox, h, ay + oy], [bx + ox, h, by + oy], [bx - ox, h, by - oy], [ax - ox, h, ay - oy]], [0, 1, 0]);
      }
    }
  }
  const finish = ({ position, normal, index }: ReturnType<typeof mesh>) =>
    ({ position: new Float32Array(position), normal: new Float32Array(normal), index: new Uint32Array(index) });
  return { body: finish(body), edges: finish(edges) };
}

type Arrays = { position: Float32Array; normal: Float32Array; index: Uint32Array };
export function joinArrays(a: Arrays, b: Arrays): Arrays {
  const offset = a.position.length / 3, index = new Uint32Array(a.index.length + b.index.length);
  index.set(a.index);
  for (let i = 0; i < b.index.length; i++) index[a.index.length + i] = b.index[i] + offset;
  const cat = (x: Float32Array, y: Float32Array) => { const o = new Float32Array(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
  return { position: cat(a.position, b.position), normal: cat(a.normal, b.normal), index };
}

export function groundStairs(ways: RawStreetEdge[] = []): MappedStair[] {
  return ways.filter((e) => e.hw === 'steps' && !e.bridge && !e.tunnel && !e.level && !e.levels);
}

// The clear approach extends past the mapped end of each flight onto the landing.
export function stairLandings(stairs: MappedStair[]) {
  return stairs.flatMap(({ pts, width }) => {
    if (pts.length < 2 || !(width > 0)) return [];
    const radius = Math.min(1.3, width / 2);
    return [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]].flatMap(([end, next]) => {
      const dx = end[0] - next[0], dy = end[1] - next[1], length = Math.hypot(dx, dy);
      return length > 0.01 ? [{ x: end[0] + dx / length, y: end[1] + dy / length, radius }] : [];
    });
  });
}

// The walk graph has the line of a flight; its landings supply the rise. Keep the
// treads slightly above the continuous ground used for walking. Defer stairs with
// turns, tile seams, or uneven banks until there is a surveyed profile for them.
export function stairGeometry(stairs: MappedStair[], box: Bounds, height: (x: number, y: number) => number,
  blocked: (x: number, y: number) => boolean): { body: GroundLayer['geometry']; edges: GroundLayer['geometry'] } {
  const mesh = () => ({ position: [] as number[], normal: [] as number[], index: [] as number[] });
  const body = mesh(), edges = mesh();
  const quad = ({ position, normal, index }: ReturnType<typeof mesh>, vertices: [Point2, number][], nx: number, h: number, ny: number) => {
    const i = position.length / 3;
    for (const [[x, y], z] of vertices) { position.push(x, z, -y); normal.push(nx, h, -ny); }
    index.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  for (const { pts, width } of stairs) {
    if (pts.length < 2 || !(width > 0)) continue;
    let a = pts[0], b = pts[pts.length - 1];
    if (height(...a) > height(...b)) [a, b] = [b, a];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1.5 || length > 30) continue;
    const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
    if (pts.some(([x, y]) => Math.abs((y - a[1]) * ux - (x - a[0]) * uy) > 0.2)) continue;
    const half = Math.min(width / 2, 2.5);
    const point = (s: number, w: number): Point2 => [a[0] + ux * s - uy * w, a[1] + uy * s + ux * w];
    const samples = Math.ceil(length * 5);
    const sections: { s: number; left: Point2; right: Point2; lo: number; hi: number }[] = [];
    for (let i = 0; i <= samples; i++) {
      const s = i * length / samples;
      const left = point(s, half), right = point(s, -half), middle = point(s, 0);
      if ([left, right, middle].some(([x, y]) => x <= box[0] || x >= box[2] || y <= box[1] || y >= box[3] || blocked(x, y))) break;
      const heights = [height(...left), height(...middle), height(...right)];
      const lo = Math.min(...heights), hi = Math.max(...heights);
      if (!Number.isFinite(hi) || hi - lo > 0.22 || (sections.length && hi < sections[sections.length - 1].hi - 0.08)) break;
      sections.push({ s, left, right, lo, hi: Math.max(hi, sections[sections.length - 1]?.hi ?? hi) });
    }
    if (sections.length !== samples + 1) continue;
    const start = sections[0], end = sections[sections.length - 1], rise = end.hi - start.hi;
    if (rise < 0.3 || rise / length > 0.8) continue;
    const count = Math.max(2, Math.round(rise / 0.17));
    if (count > 60 || length / count < 0.2 || length / count > 0.85) continue;
    let previous = start, top = start.hi;
    for (let k = 1; k <= count; k++) {
      const target = start.hi + rise * k / count;
      const next = k === count ? end : sections.find((p) => p.s > previous.s && p.hi >= target);
      if (!next || next === previous) continue;
      const h = next.hi + 0.025;
      quad(body, [[previous.left, h], [previous.right, h], [next.right, h], [next.left, h]], 0, 1, 0);
      quad(body, [[previous.right, top], [previous.right, h], [previous.left, h], [previous.left, top]], -ux, 0, -uy);
      quad(body, [[previous.left, previous.lo], [previous.left, h], [next.left, h], [next.left, next.lo]], -uy, 0, ux);
      quad(body, [[next.right, next.lo], [next.right, h], [previous.right, h], [previous.right, previous.lo]], uy, 0, -ux);
      const edge = Math.min(previous.s + 0.055, next.s), line = h + 0.003;
      quad(edges, [[previous.left, line], [previous.right, line], [point(edge, -half), line], [point(edge, half), line]], 0, 1, 0);
      previous = next;
      top = h;
    }
  }
  const finish = ({ position, normal, index }: ReturnType<typeof mesh>) =>
    ({ position: new Float32Array(position), normal: new Float32Array(normal), index: new Uint32Array(index) });
  return { body: finish(body), edges: finish(edges) };
}


export function bridgeStairRails(fit: BridgeWalk, ref: number) {
  const parts: THREE.BufferGeometry[] = [], up = new THREE.Vector3(0,1,0);
  function tube(a: THREE.Vector3,b: THREE.Vector3,radius:number) {
    const direction=b.clone().sub(a),length=direction.length();
    if(length<.01)return;
    const tube=new THREE.CylinderGeometry(radius,radius,length,8);
    tube.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up,direction.normalize()));
    const mid=a.clone().lerp(b,.5);
    parts.push(tube.translate(mid.x,mid.y,mid.z));
  }
  for(const s of fit.segments) {
    if(!s.rail)continue;
    const length=Math.sqrt(s.d2),across=s.rail*(s.half-.14);
    const point=(t:number,rise:number)=>new THREE.Vector3(
      s.x+s.dx*t-s.dy/length*across,s.z+s.dz*t-ref+rise,-s.y-s.dy*t-s.dx/length*across);
    tube(point(0,.94),point(1,.94),.029);
    const posts=Math.max(2,Math.ceil(length/1.55));
    for(let i=0;i<=posts;i++){
      const t=(.12+(length-.24)*i/posts)/length;
      tube(point(t,-.03),point(t,.94),.022);
    }
  }
  if(!parts.length)return null;
  const geometry=mergeGeometries(parts)!;
  for(const g of parts)g.dispose();
  const mesh=new THREE.Mesh(geometry,new THREE.MeshLambertMaterial({color:'#586267'}));
  mesh.name='Stair handrails';mesh.castShadow=mesh.receiveShadow=true;
  return mesh;
}
