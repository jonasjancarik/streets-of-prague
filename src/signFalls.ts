import * as THREE from 'three';
import { posts, type Post } from './posts.ts';
import { looseFurniture } from './looseFurniture.ts';
import { POST_OWNER } from './map/furniture.ts';
import { crash } from './impacts.ts';
import type { Grid } from './map/geo.ts';

// The traffic signs' posts and the direction plates' and boards' posts, knocked over by a
// car like a lamp post (posts.ts): each is a post among the others, and hit harder than
// its `tough` it goes over the way the car was going. The grid cells it alone made solid
// are freed (looseFurniture.release), and its part of the tile's sign mesh (the post with
// its signs, or a board on two posts) becomes a loose body (looseFurniture.launch): it's
// thrown, tumbles and comes to rest however it lands, and can be shoved on, and its
// vertices in the mesh itself are moved with it, so nothing more is drawn. A gantry over
// the road stays up. All of them stand again when their tile is made again.

// tough: m/s into it that knocks it over; give: the share of the car's speed it takes.
// A sign's thin steel tube goes at about 13 km/h; a direction board, with its plates, at 16.
// mass: kg, once it's loose (a steel tube with its plates; a board on two posts).
const MAKES = [{ tough: 3.5, give: 0.06, mass: 25 }, { tough: 4.5, give: 0.12, mass: 60 }];
const BOARD_MASS = 8; // kg, a café's chalkboard
const REACH = 0.5; // m: the grid's cells round a post stop a car as far as this from it

const v = new THREE.Vector3(), turn = new THREE.Matrix3();
const grown = new WeakSet<THREE.Mesh>();

class SignFalls {
  private byTile = new Map<string, Post[]>();

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
        x, y, z, r: 0.06, reach: REACH, shades: false, tough: MAKES[m].tough, give: MAKES[m].give, down: null,
        knocked: (p, speed) => {
          // Heard as a post bent over (src/soundmix.ts), softer than a lamp post.
          crash(p, null, speed * 0.6, 'post', p.x, p.y, 30);
          // Down with it, the other post of its part, and the cells of both freed.
          for (const g of groups.get(key)!) {
            if (g.post !== p && !g.post.down) g.post.down = p.down;
            looseFurniture.release(grid, g.owner);
          }
          this.start(tile, mesh, [ranges[part * 2], ranges[part * 2 + 1]], p, speed, MAKES[m].mass, 'post');
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
    looseFurniture.dropBodies(tile); // (what of them lies loose: drawn in meshes that go with it)
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
          this.start(key, mesh, runs, p, speed, BOARD_MASS, 'timber');
        } };
      posts.add(post);
      own.push(post);
    }
    if (own.length) this.byTile.set(key, own);
  }
  // A wall's chalkboards gone with its close-up mesh.
  dropBoards(mesh: THREE.Mesh) { this.removeTile('boards:' + mesh.uuid); }

  // Its vertices (`runs` of the mesh's: first, count, …) as they stood, a box round them,
  // and a body thrown from there by the blow, that moves them as it goes.
  private start(tile: string, mesh: THREE.Mesh, runs: number[], post: Post, speed: number, mass: number, sound: 'post' | 'timber') {
    const g = mesh.geometry, position = g.attributes.position as THREE.BufferAttribute, normal = g.attributes.normal as THREE.BufferAttribute;
    const pos = position.array as Float32Array, nor = normal.array as Float32Array;
    let n = 0;
    for (let r = 0; r < runs.length; r += 2) n += runs[r + 1];
    const was = new Float32Array(n * 3), wasN = new Float32Array(n * 3);
    for (let r = 0, o = 0; r < runs.length; o += runs[r + 1] * 3, r += 2) {
      was.set(pos.subarray(runs[r] * 3, (runs[r] + runs[r + 1]) * 3), o);
      wasN.set(nor.subarray(runs[r] * 3, (runs[r] + runs[r + 1]) * 3), o);
    }
    const box = new THREE.Box3();
    for (let i = 0; i < n * 3; i += 3) box.expandByPoint(v.set(was[i], was[i + 1], was[i + 2]));
    const middle = box.getCenter(new THREE.Vector3()), half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(v.set(0.05, 0.05, 0.05));
    // (A piece thrown off its spot mustn't be culled with the mesh's old bounds.)
    if (!grown.has(mesh)) { grown.add(mesh); if (!g.boundingSphere) g.computeBoundingSphere(); g.boundingSphere!.radius += 30; }
    looseFurniture.launch({
      tile, from: [post.x, post.y], middle, half, mass, sound, ground: Number.isFinite(post.z) ? post.z : box.min.y, ang: post.down!.ang, speed,
      put: (moved) => {
        turn.setFromMatrix4(moved);
        for (let r = 0, i = 0; r < runs.length; r += 2) {
          for (let o = runs[r] * 3, end = (runs[r] + runs[r + 1]) * 3; o < end; i += 3, o += 3) {
            v.set(was[i], was[i + 1], was[i + 2]).applyMatrix4(moved);
            pos[o] = v.x; pos[o + 1] = v.y; pos[o + 2] = v.z;
            v.set(wasN[i], wasN[i + 1], wasN[i + 2]).applyMatrix3(turn);
            nor[o] = v.x; nor[o + 1] = v.y; nor[o + 2] = v.z;
          }
          position.addUpdateRange(runs[r] * 3, runs[r + 1] * 3); normal.addUpdateRange(runs[r] * 3, runs[r + 1] * 3);
        }
        position.needsUpdate = normal.needsUpdate = true;
      },
    });
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
