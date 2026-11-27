import type * as THREE from 'three';
import type { LifeSize as Avatars } from './rocketbox.ts';
import type { FootGround } from './playerFooting.ts';

// First person's life-size people (rocketbox.ts), fetched only when someone looks from the
// street: the code (with its texture and mesh decoders) the first time first person is on,
// the avatars right after. A while back in the view from above, they're let go again, and
// the next look from the street loads them anew (from the browser's cache by then).
// A game that opens in a street view starts on them while the map loads (preload).

export class LifeSize {
  footGround?: FootGround;
  enabled = true;
  playerSeed?: number;
  freeAfter = 120; // seconds out of first person (shorter in tests)
  // Compiles an object's shaders (renderer.compileAsync): the street crowd's batches are
  // compiled with it before anyone is drawn in them, however the game was opened.
  compile?: (o: THREE.Object3D) => Promise<unknown>;
  private avatars: Avatars | null = null;
  private importing = false;
  private since = performance.now(); // when first person was last on

  private preloading: Promise<Avatars | null> | null = null;

  constructor(private scene: THREE.Scene, private renderer: unknown) {}

  private open() {
    this.importing = true;
    return this.preloading ??= import('./rocketbox.ts').then(
      (m) => {
        this.avatars = new m.LifeSize(this.scene, this.renderer, this.playerSeed);
        this.avatars.middle.compile = this.compile;
        return this.avatars;
      },
      (e) => { console.warn('Life-size people could not load', e); return null; },
    ).finally(() => { this.importing = false; this.preloading = null; });
  }

  // Before the game opens in first or third person: your own avatar and the clips now,
  // the rest of the crowd once `crowdAfter` settles (the map has loaded). Settles when
  // your avatar is in, or couldn't load.
  async preload(crowdAfter: Promise<unknown>) {
    if (!this.enabled) return;
    this.since = performance.now();
    const avatars = this.avatars ?? await this.open();
    await avatars?.preload(crowdAfter);
  }

  // The avatars' shaders, compiled before they're first seen (after preload).
  warm(compile: (o: THREE.Object3D) => Promise<unknown>) {
    return this.avatars?.warm(compile).catch((e) => console.warn('Life-size people', e));
  }

  frame(dt: number, eyes: boolean, camera: THREE.Camera) {
    const wanted = eyes && this.enabled;
    // (By the clock, not the game's time: a pause in a menu counts too.)
    const now = performance.now();
    if (wanted) this.since = now;
    if (wanted && !this.avatars && !this.importing) void this.open();
    if (!this.avatars) return;
    if (now - this.since > this.freeAfter * 1000 && this.avatars.idle) {
      this.avatars.dispose();
      this.avatars = null;
      return;
    }
    this.avatars.frame(dt, wanted, camera, this.footGround);
  }

  // (For scripts: whether the avatars are in memory now.)
  get loaded() { return !!this.avatars; }
}
