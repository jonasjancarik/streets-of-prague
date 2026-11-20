import * as THREE from 'three';
import { headsignAt, type Trams } from './trams.ts';
import { StopSign, type StopRoute } from './stopSign.ts';

const SIDE = 2.9; // m from the track, on the right of the way the trams go
const MERGE = 14;
interface Sign {
  x: number; y: number; ang: number; name: string; platform?: string;
  routes: StopRoute[]; mesh: StopSign | null; shown: boolean;
}

export class TramStops {
  scene: THREE.Scene;
  signs: Sign[] = [];

  constructor(trams: Trams, scene: THREE.Scene) {
    this.scene = scene;
    for (const line of trams.lines) {
      for (const [i, h] of line.halts.entries()) {
        const p = line.path.at(h.s);
        const c = Math.cos(p.ang), s = Math.sin(p.ang);
        const x = p.x + s * SIDE, y = p.y - c * SIDE;
        let sign = this.signs.find(o => o.name === h.name && (!o.platform || !h.platform || o.platform === h.platform)
          && Math.hypot(o.x - x, o.y - y) < MERGE && Math.cos(o.ang - p.ang) > 0);
        if (!sign) {
          sign = { x, y, ang: p.ang, name: h.name, platform: h.platform, routes: [], mesh: null, shown: false };
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

  // Only signs near the view are in the scene.
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number, street = false) {
    for (const sg of this.signs) {
      const show = Math.abs(sg.x - x) < r && Math.abs(sg.y - y) < r;
      if (show !== sg.shown) {
        sg.shown = show;
        if (show) this.scene.add(sg.mesh ??= new StopSign('tram', sg.name, sg.ang, sg.routes, sg.platform));
        else if (sg.mesh) { sg.mesh.view(false); this.scene.remove(sg.mesh); }
      }
      if (show) {
        sg.mesh!.position.set(sg.x, height(sg.x, sg.y), -sg.y);
        sg.mesh!.view(street, sg.x - x, sg.y - y);
      }
    }
  }
}
