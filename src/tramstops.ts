import * as THREE from 'three';
import { headsignAt, type Trams } from './trams.ts';
import { StopSign, type StopRoute } from './stopSign.ts';

const SIDE = 2.9; // m from the track, on the right of the way the trams go, until placed
// m from the track where the search for the pavement or platform starts (clear of the
// tram itself), and the furthest out it looks.
const CLEAR = 2.2, FURTHEST = 16;
const MERGE = 14;
const RETRY = 250; // ms: a sign whose ground isn't loaded yet is tried again after this
interface Sign {
  x: number; y: number; ang: number; name: string; platform?: string;
  routes: StopRoute[]; mesh: StopSign | null; shown: boolean;
  track: [number, number]; // the point on the track it was filed by
  placed: boolean; tried: number;
}
// What the stops need to know of the ground: whether it's loaded, on the carriageway (with
// its parking bays and the trams' bed), or inside a house.
export interface StopGround {
  loaded: (x: number, y: number) => boolean;
  onRoad: (x: number, y: number) => boolean;
  solid: (x: number, y: number) => boolean;
}

export class TramStops {
  scene: THREE.Scene;
  signs: Sign[] = [];

  ground: StopGround | null;

  constructor(trams: Trams, scene: THREE.Scene, ground: StopGround | null = null) {
    this.scene = scene; this.ground = ground;
    for (const line of trams.lines) {
      for (const [i, h] of line.halts.entries()) {
        const p = line.path.at(h.s);
        const c = Math.cos(p.ang), s = Math.sin(p.ang);
        const x = p.x + s * SIDE, y = p.y - c * SIDE;
        let sign = this.signs.find(o => o.name === h.name && (!o.platform || !h.platform || o.platform === h.platform)
          && Math.hypot(o.x - x, o.y - y) < MERGE && Math.cos(o.ang - p.ang) > 0);
        if (!sign) {
          sign = { x, y, ang: p.ang, name: h.name, platform: h.platform, routes: [], mesh: null, shown: false, track: [p.x, p.y], placed: !ground, tried: -Infinity };
          this.signs.push(sign);
        }
        sign.platform ??= h.platform;
        const to = headsignAt(line, h.s);
        if (sign.routes.some(r => r.ref === line.ref && r.to === to)) continue;
        const preceding = line.halts.slice(Math.max(0, i - 3), i).filter(stop => headsignAt(line, stop.s) === to).map(stop => stop.name);
        const following = [];
        for (let j = i + 1; j < line.halts.length && following.length < 5; j++) {
          if (headsignAt(line, line.halts[j].s) !== to) break;
          following.push(line.halts[j].name);
          if (line.halts[j].name === to) break;
        }
        sign.routes.push({ ref: line.ref, to, preceding, following });
      }
    }
  }

  // Out from the track on its right to the first ground off the carriageway (the pavement,
  // or the platform between the track and the cars), a little way onto it and short of any
  // house; on its left where the right has none within reach (an island between the
  // tracks). False while its ground isn't loaded; where neither side has any, it stays put.
  private place(sg: Sign) {
    const o = this.ground!, [tx, ty] = sg.track;
    for (const side of [1, -1]) {
      const rx = side * Math.sin(sg.ang), ry = -side * Math.cos(sg.ang);
      const at = (d: number): [number, number] => [tx + rx * d, ty + ry * d];
      if (!o.loaded(tx, ty) || !o.loaded(...at(FURTHEST))) return false;
      let off = CLEAR;
      while (off < FURTHEST && o.onRoad(...at(off))) off += 0.25;
      if (o.onRoad(...at(off)) || o.solid(...at(off))) continue;
      const kerb = off;
      off += 0.4;
      while (off > kerb + 0.1 && (o.solid(...at(off)) || o.onRoad(...at(off)))) off -= 0.1;
      [sg.x, sg.y] = at(off);
      return true;
    }
    return true;
  }

  // Only signs near the view are in the scene (once they stand on their pavement).
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number, street = false) {
    const now = performance.now();
    for (const sg of this.signs) {
      let show = Math.abs(sg.x - x) < r && Math.abs(sg.y - y) < r;
      if (show && !sg.placed) {
        if (now - sg.tried > RETRY) { sg.tried = now; sg.placed = this.place(sg); }
        show = sg.placed;
      }
      if (show !== sg.shown) {
        sg.shown = show;
        if (show) this.scene.add(sg.mesh ??= new StopSign('tram', sg.name, sg.ang, sg.routes, sg.platform));
        else if (sg.mesh) { sg.mesh.view(false); sg.mesh.lift(); this.scene.remove(sg.mesh); }
      }
      if (show) {
        const z = height(sg.x, sg.y);
        sg.mesh!.position.set(sg.x, z, -sg.y);
        sg.mesh!.stand(sg.x, sg.y, z);
        sg.mesh!.view(street, sg.x - x, sg.y - y);
      }
    }
  }
}
