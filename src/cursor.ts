// The mouse pointer hides over the game after a few seconds without moving and comes
// back as soon as it moves or clicks. Only the game's own picture hides it (the class is
// on the canvas), so over a menu, a button or a dialog it always shows; and while
// `busy` (the settings are open, say) it doesn't hide at all.

const IDLE = 3000; // ms

export function hideIdleCursor(canvas: HTMLElement, busy: () => boolean) {
  let timer = 0;
  const hide = () => {
    if (busy()) { timer = window.setTimeout(hide, IDLE); return; }
    canvas.classList.add('idle-cursor');
  };
  const wake = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    canvas.classList.remove('idle-cursor');
    clearTimeout(timer);
    timer = window.setTimeout(hide, IDLE);
  };
  addEventListener('pointermove', wake, { passive: true });
  addEventListener('pointerdown', wake, { passive: true });
}
