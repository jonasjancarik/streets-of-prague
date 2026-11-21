// Join the mapped walkable strips before building their lining. Junctions stay
// open and the corridor ends where the building gives way to pavement or a yard.
import * as THREE from 'three';
import { difference, intersection, union } from 'polyclip-ts';
import { onPolygons } from './geo.ts';
import { PASSAGE_HEAD, passageOutline, passageSections, walkingPassage } from './passageOpenings.ts';
import type { TilePassage } from '../contracts.ts';
import type { Bounds, Point2, Polygons } from './geo.ts';

export interface PassageLining {
  position: Float32Array;
  color: Float32Array;
  uv: Float32Array;
  finish: Float32Array;
  portalPosition: Float32Array;
  portalColor: Float32Array;
}
type V = [number, number, number]; // map x, map y, height above the ground
const wall = new THREE.Color('#f6dcb7'), floor = new THREE.Color('#d3c2a5'), ceiling = new THREE.Color('#d6c9b5');
const brass = new THREE.Color('#695741'), jamb = new THREE.Color('#a99b85'), bulb = new THREE.Color().setRGB(1.8, 1.45, .94);
export function passageLining(
  paths: TilePassage[],
  houses: { rings: Point2[][] }[],
  box: Bounds,
  height: (x: number, y: number) => number,
  landmarks: Polygons = [],
): PassageLining | null {
  const spans = passageSections(paths, height);
  if (!spans.length || !houses.length) return null;
  const nearby = houses.filter(({ rings }) => {
    const rim = rings[0];
    if (!rim?.length) return false;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of rim) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    return spans.some((s) => x0 < s.maxX && x1 > s.minX && y0 < s.maxY && y1 > s.minY);
  });
  if (!nearby.length) return null;
  const ribbon = union(paths.filter(walkingPassage).map(passageOutline).filter((r) => r.length)) as Polygons;
  const [x0, y0, x1, y1] = box;
  let rooms = intersection(ribbon, nearby.map((b) => b.rings), [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]) as Polygons;
  if (rooms.length && landmarks.length) rooms = difference(rooms, landmarks) as Polygons;
  if (!rooms.length) return null;
  const inRoom = onPolygons(rooms), inRibbon = onPolygons(ribbon);
  const pos: number[] = [], colors: number[] = [], uv: number[] = [], finish: number[] = [];
  const portalPosition: number[] = [], portalColor: number[] = [];
  const lights: { x: number; y: number; dx: number; dy: number; half: number }[] = [];
  for (const s of spans) {
    // Original segment coordinates, so the rhythm continues across the short
    // terrain sampling spans. Keep fixtures away from the edge of an open yard.
    const phase = s.ax * s.dx + s.ay * s.dy;
    const along = Math.ceil((phase + .001) / 6) * 6 - phase;
    if (along > s.length) continue;
    const x = s.ax + s.dx * along, y = s.ay + s.dy * along;
    if (inRoom(x, y) && !lights.some((p) => Math.hypot(p.x - x, p.y - y) < 3)) {
      lights.push({ x, y, dx: s.dx, dy: s.dy, half: s.half });
    }
  }
  const litAt = (x: number, y: number) => {
    let d = 25;
    for (const p of lights) d = Math.min(d, (p.x - x) ** 2 + (p.y - y) ** 2);
    return .25 + .64 * Math.exp(-d / 5.5);
  };
  function vertex(v: V, tex: Point2, tile: number, tint: THREE.Color, shade = 1) {
    const y = height(v[0], v[1]) + v[2];
    if (tile === 9) {
      portalPosition.push(v[0], y, -v[1]);
      portalColor.push(tint.r * shade, tint.g * shade, tint.b * shade);
      return;
    }
    pos.push(v[0], y, -v[1]);
    const light = shade * (tile < 4 ? litAt(v[0], v[1]) : 1);
    colors.push(tint.r * light, tint.g * light, tint.b * light);
    uv.push(...tex);
    finish.push(tile);
  }
  function quad(a: V, b: V, c: V, d: V, tile: number, tint: THREE.Color, u0 = 0, u1 = 1, shade = 1, v0 = 0, v1 = 1) {
    for (
      const [v, u, w] of [[a, u0, 0], [b, u1, 0], [c, u1, 1], [a, u0, 0], [c, u1, 1], [d, u0, 1]] as [V, number, number][]
    ) {
      vertex(v, [u, v0 + w * (v1 - v0)], tile, tint, shade);
    }
  }
  for (const shape of rooms) {
    const rings = shape.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const vecs = rings.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const face = rings.flat(), tris = THREE.ShapeUtils.triangulateShape(vecs[0], vecs.slice(1));
    function horizontal(a: Point2, b: Point2, c: Point2) {
      const ab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2,
        bc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2,
        ca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
      if (Math.max(ab, bc, ca) > 16) {
        if (bc > ab && bc >= ca) return horizontal(b, c, a);
        if (ca > ab && ca > bc) return horizontal(c, a, b);
        const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        horizontal(a, mid, c);
        horizontal(mid, b, c);
        return;
      }
      for (const [h, tile, tint] of [[.045, 2, floor], [PASSAGE_HEAD, 3, ceiling]] as const) {
        for (const [x, y] of [a, b, c]) vertex([x, y, h], [x / 2, y / 2], tile, tint);
      }
    }
    for (const [a, b, c] of tris) horizontal(face[a], face[b], face[c]);
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < .03) continue;
        const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
        // The ribbon continues on both sides of a portal; it stops on one side
        // of a wall. Never close the route at an artificial tile edge.
        if (Math.min(Math.abs(mx - x0), Math.abs(mx - x1), Math.abs(my - y0), Math.abs(my - y1)) < .025) continue;
        const left = inRibbon(mx - dy * .06, my + dx * .06), right = inRibbon(mx + dy * .06, my - dx * .06);
        if (left && right && len > 1.2 && len < 7) {
          // A short cross-section of the walkable ribbon meets the building
          // frontage. Give the opening actual stone jambs, a soffit and a sill.
          const inward = inRoom(mx - dy * .05, my + dx * .05) ? 1 : -1;
          const at = (
            along: number,
            depth: number,
            h: number,
          ): V => [a[0] + dx * along - dy * depth * inward, a[1] + dy * along + dx * depth * inward, h];
          const front = -.22, back = .42;
          for (const end of [0, len]) {
            const inside = end === 0 ? .045 : len - .045, outside = end === 0 ? -.13 : len + .13;
            quad(
              at(inside, front, -.02),
              at(inside, back, -.02),
              at(inside, back, PASSAGE_HEAD),
              at(inside, front, PASSAGE_HEAD),
              9,
              jamb,
              0,
              1,
              .63,
            );
            quad(
              at(outside, front, -.02),
              at(inside, front, -.02),
              at(inside, front, PASSAGE_HEAD + .1),
              at(outside, front, PASSAGE_HEAD + .1),
              9,
              jamb,
            );
          }
          quad(
            at(-.13, front, PASSAGE_HEAD - .045),
            at(len + .13, front, PASSAGE_HEAD - .045),
            at(len + .13, front, PASSAGE_HEAD + .13),
            at(-.13, front, PASSAGE_HEAD + .13),
            9,
            jamb,
          );
          quad(
            at(0, front, PASSAGE_HEAD - .045),
            at(len, front, PASSAGE_HEAD - .045),
            at(len, back, PASSAGE_HEAD - .045),
            at(0, back, PASSAGE_HEAD - .045),
            9,
            jamb,
            0,
            1,
            .58,
          );
          quad(at(0, front, .05), at(len, front, .05), at(len, .12, .05), at(0, .12, .05), 9, jamb, 0, 1, .78);
        }
        if (left === right) continue;
        const side = left ? 1 : -1;
        const at = (
          s: number,
          h: number,
          inset = 0,
        ): V => [a[0] + dx * s - dy * inset * side, a[1] + dy * s + dx * inset * side, h];
        const panels = Math.max(1, Math.round(len / 3.0));
        for (let j = 0; j < panels; j++) {
          const lo = len * j / panels, hi = len * (j + 1) / panels;
          const shop = hi - lo >= 2.15 && Math.abs(j + Math.round((mx + my) / 3)) % 3 === 1;
          const panel = (
            u0: number,
            u1: number,
            v0: number,
            v1: number,
            depth: number,
            finish: number,
            tint: THREE.Color,
          ) => {
            const x0 = lo + u0 * (hi - lo), x1 = lo + u1 * (hi - lo);
            const y0 = -.08 + v0 * (PASSAGE_HEAD + .08), y1 = -.08 + v1 * (PASSAGE_HEAD + .08);
            quad(
              at(x0, y0, depth),
              at(x1, y0, depth),
              at(x1, y1, depth),
              at(x0, y1, depth),
              finish,
              tint,
              side > 0 ? u0 : 1 - u0,
              side > 0 ? u1 : 1 - u1,
              1,
              v0,
              v1,
            );
          };
          if (!shop) panel(0, 1, 0, 1, 0, 0, wall);
          else {
            // Cut the vitrine out of its oak surround. Its stock sits behind
            // two brass mullions, giving it depth even when walking close by.
            const l = .105, r = .87, bottom = .31, top = .86;
            panel(0, l, 0, 1, 0, 1, wall);
            panel(r, 1, 0, 1, 0, 1, wall);
            panel(l, r, 0, bottom, 0, 1, wall);
            panel(l, r, top, 1, 0, 1, wall);
            const u = lo + l * (hi - lo),
              v = lo + r * (hi - lo),
              sill = -.08 + bottom * (PASSAGE_HEAD + .08),
              lintel = -.08 + top * (PASSAGE_HEAD + .08);
            const stock = 5 + Math.abs(Math.floor(mx * 1.7 + my * .83) + j) % 4;
            quad(
              at(u, sill, -.25),
              at(v, sill, -.25),
              at(v, lintel, -.25),
              at(u, lintel, -.25),
              stock,
              wall,
              side > 0 ? 0 : 1,
              side > 0 ? 1 : 0,
            );
            for (const edge of [u, v]) {
              quad(at(edge, sill), at(edge, sill, -.25), at(edge, lintel, -.25), at(edge, lintel), 4, brass);
            }
            for (const y of [sill, lintel]) {
              quad(at(u, y), at(v, y), at(v, y, -.25), at(u, y, -.25), 4, brass);
            }
            for (const f of [.33, .67]) {
              const x = u + (v - u) * f;
              quad(
                at(x - .012, sill, .015),
                at(x + .012, sill, .015),
                at(x + .012, lintel, .015),
                at(x - .012, lintel, .015),
                4,
                brass,
              );
            }
          }
          // The skirting and the moulding sit proud of the plaster.
          for (const [h, depth, thick] of [[.12, .043, .045], [PASSAGE_HEAD - .16, .073, .055]]) {
            quad(at(lo, h, depth), at(hi, h, depth), at(hi, h + thick, depth), at(lo, h + thick, depth), 4, brass);
            quad(
              at(lo, h + thick, depth),
              at(hi, h + thick, depth),
              at(hi, h + thick + .013),
              at(lo, h + thick + .013),
              4,
              brass,
            );
          }
        }
      }
    }
  }
  for (const { x, y, dx, dy, half } of lights) {
    const nx = -dy, ny = dx;
    const beam = [1, -1].every((s) =>
      inRoom(x + s * nx * (half - .12), y + s * ny * (half - .12)) &&
      !inRoom(x + s * nx * (half + .18), y + s * ny * (half + .18))
    );
    if (beam) {
      const top = (u: number, v: number, h: number): V => [x + nx * u + dx * v, y + ny * u + dy * v, h];
      const h = PASSAGE_HEAD - .105;
      quad(top(-half, -.12, h), top(half, -.12, h), top(half, .12, h), top(-half, .12, h), 4, jamb, 0, 1, .51);
      for (const v of [-.12, .12]) {
        quad(top(-half, v, h), top(half, v, h), top(half, v, PASSAGE_HEAD), top(-half, v, PASSAGE_HEAD), 4, jamb, 0, 1, .62);
      }
    }
    const edges: [number, number, THREE.Color][] = [[.16, .11, brass], [.15, .14, brass], [.12, .15, bulb], [
      .09,
      .212,
      bulb,
    ], [0, .228, bulb]];
    for (let k = 1; k < edges.length; k++) {
      for (let j = 0; j < 8; j++) {
        const point = (i: number, ring: number): V => {
          const [r, drop] = edges[ring], a = i * Math.PI / 4;
          return [x + r * Math.cos(a), y + r * Math.sin(a), PASSAGE_HEAD - drop + (beam ? 0 : .10)];
        };
        quad(point(j, k - 1), point(j + 1, k - 1), point(j + 1, k), point(j, k), 4, edges[k][2]);
      }
    }
  }
  return {
    position: Float32Array.from(pos),
    color: Float32Array.from(colors),
    uv: Float32Array.from(uv),
    finish: Float32Array.from(finish),
    portalPosition: Float32Array.from(portalPosition), portalColor: Float32Array.from(portalColor),
  };
}
