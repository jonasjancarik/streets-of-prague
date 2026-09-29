import { t } from './i18n.ts';
// The illustrated layer: the loading screen and conversations with characters.
//
// Portraits are cut from generated sheets (assets/portraits/cut.py) and the skylines
// drawn from the 3D city (pipeline/skyline.py). A portrait's panel ends in hard cut
// edges at the sides and bottom, so it is always shown with something over them: on
// the loading screen slanted shapes in the colours of a constructivist poster, in a
// conversation a frame the head rises out of.

export const SKYLINES = ['hradcany', 'stare-mesto', 'zizkov', 'jizni-mesto'];
// Where each skyline's landmark stands in its picture, as fractions of it (the tip's x,
// the tip, the foot, its left and right edge): written by pipeline/skyline.py. Jižní
// Město has none to show off.
interface Mark { x: number; top: number; base: number; left: number; right: number }
const SKY_SIZE = [2560, 1440];
const marks: Promise<Record<string, Mark>> = fetch('skylines/skylines.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
// The dark wedge's right edge, as a share of the width, at the top and the bottom (index.html).
const WEDGE = [0.46, 0.36];

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
  const skyline = pick(SKYLINES, 1)[0];
  sky.style.backgroundImage = `url(skylines/${skyline}.webp)`;
  el('div', 'ls-wedge', root);
  const cast = el('div', 'ls-cast', root);
  for (const id of pick(POSTER_CAST, 3)) portrait(id, el('div', 'ls-face', cast));
  // Grow and slide the skyline so its landmark stands tall in the open, its tip near
  // the top and its left side just clear of the dark wedge. The picture always covers
  // the top and the sides; its foot may go under the red band.
  let mark: Mark | undefined;
  const place = () => {
    if (!mark) return;
    const w = root.clientWidth, h = root.clientHeight, sw = sky.offsetWidth;
    const [IW, IH] = SKY_SIZE;
    const tipY = h * 0.1, footY = h * 0.82;
    const edge = w * (WEDGE[0] + (WEDGE[1] - WEDGE[0]) * 0.1); // at the tip's height
    const x = edge + w * 0.02 - sky.offsetLeft; // where its left side goes
    const scale = Math.max(
      sw / IW, h / IH, // cover
      tipY / (mark.top * IH), // nothing uncovered above
      (footY - tipY) / ((1 - mark.top) * IH), // nor below, down to the band
      x / (mark.left * IW), (sw - x) / ((1 - mark.left) * IW), // nor at the sides
    );
    sky.style.backgroundSize = `${IW * scale}px ${IH * scale}px`;
    sky.style.backgroundPosition = `${x - mark.left * IW * scale}px ${tipY - mark.top * IH * scale}px`;
  };
  void marks.then((all) => { mark = all[skyline]; place(); });
  addEventListener('resize', place);
  el('div', 'ls-stripe', root);
  el('div', 'ls-band', root);
  const title = el('div', 'ls-title', root);
  title.innerHTML = '<span data-t>Streets</span><span data-t>of Prague</span>';
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
      el('b', '', goal).textContent = t('New objective');
      el('span', '', goal).textContent = line.objective;
    }
    const more = this.lines.length > 0;
    el('div', 'dlg-next', body).innerHTML = document.body.classList.contains('touch')
      ? t(more ? 'Tap for more' : 'Tap to continue')
      : `<kbd>E</kbd> ${t(more ? 'Next' : 'Continue')}`;
    r.hidden = false;
    document.body.classList.add('talking');
  }
}
