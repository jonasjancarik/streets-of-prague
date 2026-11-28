import * as THREE from 'three';
import { posts, fall, type Post } from './posts.ts';
import { looseFurniture } from './looseFurniture.ts';
import { POST_OWNER } from './map/furniture.ts';
import { crash } from './impacts.ts';
import type { Grid } from './map/geo.ts';

// The traffic signs' posts and the direction plates' and boards' posts, knocked over by a
// car like a lamp post (posts.ts): each is a post among the others, and hit harder than
// its `tough` it goes over the way the car was going. The grid cells it alone made solid
// are freed (looseFurniture.release), and its part of the tile's sign mesh (the post with
// its signs, or a board on two posts) is turned down about its foot in the mesh itself, so
// nothing more is drawn. A gantry over the road stays up. All of them stand again when
// their tile is made again.

// tough: m/s into it that knocks it over; give: the share of the car's speed it takes.
// A sign's thin steel tube goes at about 13 km/h; a direction board, with its plates, at 16.
const MAKES = [{ tough: 3.5, give: 0.06 }, { tough: 4.5, give: 0.12 }];
const REACH = 0.5; // m: the grid's cells round a post stop a car as far as this from it
const FALL_S = 1.2; // s it takes to come down (posts.ts's fall, with a little to spare)

// Coming down: which runs of the mesh's vertices (first, count, …), turned about `pivot`
// (three.js world), and those vertices as they stood.
interface Falling { tile: string; mesh: THREE.Mesh; runs: number[]; pivot: THREE.Vector3; post: Post; pos: Float32Array; nor: Float32Array; done: boolean }

const q = new THREE.Quaternion(), axis = new THREE.Vector3(), v = new THREE.Vector3();

class SignFalls {
  private byTile = new Map<string, Post[]>();
  private falling: Falling[] = [];

  // A tile's sign posts (the worker's signPosts: x, y, ground, mesh, part per post), its sign
  // and direction meshes, and its collision grid.
  addTile(tile: string, list: Float32Array | undefined, meshes: (THREE.Mesh | null)[], grid: Grid) {
    this.removeTile(tile);
    if (!list?.length) return;
    const own: Post[] = [];
    // The posts holding up each part (a board stands on two).
    const groups = new Map<number, { post: Post; owner: number }[]>();
    for (let k = 0, i = 0; i < list.length; i += 5, k++) {
      const x = list[i], y = list[i + 1], z = list[i + 2], m = list[i + 3], part = list[i + 4], mesh = meshes[m];
      const ranges = mesh?.userData.ranges as Float32Array | undefined;
      if (part < 0 || !mesh || !ranges) continue;
      const key = m * 1e6 + part, owner = POST_OWNER + k;
      const post: Post = {
        x, y, z, r: 0.06, reach: REACH, shades: false, ...MAKES[m], down: null,
        knocked: (p, speed) => {
          // Heard as a post bent over (src/soundmix.ts), softer than a lamp post.
          crash(p, null, speed * 0.6, 'post', p.x, p.y, 30);
          // Down with it, the other post of its part, and the cells of both freed.
          for (const g of groups.get(key)!) {
            if (g.post !== p && !g.post.down) g.post.down = p.down;
            looseFurniture.release(grid, g.owner);
          }
          this.start(tile, mesh, [ranges[part * 2], ranges[part * 2 + 1]], new THREE.Vector3(p.x, p.z, -p.y), p);
        },
      };
      const g = groups.get(key);
      if (g) g.push({ post, owner }); else groups.set(key, [{ post, owner }]);
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

  // A café's or bakery's chalkboard on the pavement (map/streetFacade.ts, drawn as part of its
  // wall close up): knocked over by a car at a walking pace, or run into on foot. `boards`:
  // the wall's FacadeGeometry.boards. It stands again when the wall is drawn again.
  addBoards(mesh: THREE.Mesh, boards: Float32Array) {
    const key = 'boards:' + mesh.uuid, own: Post[] = [];
    for (let i = 0; i < boards.length;) {
      const pivot = new THREE.Vector3(boards[i], boards[i + 1], boards[i + 2]), n = boards[i + 3];
      const runs = Array.from(boards.subarray(i + 4, i + 4 + n * 2));
      i += 4 + n * 2;
      const post: Post = { x: pivot.x, y: -pivot.z, z: pivot.y, r: 0.32, tough: 1.2, give: 0.02, shades: false, down: null,
        knocked: (p, speed) => {
          crash(p, null, speed * 0.5, 'timber', p.x, p.y, 12);
          this.start(key, mesh, runs, pivot, p);
        } };
      posts.add(post);
      own.push(post);
    }
    if (own.length) this.byTile.set(key, own);
  }
  // A wall's chalkboards gone with its close-up mesh.
  dropBoards(mesh: THREE.Mesh) { this.removeTile('boards:' + mesh.uuid); }

  private start(tile: string, mesh: THREE.Mesh, runs: number[], pivot: THREE.Vector3, post: Post) {
    const g = mesh.geometry, pos = g.attributes.position.array as Float32Array, nor = g.attributes.normal.array as Float32Array;
    let n = 0;
    for (let r = 0; r < runs.length; r += 2) n += runs[r + 1];
    const was = new Float32Array(n * 3), wasN = new Float32Array(n * 3);
    for (let r = 0, o = 0; r < runs.length; o += runs[r + 1] * 3, r += 2) {
      was.set(pos.subarray(runs[r] * 3, (runs[r] + runs[r + 1]) * 3), o);
      wasN.set(nor.subarray(runs[r] * 3, (runs[r] + runs[r + 1]) * 3), o);
    }
    this.falling.push({ tile, mesh, runs, pivot, post, pos: was, nor: wasN, done: false });
  }

  // Each falling one turned on down about the foot of the post that was hit.
  update(now = performance.now()) {
    if (!this.falling.length) return;
    for (const f of this.falling) {
      const p = f.post, down = p.down!, a = fall(p, now);
      // (The way it falls, in three.js's frame, and the level line across it it turns about.)
      axis.set(-Math.sin(down.ang), 0, -Math.cos(down.ang));
      q.setFromAxisAngle(axis, a);
      const g = f.mesh.geometry, position = g.attributes.position as THREE.BufferAttribute, normal = g.attributes.normal as THREE.BufferAttribute;
      const pos = position.array as Float32Array, nor = normal.array as Float32Array, px = f.pivot.x, py = f.pivot.y, pz = f.pivot.z;
      for (let r = 0, i = 0; r < f.runs.length; r += 2) {
        for (let o = f.runs[r] * 3, end = (f.runs[r] + f.runs[r + 1]) * 3; o < end; i += 3, o += 3) {
          v.set(f.pos[i] - px, f.pos[i + 1] - py, f.pos[i + 2] - pz).applyQuaternion(q);
          pos[o] = v.x + px; pos[o + 1] = v.y + py; pos[o + 2] = v.z + pz;
          v.set(f.nor[i], f.nor[i + 1], f.nor[i + 2]).applyQuaternion(q);
          nor[o] = v.x; nor[o + 1] = v.y; nor[o + 2] = v.z;
        }
        for (const attr of [position, normal]) attr.addUpdateRange(f.runs[r] * 3, f.runs[r + 1] * 3);
      }
      position.needsUpdate = normal.needsUpdate = true;
      f.done = now - down.t > FALL_S * 1000;
    }
    this.falling = this.falling.filter((f) => !f.done);
  }

  // (For tests: the chalkboards drawn near (x, y), standing or not.)
  boardsNear(x: number, y: number, r: number) {
    const out: Post[] = [];
    for (const [key, list] of this.byTile) if (key.startsWith('boards:')) for (const p of list) if (Math.hypot(p.x - x, p.y - y) < r) out.push(p);
    return out;
  }
  // (For tests: the standing sign posts within r m of (x, y) a car can knock over.)
  standingNear(x: number, y: number, r: number) {
    return posts.near(x, y, r).filter((p) => p.reach === REACH).map((p) => ({ x: p.x, y: p.y, z: p.z, tough: p.tough }));
  }
}

export const signFalls = new SignFalls();
