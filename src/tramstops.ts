import * as THREE from 'three';
import type { Trams } from './trams.ts';

// A sign at every tram stop: a blue plate with a black tram in side view, as on the real
// stops, lying flat so it reads from above, and, on the pole, the stop's name facing across the track.

const SIDE = 2.9; // m from the track, on the right of the way the trams go
const MERGE = 14; // m: stops this close, with the same heading, share a sign

interface Sign { x: number; y: number; ang: number; name: string; mesh: THREE.Group | null; shown: boolean }

const topMaterial = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('Cannot create tram stop sign canvas');
  // The blue "H" style plate used at real stops: white frame, pale field, black tram.
  g.fillStyle = '#0b4a9c';
  g.beginPath();
  g.roundRect(1, 1, 62, 62, 5);
  g.fill();
  g.strokeStyle = '#fff';
  g.lineWidth = 2.5;
  g.strokeRect(6, 6, 52, 52);
  g.fillStyle = '#eef0ee';
  g.fillRect(10, 10, 44, 44);
  g.fillStyle = '#16181a';
  g.fillRect(29, 21, 6, 1.5); // pantograph bar
  g.beginPath();
  g.moveTo(32, 22.5); g.lineTo(28, 27); g.lineTo(32, 27); g.lineTo(36, 27); g.closePath();
  g.fill();
  g.beginPath();
  g.roundRect(14, 27, 36, 14, 3); // body
  g.fill();
  g.fillStyle = '#eef0ee';
  for (const x of [17, 24, 31, 38, 45]) g.fillRect(x, 29.5, 5, 5); // windows
  g.fillStyle = '#16181a';
  g.fillRect(13, 43, 38, 1.5); // rail
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
})();

const names = new Map<string, THREE.MeshBasicMaterial>();
export function nameMaterial(name: string) {
  let m = names.get(name);
  if (!m) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 48;
    const g = c.getContext('2d');
    if (!g) throw new Error('Cannot create tram stop name canvas');
    g.fillStyle = '#12233b';
    g.fillRect(0, 0, 256, 48);
    g.fillStyle = '#fff';
    g.font = 'bold 26px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(name, 128, 26, 240);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    names.set(name, m);
  }
  return m;
}

const topGeometry = new THREE.PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2);
const plateGeometry = new THREE.PlaneGeometry(1.8, 0.34);
export const postGeometry = new THREE.BoxGeometry(0.14, 2.6, 0.14).translate(0, 1.3, 0);
export const postMaterial = new THREE.MeshLambertMaterial({ color: '#3a3d40' });

export class TramStops {
  scene: THREE.Scene;
  signs: Sign[] = [];

  constructor(trams: Trams, scene: THREE.Scene) {
    this.scene = scene;
    for (const line of trams.lines) {
      for (const h of line.halts) {
        const p = line.path.at(h.s);
        const c = Math.cos(p.ang), s = Math.sin(p.ang);
        const x = p.x + s * SIDE, y = p.y - c * SIDE;
        if (this.signs.some((o) => Math.hypot(o.x - x, o.y - y) < MERGE && Math.cos(o.ang - p.ang) > 0)) continue;
        this.signs.push({ x, y, ang: p.ang, name: h.name, mesh: null, shown: false });
      }
    }
  }

  private build(sg: Sign) {
    const mesh = new THREE.Group();
    const post = new THREE.Mesh(postGeometry, postMaterial);
    post.castShadow = true;
    const top = new THREE.Mesh(topGeometry, topMaterial);
    top.position.y = 2.7;
    const plate = new THREE.Mesh(plateGeometry, nameMaterial(sg.name));
    plate.position.y = 2.35;
    plate.rotation.y = sg.ang;
    mesh.add(post, top, plate);
    return mesh;
  }

  // Only signs near the view are in the scene.
  sync(x: number, y: number, r: number, height: (x: number, y: number) => number) {
    for (const sg of this.signs) {
      const show = Math.abs(sg.x - x) < r && Math.abs(sg.y - y) < r;
      if (show !== sg.shown) {
        sg.shown = show;
        if (show) this.scene.add(sg.mesh ??= this.build(sg));
        else if (sg.mesh) this.scene.remove(sg.mesh);
      }
      if (show) sg.mesh!.position.set(sg.x, height(sg.x, sg.y), -sg.y);
    }
  }
}
