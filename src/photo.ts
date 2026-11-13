import { t } from './i18n.ts';
import type { Testkit } from './testkit.ts';

// Photo mode (the C key): the game stops, everything on the screen but the picture goes,
// and the camera comes off you: drag to move it, scroll to move in and out, right-drag (or
// the sliders) to tilt it and turn it, and pick the hour for the light. "Save picture"
// downloads what the canvas shows, at its full size. Leaving it puts the clock and the
// camera back. It is the developer panel's free camera with the game paused, given to
// players.
interface Host {
  kit: Testkit;
  canvas: HTMLCanvasElement;
  // Whether it may start now (not in a menu, a dialogue, the map, underground…).
  ready: () => boolean;
  // The picture on the canvas at its full size, as a PNG, once the next frame is drawn.
  capture: () => Promise<Blob | null>;
}

const CSS = `
body.photo > :not(#app):not(#photo) { display: none !important; }
#photo { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 50; display: flex; gap: 14px; align-items: center;
  padding: 10px 14px; border-radius: 6px; background: rgba(24, 20, 18, 0.86); color: #efe9df; font: 13px/1.3 system-ui, sans-serif; white-space: nowrap; }
#photo.bare { opacity: 0; pointer-events: none; }
#photo label { display: flex; gap: 6px; align-items: center; }
#photo input[type=range] { width: 110px; accent-color: #d8523a; }
#photo button { font: inherit; color: inherit; background: #3a322d; border: 1px solid #5a4e46; border-radius: 4px; padding: 5px 10px; cursor: pointer; }
#photo button.go { background: #d8523a; border-color: #d8523a; color: #fff; }
#photo .hint { opacity: 0.7; }
@media (max-width: 1100px) { #photo .hint { display: none; } }
`;

export function setupPhoto({ kit, canvas, ready, capture }: Host) {
  let on = false, was: { time: string; paused: boolean } | null = null, panel: HTMLElement | null = null;
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(Math.round(minutes) % 60).padStart(2, '0')}`;

  const build = () => {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = 'photo';
    const slider = (label: string, min: number, max: number, step: number, value: () => number, set: (v: number) => void, show?: (v: number) => string) => {
      const row = document.createElement('label'), input = document.createElement('input'), out = document.createElement('span');
      row.append(t(label), input, out);
      Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
      const sync = () => { input.value = String(value()); out.textContent = show ? show(value()) : ''; };
      input.addEventListener('input', () => { set(Number(input.value)); out.textContent = show ? show(Number(input.value)) : ''; });
      el.appendChild(row);
      return sync;
    };
    const minutes = () => { const [h, m] = kit.probe().time.split(':').map(Number); return h * 60 + m; };
    const syncs = [
      slider('Time of day', 0, 1435, 5, minutes, (v) => kit.time(hhmm(v)), hhmm),
      slider('Tilt', 0, 75, 1, () => kit.cam?.tilt ?? 0, (v) => kit.orbit(kit.cam?.heading ?? 0, v)),
      slider('Rotation', -180, 180, 1, () => (((kit.cam?.heading ?? 0) + 540) % 360) - 180, (v) => kit.orbit(v, kit.cam?.tilt ?? 0)),
    ];
    const button = (label: string, act: () => void, cls = '') => {
      const b = document.createElement('button');
      b.textContent = t(label);
      b.className = cls;
      b.addEventListener('click', act);
      el.appendChild(b);
      return b;
    };
    const save = button('Save picture', () => {
      // (Without the bar in it; the canvas is all that is saved anyway, this is for the eye.)
      save.disabled = true;
      void capture().then((blob) => {
        save.disabled = false;
        if (!blob) return;
        const a = document.createElement('a'), now = new Date(), two = (n: number) => String(n).padStart(2, '0');
        a.href = URL.createObjectURL(blob);
        a.download = `streets-of-prague-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      });
    }, 'go');
    button('Back to the game', () => api.toggle());
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = t('Drag to move, scroll to zoom, right-drag to turn. H hides this bar.');
    el.appendChild(hint);
    document.body.appendChild(el);
    panel = el;
    return () => { for (const s of syncs) s(); };
  };
  let sync: (() => void) | null = null;

  const api = {
    get on() { return on; },
    toggle() {
      if (!on && !ready()) return false;
      on = !on;
      if (on) {
        sync ??= build();
        was = { time: kit.probe().time, paused: kit.paused };
        kit.paused = true;
        kit.eyes = null;
        void kit.camera({ level: true }).then(() => sync?.());
      } else {
        kit.cam = null;
        if (was) { kit.time(was.time); kit.paused = was.paused; }
        was = null;
      }
      document.body.classList.toggle('photo', on);
      panel?.classList.remove('bare');
      if (panel) panel.style.display = on ? '' : 'none';
      return true;
    },
    // A key while it is on: true if photo mode took it.
    key(code: string) {
      if (!on) return false;
      if (code === 'KeyH') panel?.classList.toggle('bare');
      else if (code === 'Escape' || code === 'KeyC') api.toggle();
      return true;
    },
  };
  // (The sliders follow the camera as it is dragged.)
  canvas.addEventListener('pointermove', () => { if (on) sync?.(); });
  return api;
}
