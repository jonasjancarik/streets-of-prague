// Christmas lights across the old town's shopping streets, from Advent to Epiphany
// (Season.festive, shared as SEASON.w): garlands of warm bulbs strung from house front to
// house front every SPACING metres, sagging a little, as the city hangs them on Na Příkopě,
// Václavské náměstí, Pařížská, Karlova and the rest of FESTIVE. Built with each tile from
// its named streets and buildings; shown or hidden every frame (showChristmasLights).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Point2 } from './map/geo.ts';

export const FESTIVE = new Set(['Na Příkopě', 'Václavské náměstí', '28. října', 'Národní', 'Na Můstku', 'Pařížská', 'Karlova', 'Celetná',
  'Železná', 'Melantrichova', 'Rytířská', 'Havelská', 'Jilská', 'Michalská', 'Dlouhá', 'Nerudova', 'Mostecká', 'Vodičkova',
  'Jindřišská', 'Na Poříčí', 'Jungmannova', 'Spálená', 'Na Perštýně', 'Kaprova', 'Malé náměstí']);
const SPACING = 14, REACH = 16, HEIGHT = 6.2, SAG = .7, BULB_GAP = .45, MIN = 5, MAX = 30;
const DAY = new THREE.Color('#d8cbb4'), NIGHT = new THREE.Color('#ffd28a').multiplyScalar(2.4);
// The garlands of the tiles loaded now. Each tile has its own materials: the tile's fixtures
// are disposed with it (tiles.ts).
const shown = new Set<THREE.Mesh>();
const bulbsLit = new Set<THREE.MeshBasicMaterial>();

// Where the ray from (px, py) along (dx, dy) first meets a wall, within REACH.
function cast(walls: number[], px: number, py: number, dx: number, dy: number) {
  let best = Infinity;
  for (let i = 0; i < walls.length; i += 4) {
    const ax = walls[i], ay = walls[i + 1], ex = walls[i + 2] - ax, ey = walls[i + 3] - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const qx = ax - px, qy = ay - py, t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
    if (t > .5 && t < REACH && t < best && u >= 0 && u <= 1) best = t;
  }
  return best;
}

// `streets`: the tile's street edges (name, points); `buildings`: building outer rings;
// `ground`: the ground's height; `own`: whether a point belongs to this tile.
export function christmasLights(streets: { name?: string | null; pts: Point2[] }[], buildings: Point2[][], ground: (x: number, y: number) => number,
  own: (x: number, y: number) => boolean) {
  const lines = streets.filter(s => s.name && FESTIVE.has(s.name));
  if (!lines.length) return [];
  const walls: number[] = [];
  for (const ring of buildings) for (let i = 0; i < ring.length - 1; i++) walls.push(ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
  const bulbs: THREE.BufferGeometry[] = [], wires: number[] = [];
  const done: Point2[] = [];
  for (const { pts } of lines) {
    let next = SPACING / 2, along = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const dx = (bx - ax) / len, dy = (by - ay) / len, nx = -dy, ny = dx;
      for (; next <= along + len; next += SPACING) {
        const f = next - along, px = ax + dx * f, py = ay + dy * f;
        if (!own(px, py) || done.some(([qx, qy]) => Math.hypot(qx - px, qy - py) < SPACING * .6)) continue;
        const a = cast(walls, px, py, nx, ny), b = cast(walls, px, py, -nx, -ny);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a + b < MIN || a + b > MAX) continue;
        done.push([px, py]);
        const x0 = px + nx * (a - .05), y0 = py + ny * (a - .05), x1 = px - nx * (b - .05), y1 = py - ny * (b - .05);
        const h0 = ground(x0, y0) + HEIGHT, h1 = ground(x1, y1) + HEIGHT;
        const at = (u: number): [number, number, number] => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, h0 + (h1 - h0) * u - SAG * 4 * u * (1 - u)];
        const n = Math.max(2, Math.round((a + b) / BULB_GAP));
        for (let k = 0; k <= n; k++) {
          const [x, y, z] = at(k / n);
          if (k < n) {
            const [x2, y2, z2] = at((k + 1) / n), l = Math.hypot(x2 - x, y2 - y) || 1, ox = -(y2 - y) / l * .012, oy = (x2 - x) / l * .012;
            wires.push(x + ox, z, -(y + oy), x - ox, z, -(y - oy), x2 + ox, z2, -(y2 + oy), x2 + ox, z2, -(y2 + oy), x - ox, z, -(y - oy), x2 - ox, z2, -(y2 - oy));
          }
          // A bulb hangs a hand's breadth under the wire.
          if (k > 0 && k < n) bulbs.push(new THREE.OctahedronGeometry(.045).translate(x, z - .09, -y));
        }
      }
      along += len;
    }
  }
  if (!bulbs.length) return [];
  const lit = new THREE.Mesh(mergeGeometries(bulbs.map(g => g.toNonIndexed())), new THREE.MeshBasicMaterial({ color: DAY }));
  bulbs.forEach(g => g.dispose());
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  const wire = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: '#1e1e1c', side: THREE.DoubleSide }));
  bulbsLit.add(lit.material);
  const meshes = [lit, wire];
  for (const m of meshes) {
    m.name = 'Christmas lights'; m.visible = false;
    // (A tile taken down and drawn again takes its garlands out and puts them back.)
    m.addEventListener('removed', () => { shown.delete(m); bulbsLit.delete(lit.material); });
    m.addEventListener('added', () => { shown.add(m); bulbsLit.add(lit.material); });
    shown.add(m);
  }
  return meshes;
}

// Every frame: up in the festive season, warm and bright after dark (`night`: 0 by day, 1 at night).
export function showChristmasLights(festive: boolean, night: number) {
  for (const m of bulbsLit) m.color.copy(DAY).lerp(NIGHT, Math.min(1, night * 3));
  for (const g of shown) g.visible = festive;
}

// For tests (scene.mjs, importing this module in the page): how many garland meshes the
// loaded tiles have, and how many are showing.
export const garlandsLoaded = () => ({ meshes: shown.size, showing: [...shown].filter(m => m.visible).length,
  at: [...shown].filter(m => m.material !== undefined).map(m => { m.geometry.computeBoundingSphere(); const c = m.geometry.boundingSphere!.center; return [c.x, -c.z]; }) });
