// Haptic feedback on phones. Android browsers can vibrate in patterns; iOS Safari can't
// (no navigator.vibrate), but toggling a hidden <input type="checkbox" switch> ticks the
// Taptic Engine on iOS 17.4+, once per call and only inside a tap. Anywhere else this does nothing.

export type HapticKind = 'tick' | 'bump' | 'thud' | 'boom';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 12,
  bump: 30,
  thud: [60, 30, 40],
  boom: [140, 40, 90, 40, 50],
};
const MIN_GAP = 120; // ms between buzzes, so a scrape along a wall isn't one long drone

let on = true;
try { on = localStorage.getItem('haptics') !== 'off'; } catch { /* no storage: stay on */ }
let last = 0;
let label: HTMLLabelElement | null = null;

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

function iosTick() {
  if (!label) {
    label = document.createElement('label');
    label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('switch', '');
    label.appendChild(box);
    document.body.appendChild(label);
  }
  label.click();
}

export const hapticsOn = () => on;

export function setHaptics(enabled: boolean) {
  on = enabled;
  try { localStorage.setItem('haptics', enabled ? 'on' : 'off'); } catch { /* not saved */ }
  if (enabled) haptic('tick');
}

export function haptic(kind: HapticKind) {
  if (!on || typeof document === 'undefined') return;
  const now = performance.now();
  if (now - last < MIN_GAP) return;
  last = now;
  try {
    if (canVibrate) navigator.vibrate(PATTERNS[kind]);
    else {
      iosTick();
      // iOS only gives one tick per call, so a bigger event gets a few in a row.
      const extra = kind === 'boom' ? 3 : kind === 'thud' ? 1 : 0;
      for (let i = 1; i <= extra; i++) setTimeout(iosTick, i * 70);
    }
  } catch { /* haptics are a nicety */ }
}

// A crash of strength `hit` (the game's own impact measure): firmer the harder it was.
export const hapticCrash = (hit: number) => haptic(hit > 14 ? 'thud' : 'bump');

// An explosion d metres away: felt in the hand only when it's close.
export const hapticBlast = (d: number) => { if (d < 60) haptic('boom'); else if (d < 120) haptic('thud'); };
