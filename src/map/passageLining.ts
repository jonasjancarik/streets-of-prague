// Join the mapped walkable strips before building their lining. Junctions stay
// open and the corridor ends where the building gives way to pavement or a yard.
// A covered walkway (pasáž) gets display cases and a flat ceiling; a gateway for
// carts and cars (průjezd) gets plastered walls on a stone plinth under a vault.
import * as THREE from 'three';
import { difference, intersection, union } from 'polyclip-ts';
import { onPolygons } from './geo.ts';
import { ARCH_SPRING, PASSAGE_HEAD, passageKind, passageOutline, passageSections, vaultHeight } from './passageOpenings.ts';
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
const plaster = new THREE.Color('#e3d6c0'), plinth = new THREE.Color('#8d8476'), lantern = new THREE.Color('#2c2a27');
export function passageLining(
  paths: TilePassage[],
  houses: { rings: Point2[][] }[],
  box: Bounds,
  height: (x: number, y: number) => number,
  landmarks: Polygons = [],
  facades?: Float32Array,
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
  const walks = paths.filter((p) => passageKind(p) === 'walk'), drives = paths.filter((p) => passageKind(p) === 'drive');
  const strip = (list: TilePassage[]) => list.length ? union(list.map(passageOutline).filter((r) => r.length)) as Polygons : [];
  const walkRibbon = strip(walks), driveRibbon = strip(drives);
  const ribbon = walkRibbon.length && driveRibbon.length ? union(walkRibbon, driveRibbon) as Polygons : walkRibbon.length ? walkRibbon : driveRibbon;
  const [x0, y0, x1, y1] = box;
  const tileBox: Polygons = [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]];
  let block: Polygons = nearby.map((b) => b.rings);
  const roomsOf = (r: Polygons) => {
    if (!r.length) return [];
    let out = intersection(r, block, tileBox) as Polygons;
    if (out.length && landmarks.length) out = difference(out, landmarks) as Polygons;
    return out;
  };
  // OSM's outlines and IPR's walls disagree by up to a metre or two: end each
  // passage's lining where the wall it was cut through stands.
  if (facades?.length) block = toFacades(block, paths.filter((p) => passageKind(p)), facades);
  // A gateway is vaulted only inside the houses its road runs through, and where it
  // reaches out to their walls. A road widened for its pavement can overlap the next
  // house's outline, where IPR often has open pavement.
  let halls = roomsOf(driveRibbon);
  if (halls.length) {
    const own = nearby.filter(({ rings }) => {
      const at = onPolygons([rings]);
      return drives.some(({ pts }) => pts.some((a, i) => {
        const b = pts[i + 1];
        if (!b) return false;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / .5));
        for (let k = 0; k <= n; k++) if (at(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n)) return true;
        return false;
      }));
    });
    const others = nearby.filter((b) => !own.includes(b)).map((b) => b.rings);
    if (others.length) halls = difference(halls, others) as Polygons;
  }
  let rooms = roomsOf(walkRibbon);
  if (rooms.length && halls.length) rooms = difference(rooms, halls) as Polygons;
  if (!rooms.length && !halls.length) return null;
  const inRoom = onPolygons(rooms), inHall = onPolygons(halls), inRibbon = onPolygons(ribbon);
  // The vault over a gateway: the highest of the arches of the strips over (x, y).
  const vault = (x: number, y: number) => {
    let h = ARCH_SPRING;
    for (const p of drives) {
      const half = p.w / 2 + .08;
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
        const d = Math.hypot(a[0] + dx * u - x, a[1] + dy * u - y);
        if (d < half) h = Math.max(h, vaultHeight(d, half));
      }
    }
    return h;
  };
  // Whether an edge at (x, y) heading (dx, dy) runs along the nearest gateway road.
  const alongRoad = (x: number, y: number, dx: number, dy: number) => {
    let best = Infinity, cos = 0;
    for (const p of drives) {
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i], ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1;
        const u = Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / (l * l)));
        const d = Math.hypot(a[0] + ex * u - x, a[1] + ey * u - y);
        if (d < best) {
          best = d;
          cos = Math.abs(dx * ex + dy * ey) / l;
        }
      }
    }
    return cos > .7;
  };
  const pos: number[] = [], colors: number[] = [], uv: number[] = [], finish: number[] = [];
  const portalPosition: number[] = [], portalColor: number[] = [];
  const lights: { x: number; y: number; dx: number; dy: number; half: number }[] = [];
  const lanterns: { x: number; y: number }[] = [];
  for (const s of spans) {
    if (s.kind === 'drive') {
      // A lantern under the crown of a gateway's vault every 9 m or so.
      const phase = s.ax * s.dx + s.ay * s.dy;
      const along = Math.ceil((phase + 4.5) / 9) * 9 - 4.5 - phase;
      if (along > s.length) continue;
      const x = s.ax + s.dx * along, y = s.ay + s.dy * along;
      if (inHall(x, y) && !lanterns.some((p) => Math.hypot(p.x - x, p.y - y) < 4)) lanterns.push({ x, y });
      continue;
    }
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
    for (const p of lanterns) d = Math.min(d, ((p.x - x) ** 2 + (p.y - y) ** 2) * .6);
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
        if (left && right && len > 1.2 && len < 7 && !inHall(mx + dy * .3, my - dx * .3) && !inHall(mx - dy * .3, my + dx * .3)) {
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
  // Gateways: a vault over plastered walls on a stone plinth, a stone surround
  // round the arch on the street side, lanterns under the crown.
  for (const shape of halls) {
    const rings = shape.map((r) => r.slice(0, -1)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const vecs = rings.map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const face = rings.flat(), tris = THREE.ShapeUtils.triangulateShape(vecs[0], vecs.slice(1));
    // Fine enough for the curve of the vault (the road and its tracks are the floor).
    const ceil = (a: Point2, b: Point2, c: Point2) => {
      const ab = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2,
        bc = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2,
        ca = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
      if (Math.max(ab, bc, ca) > .2) {
        if (bc > ab && bc >= ca) return ceil(b, c, a);
        if (ca > ab && ca > bc) return ceil(c, a, b);
        const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        ceil(a, mid, c);
        ceil(mid, b, c);
        return;
      }
      for (const [x, y] of [a, b, c]) {
        const h = vault(x, y);
        vertex([x, y, h], [x / 2.4, y / 2.4 + h / 2.4], 3, plaster, .86 + .14 * Math.min(1, (h - ARCH_SPRING) / 1.5));
      }
    };
    for (const [a, b, c] of tris) ceil(face[a], face[b], face[c]);
    for (const ring of rings) {
      // Each edge: a wall (left or right of it inside), the gateway's street end
      // (`front`), or nothing.
      const edges = ring.map((a, i) => {
        const b = ring[(i + 1) % ring.length];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < .03 || Math.min(Math.abs(mx - x0), Math.abs(mx - x1), Math.abs(my - y0), Math.abs(my - y1)) < .025) return null;
        const dx = (b[0] - a[0]) / len, dy = (b[1] - a[1]) / len;
        let left = inRibbon(mx - dy * .06, my + dx * .06), right = inRibbon(mx + dy * .06, my - dx * .06);
        const inward = inHall(mx - dy * .05, my + dx * .05) ? 1 : -1;
        const out = inward > 0 ? [mx + dy * .3, my - dx * .3] : [mx - dy * .3, my + dx * .3];
        // Where the vault was cut back to its own house the edge runs along the road
        // with road on both sides: a side wall, not a street end.
        if (left && right && alongRoad(mx, my, dx, dy)) {
          left = inward > 0;
          right = !left;
        }
        // The street end of the gateway (not where it joins a walkway inside).
        const front = left && right && !inRoom(out[0], out[1]) && !inHall(out[0], out[1]);
        return { a, len, dx, dy, left, right, inward, front };
      });
      // A front bent by a notch in the outline is still one arch: its length and
      // the jambs at its ends count over the run of front edges.
      const isFront = (i: number) => !!edges[(i + edges.length) % edges.length]?.front;
      const run = (i: number) => {
        let total = edges[i]!.len;
        for (let j = i - 1; j > i - edges.length && isFront(j); j--) total += edges[(j + edges.length) % edges.length]!.len;
        for (let j = i + 1; j < i + edges.length && isFront(j); j++) total += edges[j % edges.length]!.len;
        return total;
      };
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (!e) continue;
        const { a, len, dx, dy, left, right, inward } = e;
        if (left && right) {
          if (!e.front) continue;
          const total = run(i);
          if (total < 1.2 || total > 14) continue;
          const at = (along: number, depth: number, h: number): V =>
            [a[0] + dx * along - dy * depth * inward, a[1] + dy * along + dx * depth * inward, h];
          // (The reveal stops where the vault and walls begin, so they don't fight.)
          const front = -.07, back = -.01, band = .3, n = Math.max(8, Math.ceil(len * 4));
          const arch = Array.from({ length: n + 1 }, (_, k) => {
            const u = len * k / n, p = at(u, .05, 0);
            return [u, vault(p[0], p[1])] as const;
          });
          for (let k = 0; k < n; k++) {
            const [u0, h0] = arch[k], [u1, h1] = arch[k + 1];
            // The soffit of the arch through the wall, and the band of stone round it.
            quad(at(u0, front, h0), at(u1, front, h1), at(u1, back, h1), at(u0, back, h0), 9, jamb, 0, 1, .6);
            quad(at(u0, front, h0 - .04), at(u1, front, h1 - .04), at(u1, front, h1 + band), at(u0, front, h0 + band), 9, jamb);
          }
          for (const [end, side] of [[0, -1], [len, 1]] as const) {
            if (isFront(end ? i + 1 : i - 1)) continue;
            const h = arch[end ? n : 0][1], inside = end - side * .02, outside = end + side * band;
            quad(at(inside, front, -.02), at(inside, back, -.02), at(inside, back, h), at(inside, front, h), 9, jamb, 0, 1, .63);
            quad(at(outside, front, -.02), at(inside, front, -.02), at(inside, front, h + band), at(outside, front, h + band), 9, jamb);
            // A kerbstone at the foot of each side, to keep wheels off the jambs.
            const kerb = end - side * .3;
            quad(at(kerb, front - .05, .5), at(end, front - .05, .5), at(end, front - .05, -.02), at(kerb, front - .05, -.02), 9, jamb, 0, 1, .72);
          }
          continue;
        }
        if (left === right) continue;
        const side = left ? 1 : -1;
        const at = (s: number, h: number, inset = 0): V => [a[0] + dx * s - dy * inset * side, a[1] + dy * s + dx * inset * side, h];
        const panels = Math.max(1, Math.round(len / 3));
        // Up to the vault, which is above the springing where a wall cuts into it.
        const top = (s: number) => {
          const p = at(s, 0, .05);
          return Math.max(ARCH_SPRING, vault(p[0], p[1])) + .02;
        };
        for (let j = 0; j < panels; j++) {
          const lo = len * j / panels, hi = len * (j + 1) / panels;
          // Plaster above a stone plinth with a chamfered top.
          quad(at(lo, .62), at(hi, .62), at(hi, top(hi)), at(lo, top(lo)), 3, plaster, lo / 2.4, hi / 2.4, 1, .26, 1.2);
          quad(at(lo, -.08, .06), at(hi, -.08, .06), at(hi, .55, .06), at(lo, .55, .06), 4, plinth);
          quad(at(lo, .55, .06), at(hi, .55, .06), at(hi, .62), at(lo, .62), 4, plinth, 0, 1, 1.15);
        }
      }
    }
  }
  for (const { x, y } of lanterns) {
    // A small black lantern on a short rod, its glass lit.
    const h = vault(x, y), rod: V[] = [[x - .02, y, h], [x + .02, y, h], [x + .02, y, h - .45], [x - .02, y, h - .45]];
    quad(rod[0], rod[1], rod[2], rod[3], 4, lantern);
    quad([x, y - .02, h], [x, y + .02, h], [x, y + .02, h - .45], [x, y - .02, h - .45], 4, lantern);
    for (let j = 0; j < 4; j++) {
      const a = j * Math.PI / 2, b = a + Math.PI / 2, r = .13;
      const p = (t: number, z: number, k = r): V => [x + k * Math.cos(t), y + k * Math.sin(t), z];
      quad(p(a, h - .82), p(b, h - .82), p(b, h - .5), p(a, h - .5), 4, bulb);
      quad(p(a, h - .5), p(b, h - .5), p(b, h - .43, .03), p(a, h - .43, .03), 4, lantern);
      quad(p(a, h - .86, .05), p(b, h - .86, .05), p(b, h - .82), p(a, h - .82), 4, lantern);
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

// The outlines `block` grown or cut back along each passage to the walls as built
// (`facades`: x, y and the wall's normal in plan for each crossing).
function toFacades(block: Polygons, paths: TilePassage[], facades: Float32Array): Polygons {
  const inside = onPolygons(block), grow: Polygons = [], cut: Polygons = [];
  for (let k = 0; k + 3 < facades.length; k += 4) {
    const hx = facades[k], hy = facades[k + 1], nx = facades[k + 2], ny = facades[k + 3];
    let best = .35, dir: Point2 | null = null, half = 0;
    for (const p of paths) {
      for (let i = 1; i < p.pts.length; i++) {
        const a = p.pts[i - 1], b = p.pts[i], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < .05) continue;
        // (The opening is cut half the width past the strip's ends.)
        const reach = (p.w / 2 + .08) / l, first = i === 1, last = i === p.pts.length - 1;
        const u = Math.max(first ? -reach : 0, Math.min(last ? 1 + reach : 1, ((hx - a[0]) * dx + (hy - a[1]) * dy) / (l * l)));
        const d = Math.hypot(a[0] + dx * u - hx, a[1] + dy * u - hy);
        if (d < best && Math.abs((dx * nx + dy * ny) / l) > .34) [best, dir, half] = [d, [dx / l, dy / l], p.w / 2 + .08];
      }
    }
    if (!dir) continue;
    // The nearest point along the axis, either way, where the outline begins or ends.
    const here = inside(hx, hy);
    let found = 0;
    // (Upper floors overhanging the street put OSM's outline up to several metres out.)
    for (let s = .1; s <= 8 && !found; s += .1) {
      for (const sign of [1, -1]) {
        if (inside(hx + dir[0] * s * sign, hy + dir[1] * s * sign) !== here) {
          found = s * sign;
          break;
        }
      }
    }
    if (!found) continue;
    // Inside the wall the lining reaches the outline (grown to it where the outline
    // falls short); outside it nothing, up to the next building along the passage.
    const tx = -ny, ty = nx, cos = Math.abs(dir[0] * nx + dir[1] * ny);
    const wide = (half + .4) / Math.max(.4, cos);
    const slab = (from: number, to: number): Point2[] => {
      const ax = hx + dir[0] * from, ay = hy + dir[1] * from, bx = hx + dir[0] * to, by = hy + dir[1] * to;
      return [[ax - tx * wide, ay - ty * wide], [ax + tx * wide, ay + ty * wide], [bx + tx * wide, by + ty * wide],
        [bx - tx * wide, by - ty * wide], [ax - tx * wide, ay - ty * wide]];
    };
    const out = here ? Math.sign(found) : -Math.sign(found);
    if (!here) grow.push([slab(0, found + Math.sign(found) * .3)]);
    let s = .1, left = !here;
    for (; s <= 8; s += .1) {
      const inHouse = inside(hx + dir[0] * s * out, hy + dir[1] * s * out);
      if (!inHouse) left = true;
      else if (left) break;
    }
    cut.push([slab(0, out * s)]);
  }
  let out = block;
  if (grow.length) out = union(out, ...grow.map((g) => [g])) as Polygons;
  if (cut.length) out = difference(out, ...cut.map((c) => [c])) as Polygons;
  return out;
}
