import * as THREE from 'three';
import { posts, fall, type Post } from './posts.ts';
import { looseFurniture } from './looseFurniture.ts';
import { crash } from './impacts.ts';
import { TREE_OWNER } from './map/furniture.ts';
import type { Grid } from './map/geo.ts';
import type { TreeInstances } from './map/vegetation.ts';

// Young and small trees a car can snap (the tile worker picks them: tileWorker.ts, SNAPS):
// each is a post among the lamp posts (posts.ts), at its trunk. Hit harder than its
// `tough`, it snaps at the foot: the grid cells only its trunk held are freed
// (looseFurniture.release), and the whole tree, trunk and crown, turns down about its foot
// the way the car was going, by turning its instance matrix in the tile's trees and
// copying them into the tree pages again (TreePool.refresh). It lies there until its tile
// is made again. Big old trees stand whatever hits them.

// The tree pool's hook: copy a tile's trees into its pages again.
export interface TreeRefresh { refresh(tileKey: string): void }

interface Falling { tile: string; trees: TreeInstances; index: number; post: Post; matrix: THREE.Matrix4; pivot: THREE.Vector3; done: boolean }

const FALL_S = 1.2; // s, posts.ts's fall with a little to spare
const q = new THREE.Quaternion(), axis = new THREE.Vector3(), m = new THREE.Matrix4(), turn = new THREE.Matrix4();

class TreeFalls {
  pool: TreeRefresh | null = null;
  private byTile = new Map<string, Post[]>();
  private falling: Falling[] = [];

  // A tile's breakable trees (the worker's breakableTrees: index, ground, tough, give,
  // reach each), its trees and its collision grid.
  addTile(tile: string, list: Float32Array | undefined, trees: TreeInstances, grid: Grid) {
    this.removeTile(tile);
    if (!list?.length) return;
    const own: Post[] = [];
    for (let i = 0; i < list.length; i += 5) {
      const index = list[i], ground = list[i + 1], at = index * 16;
      const x = trees.matrices[at + 12], y = -trees.matrices[at + 14];
      const post: Post = {
        x, y, z: ground, r: 0.12, reach: list[i + 4], tough: list[i + 2], give: list[i + 3], shades: false, down: null,
        knocked: (p, speed) => {
          // A trunk snapping: wood, heard well.
          crash(p, null, speed * 0.8, 'timber', p.x, p.y, 300);
          looseFurniture.release(grid, TREE_OWNER + index);
          this.falling.push({ tile, trees, index, post: p, matrix: new THREE.Matrix4().fromArray(trees.matrices, at), pivot: new THREE.Vector3(x, ground, -y), done: false });
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
      const down = f.post.down!;
      axis.set(-Math.sin(down.ang), 0, -Math.cos(down.ang));
      q.setFromAxisAngle(axis, fall(f.post, now));
      // About the foot: there, turned, and back.
      turn.makeTranslation(f.pivot.x, f.pivot.y, f.pivot.z).multiply(m.makeRotationFromQuaternion(q)).multiply(m.makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z));
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
