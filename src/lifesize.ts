import type * as THREE from 'three';
import type { LifeSize as Avatars } from './rocketbox.ts';

// First person's life-size people (rocketbox.ts), fetched only when someone looks from the
// street: the code (with its texture and mesh decoders) the first time first person is on,
// the avatars right after. A while back in the view from above, they're let go again, and
// the next look from the street loads them anew (from the browser's cache by then).

export class LifeSize {
  enabled = true;
  freeAfter = 120; // seconds out of first person (shorter in tests)
  private avatars: Avatars | null = null;
  private importing = false;
  private since = performance.now(); // when first person was last on

  constructor(private scene: THREE.Scene, private renderer: unknown) {}

  frame(dt: number, eyes: boolean, camera: THREE.Camera) {
    const wanted = eyes && this.enabled;
    // (By the clock, not the game's time: a pause in a menu counts too.)
    const now = performance.now();
    if (wanted) this.since = now;
    if (wanted && !this.avatars && !this.importing) {
      this.importing = true;
      void import('./rocketbox.ts').then(
        (m) => { this.avatars = new m.LifeSize(this.scene, this.renderer); },
        (e) => console.warn('Life-size people could not load', e),
      ).finally(() => { this.importing = false; });
    }
    if (!this.avatars) return;
    if (now - this.since > this.freeAfter * 1000 && this.avatars.idle) {
      this.avatars.dispose();
      this.avatars = null;
      return;
    }
    this.avatars.frame(dt, wanted, camera);
  }

  // (For scripts: whether the avatars are in memory now.)
  get loaded() { return !!this.avatars; }
}
