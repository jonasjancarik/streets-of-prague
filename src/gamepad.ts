// A game controller (Xbox, PlayStation, anything the browser maps to the standard
// layout). The left stick points where you want to go on screen, like the touch
// stick, and the triggers are the pedals. The buttons press the same keys as the
// keyboard, so every screen that takes keys (the metro, a conversation, the taxi)
// takes the pad too. Where there are only buttons to press (the start screen, the
// settings, the beta note) the stick and d-pad move between them, A presses one and
// B closes the panel.
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
//   left stick click   R: next radio station
//   right stick click  X: open and close a tram's doors
//   d-pad        the arrow keys
//   View         T: taxi
//   Menu         the settings
//
// While a pad is the last thing the player used, `usingPad()` is true, the page gets
// the class `pad` and hints name the pad's buttons (`padLabels`). A key or a mouse
// click on the page puts the keyboard hints back.

const DEAD = 0.18;
const REPEAT_FIRST = 0.4, REPEAT = 0.12; // s: a held stick direction in a menu moves again after this long

// Standard mapping: button index → the key it presses and releases.
const BUTTONS: [number, string][] = [
  [0, 'Space'], [2, 'KeyE'], [3, 'KeyQ'], [5, 'KeyF'], [10, 'KeyR'], [11, 'KeyX'],
  [12, 'ArrowUp'], [13, 'ArrowDown'], [14, 'ArrowLeft'], [15, 'ArrowRight'],
  [8, 'KeyT'],
];

let using = false;
export const usingPad = () => using;

// The hints are written for the keyboard: <b>E</b> get in. For a pad, the same hint
// with the names of the buttons.
const NAMES: Record<string, string> = { E: 'X', Space: 'A', Shift: 'LB', F: 'RB', Q: 'Y', B: 'B', X: 'R3', T: 'View', R: 'L3', W: 'RT', S: 'LT', Esc: 'B', Enter: 'A' };
export function padLabels(html: string): string {
  if (!using) return html;
  return html
    .replace(/ · <b>1<\/b>–<b>4<\/b>[^·<]*/g, '') // (the number keys that buy a metro ticket)
    .replace(/<b>W<\/b>\/<b>S<\/b>/g, '<b>↑</b>/<b>↓</b>')
    .replace(/<b>A<\/b>\/<b>D<\/b>/g, '<b>←</b>/<b>→</b>')
    .replace(/<(b|kbd)>([^<]*)<\/\1>/g, (m, tag: string, key: string) => (NAMES[key] ? `<${tag}>${NAMES[key]}</${tag}>` : m));
}

export interface PadState {
  /** A pad is connected and has been touched: it steers. */
  active: boolean;
  move: number; turn: number; aim: { h: number; mag: number } | null;
}

const dead = (v: number) => (Math.abs(v) < DEAD ? 0 : Math.sign(v) * (Math.abs(v) - DEAD) / (1 - DEAD));

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], textarea:not([disabled]), summary';
const shown = (e: HTMLElement) => e.getClientRects().length > 0 && !e.closest('[hidden]');

export function setupGamepad({ settings, menu, zoomBy }: { settings: () => void; menu: () => boolean; zoomBy: (factor: number) => void }): PadState {
  const state: PadState = { active: false, move: 0, turn: 0, aim: null };
  const down = new Set<string>(); // keys the pad is holding
  const press = (code: string, on: boolean) => {
    if (on === down.has(code)) return;
    if (on) down.add(code); else down.delete(code);
    // The shift key has to say so on every key while it's held, or the game thinks it was let go.
    window.dispatchEvent(new KeyboardEvent(on ? 'keydown' : 'keyup', { code, shiftKey: down.has('ShiftLeft'), bubbles: true, cancelable: true }));
  };
  const tap = (code: string) => { press(code, true); press(code, false); };
  const use = (on: boolean) => {
    if (on === using) return;
    using = on;
    document.body.classList.toggle('pad', on);
  };
  // Real keys and the mouse hand the hints back to the keyboard.
  window.addEventListener('keydown', (e) => { if (e.isTrusted) use(false); }, { capture: true });
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') use(false); }, { capture: true });

  let held = new Set<number>(), latched = new Set<number>(), dir = '', dirT = 0;
  const pad = (): Gamepad | null => {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  };
  const releaseAll = () => {
    for (const code of [...down]) press(code, false);
    held = new Set();
    dir = '';
    Object.assign(state, { move: 0, turn: 0, aim: null });
  };
  let focused = document.hasFocus?.() ?? true;
  const suspend = () => {
    // The page can keep receiving animation frames in the background. Stop both
    // analogue controls and synthetic keys until it has focus again.
    releaseAll();
    const buttons = pad()?.buttons ?? [];
    latched = new Set(buttons.flatMap((button, i) => button.pressed ? [i] : []));
    held = new Set(latched);
    state.active = false;
  };
  window.addEventListener('blur', () => { focused = false; suspend(); });
  window.addEventListener('focus', () => { suspend(); focused = true; });
  document.addEventListener('visibilitychange', suspend);
  // A stick pushed in one direction, as one press and then again and again while it's held.
  const direction = (sx: number, sy: number, dt: number): string => {
    const next = Math.abs(sx) > 0.6 ? (sx > 0 ? 'right' : 'left') : Math.abs(sy) > 0.6 ? (sy > 0 ? 'down' : 'up') : '';
    if (next !== dir) { dir = next; dirT = REPEAT_FIRST; return next; }
    if (next && (dirT -= dt) <= 0) { dirT = REPEAT; return next; }
    return '';
  };

  // Panels with buttons: the start screen and anything shown as a dialog.
  const panel = (): HTMLElement | null => {
    const dialogs = document.querySelectorAll<HTMLElement>('dialog[open]');
    if (dialogs.length) return dialogs[dialogs.length - 1];
    const start = document.querySelector<HTMLElement>('#loading');
    return start && !start.classList.contains('done') && start.querySelector('.ls-start') && shown(start) ? start : null;
  };
  const steer = (root: HTMLElement, way: string) => {
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
    const now = document.activeElement as HTMLElement | null;
    if (!now || !items.includes(now)) { items[0]?.focus(); return; }
    if (now instanceof HTMLInputElement && now.type === 'range' && (way === 'left' || way === 'right')) {
      now.value = String(Number(now.value) + (way === 'right' ? 1 : -1) * (Number(now.step) || 1));
      now.dispatchEvent(new Event('input', { bubbles: true }));
      now.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (now instanceof HTMLSelectElement && (way === 'left' || way === 'right')) {
      const step = way === 'right' ? 1 : -1;
      for (let i = now.selectedIndex + step; i >= 0 && i < now.options.length; i += step) {
        if (now.options[i].disabled || now.options[i].parentElement?.matches('optgroup[disabled]')) continue;
        now.selectedIndex = i;
        now.dispatchEvent(new Event('input', { bubbles: true }));
        now.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
      return;
    }
    // The nearest one in that direction, trading a little distance for staying in line.
    const from = now.getBoundingClientRect(), fx = from.left + from.width / 2, fy = from.top + from.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const it of items) {
      if (it === now) continue;
      const r = it.getBoundingClientRect(), dx = r.left + r.width / 2 - fx, dy = r.top + r.height / 2 - fy;
      const along = way === 'right' ? dx : way === 'left' ? -dx : way === 'down' ? dy : -dy;
      const across = way === 'left' || way === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (along <= 1) continue;
      const score = along + across * 2.5;
      if (score < bestScore) { best = it; bestScore = score; }
    }
    best?.focus();
  };

  let last = performance.now();
  const poll = (now: number) => {
    requestAnimationFrame(poll);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!focused || document.hidden) return;
    const p = pad();
    if (!p) {
      if (state.active) { releaseAll(); state.active = false; }
      return;
    }
    const pressed = new Set<number>();
    p.buttons.forEach((b, i) => { if (b.pressed) pressed.add(i); });
    const push = Math.hypot(p.axes[0], p.axes[1]);
    // A pad that has been touched takes over: browsers say nothing of it before that.
    if (pressed.size || push > 0.35) { state.active = true; use(true); }
    if (!state.active) return;
    const hit = (i: number) => pressed.has(i) && !held.has(i);
    const sx = dead(p.axes[0]), sy = dead(p.axes[1]);

    // Panels first: no game keys while one is up. A button still held when it closes
    // waits until it's let go, or the jump or the horn would go off.
    const root = panel();
    if (root) {
      for (const code of [...down]) press(code, false);
      Object.assign(state, { move: 0, turn: 0, aim: null });
      latched = new Set(pressed);
      const way = direction(sx, sy, dt) || (hit(12) ? 'up' : hit(13) ? 'down' : hit(14) ? 'left' : hit(15) ? 'right' : '');
      if (way) steer(root, way);
      if (hit(0)) {
        const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(shown);
        const active = document.activeElement as HTMLElement | null;
        // A newly opened panel may still have focus on its opener. Confirm only
        // an enabled control belonging to the visible panel.
        const target = active && items.includes(active) ? active : items[0];
        target?.focus();
        target?.click();
      }
      if (hit(1) && root instanceof HTMLDialogElement) root.close();
      held = pressed;
      return;
    }
    for (const i of latched) if (!pressed.has(i)) latched.delete(i);
    const live = new Set([...pressed].filter((i) => !latched.has(i)));

    for (const [i, code] of BUTTONS) press(code, live.has(i));
    press('ShiftLeft', live.has(4));
    // B backs out of the metro, and pays a fine or buys a ticket anywhere else.
    if (hit(1) && !latched.has(1)) tap(menu() ? 'Escape' : 'KeyB');
    if (hit(9) && !latched.has(9)) settings();
    held = pressed;

    // The left stick. In the metro or a conversation it presses the arrow keys.
    if (menu()) {
      Object.assign(state, { move: 0, turn: 0, aim: null });
      const way = direction(sx, sy, dt);
      if (way) tap(`Arrow${way[0].toUpperCase()}${way.slice(1)}`);
      return;
    }
    dir = '';
    const mag = Math.min(1, Math.hypot(sx, sy));
    // The stick points: screen up is north, the way the map is drawn.
    state.aim = mag > 0 ? { h: Math.atan2(-sy, sx), mag } : null;
    state.turn = -sx; // (where there is no aiming, a boat, say, it steers)
    state.move = latched.has(7) || latched.has(6) ? 0 : (p.buttons[7]?.value ?? 0) - (p.buttons[6]?.value ?? 0);
    // The right stick zooms: up for closer.
    const zy = dead(p.axes[3] ?? 0);
    if (zy) zoomBy(Math.exp(zy * dt * 1.2));
  };
  requestAnimationFrame(poll);
  return state;
}
