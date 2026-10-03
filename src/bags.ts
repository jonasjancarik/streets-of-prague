import * as THREE from 'three';
import { boxGeometry } from './car.ts';

// A delivery courier's bag, once its courier has been knocked or pushed off the bike:
// it lies where it fell until someone picks it up (or a few minutes pass), and then
// rides on the back of whoever carries it. It is only a picture: nothing collides
// with it, so cars and trams drive straight over.
const LIFE = 180; // s on the ground before it is gone
const FAR = 150; // m from the player, past which it is gone
const FADE = 3; // s it takes to sink out of sight at the end
export const REACH = 2; // m from a walker's feet

interface Bag { x: number; y: number; colour: string; age: number; mesh: THREE.Mesh }

const material = new THREE.MeshLambertMaterial({ vertexColors: true });
const lying = new Map<string, THREE.BufferGeometry>();
const onBack = new Map<string, THREE.BufferGeometry>();
const shape = (cache: Map<string, THREE.BufferGeometry>, kind: string, colour: string) => {
  let g = cache.get(colour);
  if (!g) cache.set(colour, g = boxGeometry(kind, colour));
  return g;
};

export class Bags {
  scene: THREE.Scene;
  height: (x: number, y: number) => number;
  list: Bag[] = [];
  // The one the player carries (its colour), drawn on their back.
  carried: string | null = null;
  back: THREE.Mesh;

  constructor(scene: THREE.Scene, height: (x: number, y: number) => number) {
    this.scene = scene;
    this.height = height;
    this.back = new THREE.Mesh(shape(onBack, 'foot', '#d70f64'), material);
    this.back.castShadow = true;
    this.back.visible = false;
  }

  // Lie on the ground at (x, y).
  drop(x: number, y: number, colour: string, h = 0) {
    const mesh = new THREE.Mesh(shape(lying, 'ground', colour), material);
    mesh.castShadow = true;
    mesh.position.set(x, this.height(x, y), -y);
    mesh.rotation.y = h;
    this.scene.add(mesh);
    this.list.push({ x, y, colour, age: 0, mesh });
  }

  near(x: number, y: number, r = REACH) {
    let best: Bag | null = null, bestD = r;
    for (const b of this.list) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best && { bag: best, d: bestD };
  }

  remove(b: Bag) {
    this.scene.remove(b.mesh);
    this.list.splice(this.list.indexOf(b), 1);
  }

  // Pick it up: it goes on your back.
  take(b: Bag) {
    this.remove(b);
    this.carry(b.colour);
  }

  carry(colour: string | null) {
    this.carried = colour;
    this.back.visible = !!colour;
    if (colour) this.back.geometry = shape(onBack, 'foot', colour);
  }

  // Put it down at (x, y).
  putDown(x: number, y: number, h: number) {
    if (!this.carried) return;
    this.drop(x, y, this.carried, h);
    this.carry(null);
  }

  update(dt: number, px: number, py: number) {
    for (const b of [...this.list]) {
      b.age += dt;
      if (b.age > LIFE + FADE || Math.hypot(b.x - px, b.y - py) > FAR) { this.remove(b); continue; }
      const left = LIFE + FADE - b.age;
      b.mesh.position.y = this.height(b.x, b.y) - (left < FADE ? (1 - left / FADE) * 0.5 : 0);
    }
  }
}
