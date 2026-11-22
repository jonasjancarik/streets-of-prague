import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

type Pair = [number, number];
type XYZ = [number, number, number];
type End = [string, number, [number, number, number, number]];
export interface TramLayout {
  width: number; roof: number; eave: number; bottom: number; tumble: number; glass: Pair;
  windows: Pair[]; doors: Pair[]; doorTop: number; both: boolean; ends: [End, End];
  levels: number[]; endGlass: (Pair | [])[];
  bogies: number[]; lamps: [number, number, number, boolean][]; mirrors: Pair[]; joint: number;
}
export interface TramSources { opaque: THREE.BufferGeometry[]; glass: THREE.BufferGeometry[] }
export interface TramFittings {
  body: THREE.BufferGeometry; glass: THREE.BufferGeometry; displays: THREE.BufferGeometry[];
  driver?: XYZ; headlamp?: XYZ; numbers?: THREE.BufferGeometry;
}
// A shallow curved sheet, sampled across the actual end profile. Each column's
// UV stays in reading order even on the rear or opposite side.
function sheet(at: (u: number, v: number) => XYZ, steps = 6) {
  const g = new THREE.PlaneGeometry(1, 1, steps, 1), pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, ...at(uv.getX(i), uv.getY(i)));
  g.computeVertexNormals(); return g;
}
const up = new THREE.Vector3(0, 1, 0);

export function tramFittings(kind: string, index: number, length: number, l: TramLayout, source: TramSources): TramFittings {
  const body: THREE.BufferGeometry[] = [], glass: THREE.BufferGeometry[] = [], displays: THREE.BufferGeometry[] = [];
  const digits: THREE.BufferGeometry[] = [];
  const n = length / 2, w = l.width / 2, classic = kind === 'T3', old = classic || kind === 'KT8';
  const floor = classic ? .86 : kind === 'KT8' && index !== 1 ? .78 : l.bottom + .11;
  const black = '#262a2a', sill = '#83908e', cream = classic ? '#d7c9ae' : '#c9cbc6';
  let doorMove: ((x: number, z: number) => Pair) | undefined;
  function add(g: THREE.BufferGeometry, color?: string, glow = 0, pane = false) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    geo.deleteAttribute('uv'); const p = geo.attributes.position;
    const offsets = new Float32Array(p.count * 3);
    if (doorMove) for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), [dx, dz] = doorMove(x, z);
      offsets[3 * i] = dx - x; offsets[3 * i + 2] = dz - z;
    }
    geo.morphAttributes.position = [new THREE.BufferAttribute(offsets, 3)];
    geo.morphTargetsRelative = true;
    if (pane) { geo.deleteAttribute('color'); glass.push(geo); return; }
    if (color) {
      const c = new THREE.Color(color), colors = new Float32Array(p.count * 3);
      for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    geo.setAttribute('streetGlow', new THREE.BufferAttribute(new Float32Array(p.count).fill(glow), 1));
    body.push(geo);
  }
  function box(x: number, y: number, z: number, a: number, b: number, c: number, colour: string, glow = 0) {
    add(new THREE.BoxGeometry(a, b, c).translate(x, y, z), colour, glow);
  }
  function rod(a: XYZ, b: XYZ, r: number, colour: string, glow = 0, end = r, sides = 8) {
    const v = new THREE.Vector3(...a), axis = new THREE.Vector3(...b).sub(v), d = axis.length();
    const g = new THREE.CylinderGeometry(end, r, d, sides);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, axis.normalize()));
    v.addScaledVector(axis, d / 2); add(g.translate(v.x, v.y, v.z), colour, glow);
  }
  for (const g of source.opaque) add(g);
  for (const g of source.glass) add(g, undefined, 0, true);
  const sideZ = (y: number) => w - l.tumble * THREE.MathUtils.clamp((y - l.glass[0]) / (l.eave - l.glass[0]), 0, 1);
  // Invert the builder's rounded plan section to find the front surface at a given
  // width. The windscreen and headlamps follow its rake, including around the corners.
  const endX = (s: number, y: number, z: number) => {
    const [, r, [from, depth, to, power]] = l.ends[s > 0 ? 0 : 1];
    const reach = Math.max(0, Math.abs(z) * w / sideZ(y) - (w - r));
    const d = r - Math.sqrt(Math.max(0, r * r - reach * reach));
    const sample = (h: number) => depth * Math.pow(THREE.MathUtils.clamp((h - from) / (to - from), 0, 1), power);
    const i = l.levels.findIndex(h => h >= y);
    const lo = i < 1 ? y : l.levels[i - 1], hi = i < 1 ? y : l.levels[i];
    const rake = hi === lo ? sample(y) : THREE.MathUtils.lerp(sample(lo), sample(hi), (y - lo) / (hi - lo));
    return s * (n - d - rake * (1 - d / 1.6));
  };
  const cabinRail = classic || kind === '52T' ? '#888e87' : '#d4a944', linen = '#d2cfc1';
  // Trim the floor to the rounded nose. A rectangular slab sticks through a T3's
  // lower front corners when seen from the platform.
  const deck = sheet((u, v) => {
    const z = (u - .5) * (l.width - .16), lo = endX(-1, floor, z) + .08, hi = endX(1, floor, z) - .08;
    return [lo + v * (hi - lo), floor, z];
  }, 16);
  add(deck, '#676b66', .27);
  const ceiling = sheet((u, v) => {
    const y = l.eave - .075, z = (.5 - u) * (l.width - .29);
    const lo = endX(-1, y, z) + .10, hi = endX(1, y, z) - .10; return [lo + (hi - lo) * v, y, z];
  }, 16);
  add(ceiling, linen, .43);
  for (const sz of [-1, 1]) {
    box(0, l.eave - .11, sz * .48, length - 1.45, .028, .082, '#f5e1b8', 1.2);
    rod([-n + .65, l.eave - .24, sz * .45], [n - .85, l.eave - .24, sz * .45], .018, cabinRail, .48);
  }
  // Moulded seat shell. A dished seat pan and back are one continuous piece.
  const profile: Pair[] = [[.22, .08], [.18, .105], [-.10, .08], [-.16, .115], [-.19, .30], [-.23, .432], [-.241, .47], [-.26, .53]];
  const seatGeo = new THREE.PlaneGeometry(1, 1, 4, profile.length - 1);
  for (let i = 0; i < seatGeo.attributes.position.count; i++) {
    const uv = seatGeo.attributes.uv, v = 1 - uv.getY(i), [x, y] = profile[Math.round(v * (profile.length - 1))];
    const u = uv.getX(i) * 2 - 1, z = u * (.202 - .015 * Math.abs(v - .5) * 2);
    seatGeo.attributes.position.setXYZ(i, x + u * u * .041 * v, y + u * u * .028 * (1 - v), z);
  }
  if (!classic) {
    const idx = seatGeo.getIndex()!, kept = [];
    for (let i = 0; i < idx.count; i += 3) {
      const ids = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      const centre = ids.reduce((s, k) => s + seatGeo.attributes.position.getY(k) / 3, 0);
      const z = ids.reduce((s, k) => s + seatGeo.attributes.position.getZ(k) / 3, 0);
      if (centre < .432 || centre > .47 || Math.abs(z) > .087) kept.push(...ids);
    }
    seatGeo.setIndex(kept);
  }
  seatGeo.computeVertexNormals();
  // Both faces are visible through the windows. Reverse the back's winding separately.
  const backGeo = seatGeo.clone(), ix = backGeo.getIndex()!;
  for (let i = 0; i < ix.count; i += 3) { const b = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, b); }
  backGeo.translate(-.014, -.012, 0); backGeo.computeVertexNormals();
  const chair = (x: number, z: number, dir: number, driver = false) => {
    const y = floor + (driver ? .43 : .33), a = dir < 0 ? Math.PI : 0;
    const tint = driver ? '#394447' : classic ? '#a95642' : kind === '15T' ? '#b79569' : kind === '52T' ? '#ab3646' : '#677a86';
    add(seatGeo.clone().rotateY(a).translate(x, y, z), tint, .57);
    add(backGeo.clone().rotateY(a).translate(x, y, z), old ? tint : '#464d4e', .44);
    box(x - .035 * dir, y - .12, z, .10, .25, .095, '#575f5f', .25);
  };
  for (const sz of [-1, 1]) {
    const seatsStart = -n + (l.ends[1][0] === 'cab' ? 2.0 : .92);
    const seatsEnd = n - (l.ends[0][0] === 'cab' ? 2.08 : .73);
    const rows = Math.max(1, Math.floor((seatsEnd - seatsStart) / .78) + 1);
    for (let j = 0; j < rows; j++) {
      const x = seatsStart + j * (seatsEnd - seatsStart) / Math.max(1, rows - 1);
      if ((sz > 0 || l.both) && l.doors.some(([a, b]) => x > a - .40 && x < b + .40)) continue;
      chair(x, sz * (w - .29), 1);
      if (!classic && sz < 0 && j % 3 !== 1) chair(x, sz * (w - .72), 1);
    }
    for (const [a, b] of l.windows) {
      const lo = l.glass[0], hi = l.glass[1], mid = (a + b) / 2;
      // Rubber glazing channels and opening vent lights on the older cars.
      for (const y of [lo + .012, hi - .018]) box(mid, y, sz * (sideZ(y) + .006), b - a, .025, .023, black);
      if (old && b - a > .64) {
        const y = hi - .30;
        box(mid, y, sz * (sideZ(y) + .009), b - a, .027, .032, sill);
        rod([mid, y, sz * (sideZ(y) + .01)], [mid, hi - .012, sz * (sideZ(hi) + .01)], .013, sill);
      }
    }
    // Interior cladding below the windows, interrupted at actual doorways.
    let start = -n + .80;
    const spans = (sz > 0 || l.both) ? [...l.doors].sort((a, b) => a[0] - b[0]) : [];
    for (const [edge, after] of [...spans, [n - .84, n - .84]]) {
      if (edge > start) {
        const x = (start + edge) / 2, h = l.glass[0] - floor;
        box(x, floor + h / 2, sz * (w - .063), edge - start, h, .048, cream, .36);
        box(x, l.glass[0] - .012, sz * (w - .087), edge - start, .028, .087, '#676f6b', .36);
      }
      start = after;
    }
    if (sz < 0 && !l.both) continue;
    for (const [a, b] of l.doors) {
      const mid = (a + b) / 2, span = b - a, bottom = l.bottom + .025, top = l.doorTop;
      const side = (y: number) => sz * (sideZ(y) + .016);
      box(mid, bottom + .018, side(bottom), span + .045, .06, .12, '#7d817c');
      if (floor - bottom > .20) {
        const steps = Math.ceil((floor - bottom) / .20);
        for (let j = 0; j < steps; j++) box(mid, bottom + (j + 1) * (floor - bottom) / steps - .02, sz * (w - .08 - j * .16), span - .09, .06, .175, '#a79865', .36);
      }
      for (const x of [a, b]) {
        rod([x, bottom, side(bottom)], [x, top, side(top)], .026, black);
        rod([x, floor + .03, sz * (w - .27)], [x, l.eave - .17, sz * (w - .29)], .019, cabinRail, .50);
      }
      box(mid, top + .018, side(top), span + .04, .05, .07, '#343735');
      const steps = classic ? 4 : span < .8 ? 1 : 2, pw = span / steps;
      for (let j = 0; j < steps; j++) {
        const cx = a + pw * (j + .5), outer = j < steps / 2 ? -1 : 1;
        if (sz > 0) {
          if (classic) {
            const hinge = outer < 0 ? a : b, pos = (cx - hinge), angle = (j % 2 === 0 ? 1 : -1) * 1.27;
            doorMove = (x, z) => [hinge + pos * .27 + (x - cx) * Math.cos(angle) + (z - side(1.3)) * Math.sin(angle),
            side(1.3) - .14 - (x - cx) * Math.sin(angle) + (z - side(1.3)) * Math.cos(angle)];
          } else doorMove = (x, z) => [x + outer * pw * .95, z + .073];
        }
        const panelBottom = classic ? .92 : Math.min(1.02, bottom + .38);
        const stripe = classic ? '#e2d4ad' : '#393e3d';
        box(cx, (bottom + panelBottom) / 2, side((bottom + panelBottom) / 2), pw - .012, panelBottom - bottom, .054, stripe, .06);
        for (const x of [cx - pw / 2 + .018, cx + pw / 2 - .018]) rod([x, panelBottom, side(panelBottom)], [x, top, side(top)], .019, old ? '#4c4841' : black);
        box(cx, top - .035, side(top), pw, .065, .052, black);
        add(sheet((u, v) => { const y = panelBottom + v * (top - panelBottom - .055); return [cx + (u - .5) * (pw - .043), y, side(y)]; }, 1), undefined, 0, true);
        if (!classic && j === 0) {
          const x = cx + pw * .32, y = 1.13, z = side(y);
          rod([x, y, z], [x, y, z + sz * .025], .055, '#c6aa42', .12);
          rod([x, y, z + sz * .026], [x, y, z + sz * .034], .036, '#77965d', .25);
        }
      }
      doorMove = undefined;
    }
  }
  let driver: XYZ | undefined;
  for (const s of [1, -1]) {
    const [end] = l.ends[s > 0 ? 0 : 1]; if (end === 'joint') continue;
    const cab = end === 'cab', bounds = l.endGlass[s > 0 ? 0 : 1], upper = bounds[1] ?? l.eave - .20;
    const lower = bounds[0] ?? 1.3;
    const tip = (y: number, z: number, out = .016): XYZ => [endX(s, y, z) + s * out, y, z];
    for (const z of [-w * .77, w * .77, ...(classic ? [0] : [])]) {
      rod(tip(lower, z), tip(upper, z), classic && z === 0 ? .024 : .033, classic ? '#e0cfaa' : black);
    }
    for (const y of [lower + .008, upper]) {
      const tone = classic ? '#ccbc9a' : black;
      for (let j = 0; j < 10; j++) {
        const a = (j / 10 - .5) * w * 1.65, b = ((j + 1) / 10 - .5) * w * 1.65;
        rod(tip(y, a), tip(y, b), .024, tone);
      }
    }
    if (cab && index === 0) {
      const centreY = classic ? 1.24 : kind === '52T' ? .66 : .70, hi = classic ? .135 : .095, wide = hi * .57;
      for (let k = 0; k < 4; k++) digits.push(sheet((u, v) => tip(centreY + (v - .5) * hi, (2 - k - u) * wide * s, .026), 1));
    }
    if (cab) {
      const dashTop = lower + .014;
      const dashboard = sheet((u, v) => {
        const z = (u - .5) * (l.width - .32) * s;
        const nose = endX(s, dashTop, z) - s * .032;
        return [THREE.MathUtils.lerp(s * (n - 1.44), nose, v), dashTop - .054 * (1 - v), z];
      }, 12);
      add(dashboard, '#414744', .19);
      box(s * (n - 1.34), dashTop - .117, 0, .18, .17, l.width - .71, '#424847', .19);
      box(s * (n - 1.36), lower + .025, -.27, .28, .12, .59, '#343f40', .24);
      rod([s * (n - 1.45), lower - .01, -.04], [s * (n - 1.49), lower + .17, -.04], .018, black);
      for (const z of [-.57, -.46, -.35]) box(s * (n - 1.51), lower + .065, z, .024, .042, .077, '#7d8e84', .35);
      box(s * (n - 1.85), floor + .38, -.54, .26, .73, .27, '#454a47', .25);
      chair(s * (n - 1.53), -.34, s, true);
      if (index === 0 && s > 0) driver = [n - 1.54, floor + .51, -.34];
      for (const z of (classic ? [-.44, .44] : [0])) {
        const sweep = classic ? .36 : .65;
        rod(tip(lower + .02, z - .17, .037), tip(lower + .31, z + .07, .042), .014, black);
        rod(tip(lower + .22, z - sweep * .49, .047), tip(lower + .36, z + sweep * .51, .047), .016, '#303434');
      }
      // Glazed partition behind the driver, with a solid waist below it.
      box(s * (n - 1.98), floor + .43, -.21, .035, .86, l.width - .69, cream, .25);
      const wall = s * (n - 1.97), base = floor + .86, top = l.eave - .20;
      add(sheet((u, v) => [wall, base + (top - base) * v, -w + .19 + u * (w + .16)], 1), undefined, 0, true);
      box(wall, top, -.21, .042, .039, l.width - .69, '#494d48');
      box(wall, floor + .69, -.21, .045, .017, l.width - .70, '#929b92', .28);
      for (const z of [-w + .18, .35]) rod([s * (n - 1.98), floor + .85, z], [s * (n - 1.98), l.eave - .16, z], .021, black);
    }
    if (cab || index > 0) {
      const dy = classic ? 2.67 : upper - .16, dh = classic ? .222 : .278, dw = classic ? 1.17 : 1.48;
      const screen = (width: number, height: number, out: number) =>
        sheet((u, v) => tip(dy + (v - .5) * height, (.5 - u) * width * s, out));
      add(screen(dw + .072, dh + .072, .021), black);
      displays.push(screen(dw, dh, .029));
    }
  }
  let headlamp: XYZ | undefined;
  for (const [x, wide, y, tail] of l.lamps) {
    if (index === 0 && x > 0 && !tail) headlamp = [endX(1, y, wide) + .064, y, wide];
    const s = Math.sign(x), tint = tail ? '#a82e24' : '#e7dfc4';
    for (const side of [-1, 1]) {
      const z = side * wide, xx = endX(s, y, z);
      const radius = classic ? .114 : kind === 'KT8' ? .087 : .089;
      if (!old) {
        // A twin optic lives in a single inset, following the wrap into the side.
        const contour: Pair[] = [[-.22, -.044], [-.19, -.091], [.16, -.097], [.22, -.051], [.215, .048], [.17, .094], [-.155, .084], [-.217, .040]];
        const geom = new THREE.BufferGeometry(), vertices: number[] = [];
        for (let j = 0; j < contour.length; j++) {
          const p = contour[j], q = contour[(j + 1) % contour.length];
          const pt = ([d, h]: Pair): XYZ => { const zz = z - side * .061 + side * d; return [endX(s, y + h, zz) + s * .023, y + h, zz]; };
          vertices.push(...pt([0, 0]), ...pt(p), ...pt(q), ...pt([0, 0]), ...pt(q), ...pt(p));
        }
        geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geom.computeVertexNormals(); add(geom, '#404747');
      }
      rod([xx - s * .036, y, z], [xx + s * .004, y, z], radius * 1.21, black, 0, radius * 1.15, 16);
      // Fluted reflector bowl and central emitter below a gently convex lens.
      const rings: [number, number][] = [[radius * .985, .038], [radius * .83, .033], [radius * .49, .021], [radius * .23, .017]];
      for (let j = 1; j < rings.length; j++) {
        const [r0, x0] = rings[j - 1], [r1, x1] = rings[j];
        const cone = new THREE.CylinderGeometry(r1, r0, x0 - x1, 16, 1, true).rotateZ(s * Math.PI / 2);
        add(cone.translate(xx + s * (x0 + x1) / 2, y, z), tail ? '#aa4032' : j === 1 ? '#c4c7ba' : '#d8d6c1', tail ? .8 : 1.5);
      }
      rod([xx + s * .018, y, z], [xx + s * .044, y, z], radius * .31, tint, tail ? 2.6 : 4.6, radius * .24, 12);
      const lens = new THREE.SphereGeometry(1, 18, 8).scale(.019, radius * .82, radius * .82)
        .translate(xx + s * .044, y, z);
      add(lens, tail ? '#af2d23' : '#dfdfcd', tail ? 2.1 : 2.85);
      // Shallow moulding in the lens catches daylight even with the lamp unlit.
      for (const k of [-1, 1]) rod([xx + s * .060, y + k * radius * .31, z - radius * .54],
        [xx + s * .060, y + k * radius * .31, z + radius * .54], .0025, tail ? '#d34c37' : '#e9ead8', tail ? 1.3 : 2.2, .0025, 4);

      if (!classic && !tail) {
        const z2 = z - side * .165, x2 = endX(s, y, z2);
        rod([x2, y, z2], [x2 + s * .041, y, z2], .055, black);
        rod([x2 + s * .042, y, z2], [x2 + s * .052, y, z2], .041, '#dfb778', .28);
      }
    }
  }
  for (const [x, y] of l.mirrors) for (const sz of [-1, 1]) {
    const end = Math.sign(x), z = sz * (w + .16);
    rod([x - .06 * end, y + .10, sz * (w - .035)], [x + .04 * end, y + .16, z], .020, black);
    box(x + .04 * end, y + .05, z, .083, .225, .123, black);
    box(x - .005 * end, y + .05, z, .009, .183, .10, '#969f9f');
  }
  for (const x of l.bogies) {
    box(x, .26, 0, 1.9, .28, l.width - .48, '#373b3b');
    for (const axle of [-.71, .71]) for (const sz of [-1, 1]) {
      const z = sz * .76;
      rod([x + axle, .29, z - sz * .085], [x + axle, .29, z + sz * .085], .285, '#50534e', 0, .285, 16);
      rod([x + axle, .29, z + sz * .087], [x + axle, .29, z + sz * .106], .17, '#64645d', 0, .13, 12);
    }
  }
  if (l.joint) for (let j = 0; j < 5; j++) {
    const x = -n - l.joint * j / 4;
    for (const sz of [-1, 1]) box(x, (l.eave + l.bottom + .13) / 2, sz * (w - .085), .031, l.eave - l.bottom - .13, .052, '#444743');
  }
  // Side destination display, readable while standing beside the first entrance.
  if (classic || index === (kind === '14T' ? 1 : 0)) {
    const betweenDoors = kind === '14T', width = betweenDoors ? .68 : .98;
    const cx = betweenDoors ? 0 : Math.min(n - 1.4, l.doors[0][0] - .73), y = l.glass[1] - .20, z = sideZ(y);
    box(cx, y, z, width, .241, .049, '#262b28');
    displays.push(new THREE.PlaneGeometry(width - .055, .193).translate(cx, y, z + .027));
  }
  const merge = (parts: THREE.BufferGeometry[]) => { const g = mergeGeometries(parts)!; parts.forEach(p => p.dispose()); return g; };
  return { body: merge(body), glass: merge(glass), displays, driver, headlamp, numbers: digits.length ? mergeGeometries(digits)! : undefined };
}
