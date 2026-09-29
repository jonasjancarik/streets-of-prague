import * as THREE from 'three';
import type { Point2 } from './map/geo.ts';
import { DIG, NOISE, NOISE_GLSL } from './shading.ts';

// What you see of the metro on a ride (see metro.ts): the line's two tunnels, the
// platforms at its stations and your train, deep under the street. As in a road tunnel,
// they show only in the hole dug round you (DIG), where the ground is bare earth.
// Here the hole is a disc of earth drawn after the street, over whatever is on it
// (cars, trams, people), then the tunnels over that.

export const DEPTH = 18; // m the track runs under the ground
const TUBE = 6.5; // m from the line's middle to each track
const PLATFORM = 50; // m either way from a station's middle
export const TRAIN = 5, CAR = 19.3; // a train of five cars, each this long (m)

// A line's track as a path: where along it (m) is where, and which way it runs.
export class Track {
  pts: Point2[];
  at: number[]; // distance to each point
  length: number;
  constructor(pts: Point2[]) {
    this.pts = pts;
    this.at = [0];
    for (let i = 1; i < pts.length; i++) this.at.push(this.at[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this.length = this.at[this.at.length - 1];
  }

  // The point d metres along, carrying on straight past either end; `side`: that many
  // metres to the left of it.
  point(d: number, side = 0) {
    const { pts, at } = this;
    let lo = 0, hi = pts.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (at[mid] <= d) lo = mid; else hi = mid - 1;
    }
    const [x0, y0] = pts[lo], [x1, y1] = pts[lo + 1], len = at[lo + 1] - at[lo] || 1, f = (d - at[lo]) / len;
    const ang = Math.atan2(y1 - y0, x1 - x0);
    return { x: x0 + (x1 - x0) * f - Math.sin(ang) * side, y: y0 + (y1 - y0) * f + Math.cos(ang) * side, ang };
  }

  // A flat strip `w` wide along the track, `side` metres to its left, from `from` to
  // `to` metres along, `y` up (x, y, z as in the scene).
  strip(w: number, side = 0, y = 0, from = 0, to = this.length) {
    const ds = [from, ...this.at.filter((d) => d > from && d < to), to];
    const pos: number[] = [], index: number[] = [];
    ds.forEach((d, i) => {
      const a = this.point(d, side - w / 2), b = this.point(d, side + w / 2);
      pos.push(a.x, y, -a.y, b.x, y, -b.y);
      if (i) index.push(2 * i - 2, 2 * i, 2 * i - 1, 2 * i - 1, 2 * i, 2 * i + 1);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(index);
    return g;
  }
}

// A material drawn only inside the hole round you: outside it, the ground is in the way.
function holed(color: THREE.ColorRepresentation) {
  const m = new THREE.MeshLambertMaterial({ color });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDig = DIG;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHoleXZ;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n  vHoleXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vHoleXZ;\nuniform vec4 uDig;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (distance(vHoleXZ, uDig.xy) > uDig.z) discard;');
  };
  m.customProgramCacheKey = () => 'metro-hole';
  return m;
}

// The disc: where DIG says, at the ground's height (y = DEPTH above the tunnels),
// coloured like the ground in a road tunnel's hole and left at the back as far as
// depth goes, so everything of the tunnels is drawn over it.
function earth() {
  const m = new THREE.MeshLambertMaterial({ depthFunc: THREE.AlwaysDepth });
  m.color.setRGB(0.23, 0.19, 0.15);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDig = DIG;
    sh.uniforms.uNoise = NOISE;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uDig;\nvarying vec2 vEarthXZ;')
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(uDig.x + position.x * uDig.z, position.y, uDig.y + position.z * uDig.z);\n  vEarthXZ = transformed.xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vEarthXZ;\n${NOISE_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= .8 + .4 * fbm(vec2(vEarthXZ.x, -vEarthXZ.y) * .7);')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragDepth = 1.;');
  };
  m.customProgramCacheKey = () => 'metro-earth';
  return m;
}
const HOLE_ORDER = 5, TUNNEL_ORDER = 6; // after everything on the street

const WALL = holed('#4b4843'), LINING = holed('#7f7b74'), BED = holed('#524e49'), RAIL = holed('#aaa7a0'), STONE = holed('#c2bbae'), EDGE = holed('#e6dfc9');
const BODY = holed('#d6d9db'), GLASS = holed('#262b30'), ROOF = holed('#979ca0');

// One car of the train, along x, its floor at y = 0.
const box = (l: number, h: number, w: number, y: number) => new THREE.BoxGeometry(l, h, w).translate(0, y, 0);
const carParts: [THREE.BufferGeometry, THREE.Material | 'line'][] = [
  [box(CAR - 1, 2.9, 2.7, 1.95), BODY],
  [box(CAR - 0.96, 0.45, 2.74, 1.3), 'line'],
  [box(CAR - 1.8, 0.8, 2.74, 2.45), GLASS],
  [box(CAR - 2.2, 0.3, 2.1, 3.5), ROOF],
];

export class Underground {
  scene: THREE.Scene;
  group = new THREE.Group();
  track: Track | null = null;
  parts: THREE.Mesh[] = []; // the line's tunnels and stations, made for each line
  colour = holed('#ffffff'); // the line's colour: a band along the train, the station walls
  cars: THREE.Group[];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.cars = Array.from({ length: TRAIN }, () => {
      const car = new THREE.Group();
      for (const [g, m] of carParts) {
        const o = new THREE.Mesh(g, m === 'line' ? this.colour : m);
        o.castShadow = o.receiveShadow = true;
        o.renderOrder = TUNNEL_ORDER;
        car.add(o);
      }
      return car;
    });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 72).rotateX(-Math.PI / 2).translate(0, DEPTH, 0), earth());
    disc.renderOrder = HOLE_ORDER;
    disc.receiveShadow = true;
    disc.frustumCulled = false;
    this.group.add(disc, ...this.cars);
  }

  // The line's tunnels: two tracks side by side, and at each station (at `stops`, m
  // along) a platform between them and the walls in the line's colour.
  show(track: Track, colour: string, stops: number[]) {
    if (!this.group.parent) this.scene.add(this.group);
    this.colour.color.set(colour);
    if (this.track === track) return;
    this.track = track;
    for (const p of this.parts) p.geometry.dispose();
    this.group.remove(...this.parts);
    const add = (g: THREE.BufferGeometry, m: THREE.Material) => {
      const o = new THREE.Mesh(g, m);
      o.receiveShadow = true;
      o.frustumCulled = false;
      o.renderOrder = TUNNEL_ORDER;
      this.parts.push(o);
    };
    this.parts = [];
    for (const s of [-TUBE, TUBE]) {
      add(track.strip(5.6, s, 0), LINING);
      for (const w of [-2.9, 2.9]) add(track.strip(0.5, s + w, 2.5), WALL);
      add(track.strip(2.6, s, 0.05), BED);
      for (const r of [-0.72, 0.72]) add(track.strip(0.3, s + r, 0.3), RAIL);
    }
    for (const d of stops) {
      add(track.strip(2 * TUBE - 3.2, 0, 1, d - PLATFORM, d + PLATFORM), STONE);
      for (const s of [-1, 1]) {
        add(track.strip(0.35, s * (TUBE - 1.8), 1.02, d - PLATFORM, d + PLATFORM), EDGE);
        add(track.strip(1.4, s * (TUBE + 3.2), 4, d - PLATFORM - 10, d + PLATFORM + 10), this.colour);
      }
    }
    this.group.add(...this.parts);
  }

  hide() { this.scene.remove(this.group); }

  // Every frame: the tunnels `ground` m up (the street above minus DEPTH), and the
  // train with its middle at `d` m along, heading `dir` (+1 or -1) along the track, on
  // the right-hand track; no train with d null.
  place(ground: number, d: number | null, dir: number) {
    this.group.position.y = ground - DEPTH;
    const track = this.track;
    this.cars.forEach((c, i) => {
      c.visible = d !== null && !!track;
      if (d === null || !track) return;
      const p = track.point(d + dir * CAR * ((TRAIN - 1) / 2 - i), -dir * TUBE);
      c.position.set(p.x, 0.35, -p.y);
      c.rotation.y = p.ang;
    });
  }
}

