import type { Scenario } from '../src/testkit.ts';

interface Spot { x: number; y: number; bx: number; by: number; name: string; platform?: string; line: { ref: string; trams: { late: number }[] } }

// Anděl has four tram platforms, A to D. Standing at one, the board says which, marks
// every tram with the platform it leaves from and greys the ones leaving from the
// others; a tram held up on its way shows how late it is.
export default {
  title: 'At Anděl the board says which platform each tram leaves from, and which trams are late',
  async run(t) {
    await t.go([50.0711, 14.4036], { heading: 0 });
    t.time('14:00');
    t.weather('clear');
    const g = window.__drive as { board: { grid: Map<string, Spot[]>; shown: string | null }; walker: { x: number; y: number } };
    const { board, walker: w } = g;
    const spots = [...board.grid.values()].flat().filter((s) => s.name === 'Anděl');
    const letters = [...new Set(spots.map((s) => s.platform))].sort();
    if (!t.check('Anděl has platforms A to D', letters.join('') === 'ABCD', letters)) return;
    const el = document.getElementById('board')!;
    for (const p of ['B', 'D']) {
      const s = spots.find((o) => o.platform === p)!;
      // Beside the platform, halfway along.
      const ux = (s.bx - s.x) / 30, uy = (s.by - s.y) / 30;
      w.x = s.x + ux * 15 - uy * 2.5; w.y = s.y + uy * 15 + ux * 2.5;
      await t.frames(30);
      const title = el.querySelector('.board-title')?.textContent || '';
      t.check(`at platform ${p} the board says so`, title.includes(`platform ${p}`), title);
      const rows = [...el.querySelectorAll('.board-rows li')];
      const marks = rows.map((r) => [r.querySelector('.board-platform')?.textContent, r.classList.contains('board-other')]);
      t.check(`at ${p}, its own trams are bright and the others greyed`,
        rows.length > 0 && marks.every(([l, other]) => !!l && (l === p) === !other), marks);
      await t.shot(`tram-platforms-${p}`);
    }
    // Every tram due here held up for three minutes on the way.
    const trams = [...new Set(spots.flatMap((o) => o.line.trams))];
    for (const v of trams) v.late = 180;
    await t.frames(30);
    const late = [...el.querySelectorAll('.board-late')].map((e) => e.textContent);
    t.check('a tram held up shows as late', late.some((x) => /3 min late/.test(x || '')), late);
    await t.shot('tram-platforms-late');
    for (const v of trams) v.late = 0;
  },
} satisfies Scenario;
