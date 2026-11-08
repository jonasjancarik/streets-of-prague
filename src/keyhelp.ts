import { t, onLang } from './i18n.ts';

// The keyboard's controls card: a cut-out of the left of a keyboard with the keys for
// what you're doing right now lit up, each with a word or two under it. Hovering a lit
// key gives the full sentence. The game controller has its own card (#help-pad in
// index.html).

export type HelpMode = 'foot' | 'car' | 'drive' | 'tram' | 'funicular' | 'ferry' | 'heli';
export interface HelpState { mode: HelpMode; gun: boolean; fire: boolean; two: boolean }

// [label under the key, what it does in full]
type Use = [string, string];
type Keys = Partial<Record<string, Use>>;

// Rows of the cut-out, each at its offset in key widths, as on a real keyboard.
const ROWS: [number, string[]][] = [
  [0.5, ['Q', 'W', 'E', 'R', 'T', 'Y', 'U']],
  [0.75, ['A', 'S', 'D', 'F', 'G', 'H', 'J']],
  [1.3, ['Z', 'X', 'C', 'V', 'B', 'N', 'M']],
];

function keysFor(s: HelpState): { title: string; keys: Keys; note?: string } {
  switch (s.mode) {
    case 'foot': return {
      title: 'On foot',
      keys: {
        W: ['walk', 'Walk forwards and back'], S: ['back', 'Walk forwards and back'],
        A: ['left', 'Turn'], D: ['right', 'Turn'],
        Shift: ['run', 'Run'], Space: ['jump', 'Jump'],
        E: ['get in', 'Get into the nearest car, onto a bike or motorbike, or onto a tram at a stop'],
        T: ['taxi', 'Get a taxi: wave one down or order one through an app'],
        J: ['jobs', 'Jobs: ask for work, take the job on offer, or give one up'],
        N: ['map', 'Map: pick where to drive, and the way there shows on the road'],
        ...(s.gun ? { F: ['shoot', 'Shoot ahead, or where you click (hold it to keep shooting). Bullets never hit people'] as Use } : {}),
      },
    };
    case 'car': return {
      title: 'Driving',
      keys: {
        W: ['gas', 'Gas and brake, hold S to reverse'], S: ['brake', 'Gas and brake, hold S to reverse'],
        A: ['left', 'Steer'], D: ['right', 'Steer'],
        Space: ['handbrake', 'Handbrake'],
        Shift: ['lane assist', 'Hold to keep to the lane and the speed limit, while A and D pick the next turn. With directions on, it follows them'],
        Q: ['horn', 'Horn (hold it)'],
        ...(s.fire ? { F: ['water', 'Water cannon of a fire engine (hold it)'] as Use } : {}),
        ...(s.two ? {} : { R: ['radio', 'Radio: next station, and off (or use the buttons under the speed)'] as Use }),
        N: ['map', 'Map: pick where to drive, and the way there shows on the road'],
        E: [s.two ? 'get off' : 'get out', 'Get out, or off a bike'],
      },
    };
    case 'drive': return {
      title: 'Driving the tram',
      keys: {
        W: ['go', 'Pull away and brake'], S: ['brake', 'Pull away and brake'],
        Space: ['brake hard', 'Brake hard'],
        A: ['left', 'Pick the way at the next junction (straight on if you don\'t)'], D: ['right', 'Pick the way at the next junction (straight on if you don\'t)'],
        Q: ['bell', 'Ring the bell'],
        X: ['doors', 'Open and close the doors at a stop (people get off and on)'],
        E: ['get off', 'Get off once it has stopped'],
      },
    };
    case 'tram': return {
      title: 'On the tram',
      keys: {
        W: ['sooner', 'Pick where to get off'], S: ['later', 'Pick where to get off'],
        Shift: ['faster', 'Speed up the ride'],
        E: ['get off', 'Get off at the next stop'],
        F: ['drive', 'Take over the tram and drive it yourself'],
      },
    };
    case 'funicular': return {
      title: 'On the funicular',
      keys: { Shift: ['faster', 'Speed up the ride'], E: ['get off', 'Get off while it stands at a station'] },
    };
    case 'ferry': return {
      title: 'On the ferry',
      keys: { Shift: ['faster', 'Speed up the crossing'], E: ['get off', 'Get off onto the bank when it reaches a landing'] },
      note: 'The ferry takes a PID ticket, like a tram.',
    };
    case 'heli': return {
      title: 'Flying',
      keys: {
        W: ['ahead', 'Fly forwards and back'], S: ['back', 'Fly forwards and back'],
        A: ['left', 'Turn'], D: ['right', 'Turn'],
        Space: ['climb', 'Climb and come down'], Shift: ['down', 'Climb and come down'],
        E: ['get out', 'Get out, once landed on open ground'],
      },
    };
  }
}

// The word under a key, looked up as 'key: …' so it can be shorter than the same word elsewhere.
const word = (en: string) => { const s = t(`key: ${en}`); return s.startsWith('key: ') ? en : s; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function key(name: string, x: number, row: number, use: Use | undefined, cls = '') {
  const lit = use ? ' on' : '';
  const tip = use ? ` title="${esc(t(use[1]))}"` : '';
  const label = use ? `<span class="lbl">${esc(word(use[0]))}</span>` : '';
  return `<div class="k${lit}${cls}" style="--x:${x};--y:${row}"${tip}><kbd>${name}</kbd>${label}</div>`;
}

function render(card: HTMLElement, s: HelpState) {
  const { title, keys, note } = keysFor(s);
  let kb = '';
  ROWS.forEach(([x0, row], y) => row.forEach((k, i) => { kb += key(k, x0 + i, y, keys[k]); }));
  kb += key('Shift', 0, 2, keys.Shift, ' wide');
  // The space bar is long enough to carry its label inside.
  const space = keys.Space;
  kb += `<div class="k space${space ? ' on' : ''}" style="--x:2.8;--y:3"${space ? ` title="${esc(t(space[1]))}"` : ''}><kbd>${space ? esc(word(space[0])) : ''}</kbd></div>`;
  card.querySelector('h2')!.textContent = t(title);
  card.querySelector('.kb')!.innerHTML = kb;
  const p = card.querySelector<HTMLElement>('.help-note')!;
  p.textContent = note ? t(note) : '';
  p.hidden = !note;
}

// Draws the card again only when what it shows has changed.
export function keyHelp(card: HTMLElement) {
  let last = '', state: HelpState = { mode: 'foot', gun: false, fire: false, two: false };
  const draw = () => render(card, state);
  onLang(() => { if (last) draw(); });
  return (s: HelpState) => {
    const sig = `${s.mode}|${s.gun}|${s.fire}|${s.two}`;
    if (sig === last) return;
    last = sig; state = s;
    draw();
  };
}
