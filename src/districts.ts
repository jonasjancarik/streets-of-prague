import { dataUrl } from './data.ts';
// The part of town you're in (data/<area>_now/districts.json, from
// pipeline/build_districts.py: Smíchov, Malá Strana, Vinohrady… the cadastral areas,
// which tile the city without gaps). Walk, drive or ride into another one and its name
// comes up as a title, once at the start too. Without the file there are no titles.
//
// Checked twice a second, the part you were last in first. A new part only counts once
// you're well inside it, and a name that was just shown isn't shown again soon, so going
// back and forth along a street on the boundary doesn't keep bringing titles up.

interface District { name: string; box: [number, number, number, number]; rings: number[][] }

const EVERY = 0.5; // s between checks
const DEPTH = 30; // m inside a new part before it counts
const AGAIN = 90; // s before the same name comes up again
const FIRST = 1.5; // s after the start before the first title

function inside(d: District, x: number, y: number): boolean {
  const [x0, y0, x1, y1] = d.box;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  let odd = false;
  for (const r of d.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < r[j] + ((y - yj) / (yi - yj)) * (r[i] - r[j])) odd = !odd;
    }
  }
  return odd;
}

// Whether (x, y) is at least `min` metres from every edge of d.
function deep(d: District, x: number, y: number, min: number): boolean {
  const m2 = min * min;
  for (const r of d.rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const ax = r[j], ay = r[j + 1], dx = r[i] - ax, dy = r[i + 1] - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      if (ex * ex + ey * ey < m2) return false;
    }
  }
  return true;
}

export class Districts {
  private list: District[] = [];
  private current: District | null = null;
  private pending: string | null = null;
  private wait = FIRST;
  private shownAt = new Map<string, number>();
  private time = 0;

  private el: HTMLElement;
  // The name of the place at (x, y) where no part of town is: past the city, the town or
  // village from the countryside's map (main.ts). Without it there are no titles there.
  elsewhere: ((x: number, y: number) => string | null) | null = null;
  private place: string | null = null;

  constructor(area: string, el: HTMLElement) {
    this.el = el;
    fetch(dataUrl(area, 'districts.json'))
      .then(async (r) => { if (r.ok) this.list = ((await r.json()) as { districts: District[] }).districts ?? []; })
      .catch(() => {});
  }

  // The part of town at (x, y), or null outside them all.
  at(x: number, y: number): District | null {
    if (this.current && inside(this.current, x, y)) return this.current;
    return this.list.find((d) => d !== this.current && inside(d, x, y)) ?? null;
  }

  // `busy`: something else has the middle of the screen (a banner, the metro); the title
  // waits for it to go.
  update(dt: number, x: number, y: number, busy: boolean) {
    this.time += dt;
    this.wait -= dt;
    if (this.wait > 0 || (!this.list.length && !this.elsewhere)) return;
    this.wait = EVERY;
    const d = this.at(x, y);
    if (d && d !== this.current && (!this.current || deep(d, x, y, DEPTH))) {
      this.current = d;
      this.place = null;
      const last = this.shownAt.get(d.name);
      this.pending = last !== undefined && this.time - last < AGAIN ? null : d.name;
    }
    // Outside every part of town: the town or village, as a title when it changes.
    const name = d || !this.elsewhere ? null : this.elsewhere(x, y);
    if (name && name !== this.place) {
      this.place = name;
      this.current = null;
      const last = this.shownAt.get(name);
      this.pending = last !== undefined && this.time - last < AGAIN ? null : name;
    }
    if (this.pending && !busy) {
      this.shownAt.set(this.pending, this.time);
      this.el.textContent = this.pending;
      this.el.classList.remove('on');
      void this.el.offsetWidth; // start the fade again
      this.el.classList.add('on');
      this.pending = null;
    }
  }

  // Hide the title at once (e.g. going down into the metro).
  hide() { this.el.classList.remove('on'); }
}
