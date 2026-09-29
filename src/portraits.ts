// The illustrated layer: the loading screen and conversations with characters.
//
// Portraits are cut from generated sheets (assets/portraits/cut.py) and the skylines
// drawn from the 3D city (pipeline/skyline.py). A portrait's panel ends in hard cut
// edges at the sides and bottom, so it is always shown with something over them: on
// the loading screen slanted shapes in the colours of a constructivist poster, in a
// conversation a frame the head rises out of.

export const SKYLINES = ['hradcany', 'stare-mesto', 'zizkov', 'jizni-mesto'];

// Who can turn up on the loading screen (ids in public/portraits/cast.json).
const POSTER_CAST = [
  'marek', 'courier', 'veteran', 'tattooed', 'drifter', 'rocker', 'conductor', 'foreman', 'bouncer',
  'mechanic', 'barmaid', 'grandma', 'punk', 'inspector', 'hacker', 'boss', 'lawyer', 'journalist',
  'policewoman', 'detective', 'paramedic', 'guard',
];

// Portraits too alike to stand side by side (the same curly hair, glasses and stubble).
const ALIKE = [['journalist', 'hacker']];

const pick = <T>(list: T[], n: number): T[] => {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const one = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    if (ALIKE.some((g) => (g as unknown[]).includes(one) && out.some((o) => (g as unknown[]).includes(o)))) continue;
    out.push(one);
  }
  return out;
};

const el = (tag: string, className: string, parent?: HTMLElement): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
};

const portrait = (id: string, parent: HTMLElement): HTMLImageElement => {
  const img = el('img', 'portrait', parent) as HTMLImageElement;
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('load', () => img.classList.add('in'), { once: true });
  img.src = `portraits/${id}.webp`;
  return img;
};

// Dresses the loading screen: a skyline, three characters and the shapes over their
// edges. The status line (#loading-text) stays where main.ts writes to it.
export function dressLoading(root: HTMLElement) {
  const sky = el('div', 'ls-sky', root);
  sky.style.backgroundImage = `url(skylines/${pick(SKYLINES, 1)[0]}.webp)`;
  el('div', 'ls-wedge', root);
  const cast = el('div', 'ls-cast', root);
  for (const id of pick(POSTER_CAST, 3)) portrait(id, el('div', 'ls-face', cast));
  el('div', 'ls-stripe', root);
  el('div', 'ls-band', root);
  const title = el('div', 'ls-title', root);
  title.innerHTML = '<span>Streets</span><span>of Prague</span>';
  const status = root.querySelector('#loading-text');
  if (status) root.appendChild(status);
}

export interface Line {
  who: string; // portrait id
  name: string;
  text: string;
  objective?: string;
}

// A conversation: one line at a time at the bottom of the screen, E (or a tap) for the
// next. Takes the keys while it's up, like the metro screen.
export class Dialog {
  root: HTMLElement;
  lines: Line[] = [];
  done: (() => void) | null = null;

  constructor() {
    this.root = el('div', 'dlg');
    this.root.hidden = true;
    this.root.addEventListener('pointerup', () => this.next());
    document.body.appendChild(this.root);
  }

  get active() { return !this.root.hidden; }

  play(lines: Line[]): Promise<void> {
    this.lines = [...lines];
    return new Promise((resolve) => {
      this.done = resolve;
      this.next();
    });
  }

  key(code: string) {
    if (code === 'KeyE' || code === 'Enter' || code === 'Space') this.next();
  }

  next() {
    const line = this.lines.shift();
    if (!line) {
      this.root.hidden = true;
      document.body.classList.remove('talking');
      this.done?.();
      this.done = null;
      return;
    }
    const r = this.root;
    r.replaceChildren();
    const frame = el('div', 'dlg-frame', r);
    el('div', 'dlg-sky', frame).style.backgroundImage = `url(skylines/${SKYLINES[0]}.webp)`;
    portrait(line.who, frame);
    const body = el('div', 'dlg-body', r);
    el('div', 'dlg-name', body).textContent = line.name;
    el('p', 'dlg-text', body).textContent = line.text;
    if (line.objective) {
      const goal = el('div', 'dlg-goal', body);
      el('b', '', goal).textContent = 'New objective';
      el('span', '', goal).textContent = line.objective;
    }
    const more = this.lines.length > 0;
    el('div', 'dlg-next', body).innerHTML = document.body.classList.contains('touch')
      ? (more ? 'Tap for more' : 'Tap to continue')
      : (more ? '<kbd>E</kbd> Next' : '<kbd>E</kbd> Continue');
    r.hidden = false;
    document.body.classList.add('talking');
  }
}
