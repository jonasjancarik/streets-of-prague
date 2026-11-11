import type { Scenario } from '../src/testkit.ts';

interface Spot { x: number; y: number; bx: number; by: number; name: string }

// Holding Space at a tram stop fast-forwards the wait. It works anywhere along the
// platform (not just where the tram's front stops), a tram at the stop's other
// platforms doesn't call it off, and walking about pauses it without ending it.
export default {
  title: 'Holding Space at a tram stop waits for a tram, along the whole platform and while you shuffle about',
  async run(t) {
    await t.go('ujezd', { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    const g = window.__drive as {
      board: { grid: Map<string, Spot[]>; shown: string | null; mine: number; next: number };
      walker: { x: number; y: number };
    };
    const { board, walker: w } = g;
    let s: Spot | null = null;
    for (const spots of board.grid.values()) for (const o of spots) if (!s || Math.hypot(o.x - w.x, o.y - w.y) < Math.hypot(s.x - w.x, s.y - w.y)) s = o;
    if (!t.check('a tram stop nearby', !!s)) return;
    // 25 m back from where a tram's front stops, beside the track: by its back doors.
    const ux = (s!.bx - s!.x) / 30, uy = (s!.by - s!.y) / 30;
    w.x = s!.x + ux * 25 - uy * 3; w.y = s!.y + uy * 25 + ux * 3;
    await t.frames(30);
    t.check('the board shows at the back of the platform', board.shown === s!.name, board.shown);
    const key = (type: string, code: string) => window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    const waiting = () => /Waiting for a tram/.test(document.getElementById('hint')?.textContent || '');
    const wasPaused = t.paused;
    t.paused = false;
    try {
      // (A tram due at your platform any moment rightly stops the wait; give it time to go.)
      for (let i = 0; i < 60 && board.mine <= 20; i++) await t.wait(1);
      key('keydown', 'Space');
      await t.wait(3);
      t.check('holding Space waits', waiting(), { mine: Math.round(board.mine), next: Math.round(board.next) });
      key('keydown', 'KeyW');
      await t.frames(60); // (frames: while waiting, game seconds fly by)
      t.check('walking pauses the wait', !waiting());
      key('keyup', 'KeyW');
      await t.wait(3);
      t.check('standing still again, it goes on', waiting() || board.mine <= 8, { shown: board.shown, mine: Math.round(board.mine) });
    } finally {
      key('keyup', 'Space');
      key('keyup', 'KeyW');
      t.paused = wasPaused;
    }
  },
} satisfies Scenario;
