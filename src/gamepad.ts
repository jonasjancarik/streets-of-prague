// A game controller (Xbox, PlayStation, anything the browser maps to the standard
// layout). The left stick points where you want to go on screen, like the touch
// stick, and the triggers are the pedals. The buttons press the same keys as the
// keyboard, so every screen that takes keys (the metro, a conversation, the taxi)
// takes the pad too.
//
//   left stick   walk, run (full push) or steer toward where it points; in the metro
//                and in conversations it moves the choice
//   right trigger / left trigger   gas / brake and reverse
//   right stick  zoom (up and down)
//   A            Space: jump, handbrake, wait for a tram, confirm
//   X            E: get in or out
//   B            B: pay the ticket or fine; back, in the metro
//   Y            Q: horn or tram bell (hold)
//   left bumper  Shift (hold): run, lane assist, speed up a ride
//   right bumper F: water cannon (hold), take over a tram
//   d-pad        the arrow keys
//   View         T: taxi
//   Menu         the settings

const DEAD = 0.18;
const REPEAT_FIRST = 0.4, REPEAT = 0.12; // s: a held stick direction in a menu moves again after this long

// Standard mapping: button index → the key it presses and releases.
const BUTTONS: [number, string][] = [
  [0, 'Space'], [2, 'KeyE'], [3, 'KeyQ'], [5, 'KeyF'],
  [12, 'ArrowUp'], [13, 'ArrowDown'], [14, 'ArrowLeft'], [15, 'ArrowRight'],
  [8, 'KeyT'],
];

export interface PadState {
  active: boolean;
  move: number; aim: { h: number; mag: number } | null; run: boolean;
  /** Call once a frame, with the time passed and whether the metro or a conversation has the keys. */
  update(dt: number, menu: boolean, zoomBy: (factor: number) => void): void;
}

const dead = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

export function setupGamepad({ settings }: { settings: () => void }): PadState {
  const state: PadState = { active: false, move: 0, aim: null, run: false, update: () => {} };
  const down = new Set<string>(); // keys the pad is holding
  const press = (code: string, on: boolean) => {
    if (on === down.has(code)) return;
    if (on) down.add(code); else down.delete(code);
    // The shift key has to say so on every key while it's held, or the game thinks it was let go.
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, shiftKey: down.has('ShiftLeft'), bubbles: true, cancelable: true }));
  };
  const tap = (code: string) => { press(code, true); press(code, false); };
  let held = new Set<number>(), dir = '', dirT = 0;

  const pad = (): Gamepad | null => {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  };
  const releaseAll = () => { for (const code of [...down]) press(code, false); held = new Set(); dir = ''; };

  state.update = (dt, menu, zoomBy) => {
    const p = pad();
    if (!p) {
      if (state.active) { releaseAll(); Object.assign(state, { active: false, move: 0, aim: null, run: false }); }
      return;
    }
    // A pad that has been touched takes over from the keyboard hints and the like.
    const now = new Set<number>();
    p.buttons.forEach((b, i) => { if (b.pressed) now.add(i); });
    if (!state.active && (now.size || Math.hypot(p.axes[0], p.axes[1]) > DEAD)) state.active = true;
    if (!state.active) return;

    // While a panel (the settings, the credits) is open, the pad leaves the game alone.
    if (document.querySelector('dialog[open]')) { releaseAll(); Object.assign(state, { move: 0, aim: null, run: false }); held = now; return; }

    const hit = (i: number) => now.has(i) && !held.has(i);
    for (const [i, code] of BUTTONS) press(code, now.has(i));
    press('ShiftLeft', now.has(4));
    // B backs out of the metro, and pays a fine or buys a ticket anywhere else.
    if (hit(1)) tap(menu ? 'Escape' : 'KeyB');
    // Menu: the settings.
    if (hit(9)) settings();
    held = now;

    // The left stick. In a menu it presses the arrow keys, again and again while held.
    const sx = dead(p.axes[0]), sy = dead(p.axes[1]);
    if (menu) {
      state.aim = null;
      const next = Math.abs(sx) > 0.6 ? (sx > 0 ? 'ArrowRight' : 'ArrowLeft') : Math.abs(sy) > 0.6 ? (sy > 0 ? 'ArrowDown' : 'ArrowUp') : '';
      if (next !== dir) { dir = next; dirT = REPEAT_FIRST; if (next) tap(next); }
      else if (next && (dirT -= dt) <= 0) { dirT = REPEAT; tap(next); }
      state.move = 0;
      state.run = false;
      return;
    }
    dir = '';
    const mag = Math.min(1, Math.hypot(sx, sy));
    // The stick points: screen up is north, the way the map is drawn.
    state.aim = mag > 0 ? { h: Math.atan2(-sy, sx), mag } : null;
    state.move = (p.buttons[7]?.value ?? 0) - (p.buttons[6]?.value ?? 0);
    state.run = false;
    // The right stick zooms: up for closer.
    const zy = dead(p.axes[3] ?? 0);
    if (zy) zoomBy(Math.exp(zy * dt * 1.2));
  };
  return state;
}
