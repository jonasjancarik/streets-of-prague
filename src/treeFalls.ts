import * as THREE from 'three';
import { posts, fall, type Post } from './posts.ts';
import { looseFurniture } from './looseFurniture.ts';
import { crash } from './impacts.ts';
import { TREE_OWNER } from './map/furniture.ts';
import type { Grid } from './map/geo.ts';
import type { TreeInstances } from './map/vegetation.ts';

// Young and small trees a car can snap, and the shrubs it flattens (the tile worker picks
// them: tileWorker.ts, SNAPS):
// each is a post among the lamp posts (posts.ts), at its trunk. Hit harder than its
// `tough`, it snaps at the foot: the grid cells only its trunk held are freed
// (looseFurniture.release), and the whole tree, trunk and crown, turns down about its foot
// the way the car was going, by turning its instance matrix in the tile's trees and
// copying them into the tree pages again (TreePool.refresh). It lies there until its tile
// is made again. Big old trees stand whatever hits them.

// The tree pool's hook: copy a tile's trees into its pages again.
export interface TreeRefresh { refresh(tileKey: string): void }

interface Falling { tile: string; trees: TreeInstances; index: number; post: Post; matrix: THREE.Matrix4; pivot: THREE.Vector3; flat: boolean; done: boolean }

const FALL_S = 1.2; // s, posts.ts's fall with a little to spare
const q = new THREE.Quaternion(), axis = new THREE.Vector3(), m = new THREE.Matrix4(), m2 = new THREE.Matrix4(), turn = new THREE.Matrix4();

class TreeFalls {
  pool: TreeRefresh | null = null;
  private byTile = new Map<string, Post[]>();
  private falling: Falling[] = [];

  // A tile's breakable trees (the worker's breakableTrees: index, ground, tough, give,
  // reach, how it goes down each), its trees and its collision grid.
  addTile(tile: string, list: Float32Array | undefined, trees: TreeInstances, grid: Grid) {
    this.removeTile(tile);
    if (!list?.length) return;
    const own: Post[] = [];
    for (let i = 0; i < list.length; i += 6) {
      const index = list[i], ground = list[i + 1], at = index * 16, flat = list[i + 5] === 1;
      const x = trees.matrices[at + 12], y = -trees.matrices[at + 14];
      const post: Post = {
        x, y, z: ground, r: 0.12, reach: list[i + 4], tough: list[i + 2], give: list[i + 3], shades: false, down: null,
        knocked: (p, speed) => {
          // A trunk snapping: wood, heard well; a bush crushed, as a hedge is.
          crash(p, null, speed * (flat ? 0.5 : 0.8), flat ? 'hedge' : 'timber', p.x, p.y, flat ? 60 : 300);
          looseFurniture.release(grid, TREE_OWNER + index);
          this.falling.push({ tile, trees, index, post: p, matrix: new THREE.Matrix4().fromArray(trees.matrices, at), pivot: new THREE.Vector3(x, ground, -y), flat, done: false });
        },
      };
      posts.add(post);
      own.push(post);
    }
    this.byTile.set(tile, own);
  }

  removeTile(tile: string) {
    for (const p of this.byTile.get(tile) ?? []) posts.remove(p);
    this.byTile.delete(tile);
    this.falling = this.falling.filter((f) => f.tile !== tile);
  }

  // Each falling tree turned on down about its foot.
  update(now = performance.now()) {
    if (!this.falling.length) return;
    const tiles = new Set<string>();
    for (const f of this.falling) {
      const down = f.post.down!, a = fall(f.post, now);
      if (f.flat) {
        // A bush pressed down to a quarter of its height and spread a little.
        const k = a / (Math.PI / 2 - 0.06);
        m.makeScale(1 + 0.2 * k, 1 - 0.75 * k, 1 + 0.2 * k);
      } else {
        axis.set(-Math.sin(down.ang), 0, -Math.cos(down.ang));
        m.makeRotationFromQuaternion(q.setFromAxisAngle(axis, a));
      }
      // About the foot: there, turned (or pressed), and back.
      turn.makeTranslation(f.pivot.x, f.pivot.y, f.pivot.z).multiply(m).multiply(m2.makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z));
      m.multiplyMatrices(turn, f.matrix).toArray(f.trees.matrices, f.index * 16);
      tiles.add(f.tile);
      f.done = now - down.t > FALL_S * 1000;
    }
    for (const t of tiles) this.pool?.refresh(t);
    this.falling = this.falling.filter((f) => !f.done);
  }

  // (For tests: the trees standing within r m of (x, y) a car could snap.)
  standingNear(x: number, y: number, r: number) {
    const out: { x: number; y: number; z: number; tough: number; reach: number }[] = [];
    for (const list of this.byTile.values()) for (const p of list) if (!p.down && Math.hypot(p.x - x, p.y - y) < r) out.push({ x: p.x, y: p.y, z: p.z, tough: p.tough, reach: p.reach! });
    return out;
  }
  // (For tests: whether the tree at (x, y) is down.)
  downAt(x: number, y: number) {
    for (const list of this.byTile.values()) for (const p of list) if (Math.hypot(p.x - x, p.y - y) < 0.05) return !!p.down;
    return false;
  }
}

export const treeFalls = new TreeFalls();
