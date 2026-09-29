import { t } from './i18n.ts';
// The illustrated layer: the loading screen and conversations with characters.
//
// Portraits are cut from generated sheets (assets/portraits/cut.py) and the skylines
// drawn from the 3D city (pipeline/skyline.py). A portrait's panel ends in hard cut
// edges at the sides and bottom, so it is always shown with something over them: on
// the loading screen slanted shapes in the colours of a constructivist poster, in a
// conversation a frame the head rises out of.

export const SKYLINES = ['hradcany', 'stare-mesto', 'zizkov', 'jizni-mesto'];
// Where each skyline's landmark stands in its picture (fractions of 1920 × 1080): the
// cathedral, Týn, the television tower. Jižní Město has none to show off.
const LANDMARK: Record<string, [number, number] | undefined> = { hradcany: [0.49, 0.45], 'stare-mesto': [0.54, 0.55], zizkov: [0.51, 0.4] };
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
  const faces = pick(POSTER_CAST, 3).map((id) => portrait(id, el('div', 'ls-face', cast)));
  // Slide the skyline so its landmark stands in the open between the dark wedge and
  // the first figure, rather than behind them.
  const place = () => {
    const at = LANDMARK[skyline];
    if (!at) return;
    const w = root.clientWidth, h = root.clientHeight, sw = sky.offsetWidth;
    const cover = Math.max(sw / 1920, h / 1080);
    const yAt = (scale: number) => (h - 1080 * scale) * 0.7 + at[1] * 1080 * scale; // background-position-y: 70%
    const edge = w * (WEDGE[0] + (WEDGE[1] - WEDGE[0]) * Math.min(1, Math.max(0, yAt(cover) / h)));
    const left = cast.getBoundingClientRect().left;
    const x = Math.max(edge + w * 0.02, (edge + left) / 2) - sky.offsetLeft;
    // Wider than covering when that's what it takes to bring the landmark there
    // without uncovering an edge.
    const iw = Math.max(1920 * cover, x / at[0], (sw - x) / (1 - at[0]));
    sky.style.backgroundSize = `${iw}px auto`;
    sky.style.backgroundPosition = `${x - at[0] * iw}px 70%`;
  };
  place();
  for (const img of faces) img.addEventListener('load', place, { once: true });
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
