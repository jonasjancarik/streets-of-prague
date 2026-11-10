import type { Scenario } from '../src/testkit.ts';

// A bus stop and a bus ride: the sign stands on the pavement, the board lists the buses
// coming, holding Space waits for one (a bus is sent along the line when none is on its
// way), E gets you on, S picks the next stop, and you're let off there.
// Runs in real time: the waiting and the ride's speed-up live in the game's own loop.
export default {
  title: 'Bus stop: sign on the pavement, board, waiting, getting on, riding a stop and getting off',
  async run(t) {
    const g = window.__drive as unknown as {
      walker: { x: number; y: number; vx: number; vy: number; mesh: { visible: boolean } };
      world: { onRoad: (x: number, y: number) => boolean };
      dev: { toLonLat: (x: number, y: number) => [number, number] };
      board: { kind: string; shown: string | null; next: number; el: HTMLElement };
      busStops: { near: (x: number, y: number, r: number) => { x: number; y: number; name: string; placed: boolean }[] };
      busRide: { boardable: (x: number, y: number) => unknown; dest: number | null; upcoming: () => number[]; run: { stop: number; dwell: number; line: { stops: [number, string][] } } | null };
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const key = (code: string, up = false) => window.dispatchEvent(new KeyboardEvent(up ? 'keyup' : 'keydown', { code }));
    const hint = () => document.getElementById('hint')!.innerText;

    // Římská on náměstí Míru, where the 135 stops.
    await t.go('vodickova');
    const first = g.busStops.near(g.walker.x, g.walker.y, 1200).find((s) => s.name === 'Římská');
    if (!t.check('a bus stop called Římská', !!first)) return;
    const [lon, lat] = g.dev.toLonLat(first!.x, first!.y);
    await t.go([lat, lon]);
    t.time('10:00');
    t.weather('clear');
    let stop = null;
    for (let i = 0; i < 20 && !stop; i++) { await t.frames(); await sleep(200); stop = g.busStops.near(first!.x, first!.y, 40).find((s) => s.name === 'Římská' && s.placed); }
    if (!t.check('its sign is put up', !!stop)) return;
    t.check('on the pavement, not in the road', !g.world.onRoad(stop!.x, stop!.y));
    Object.assign(g.walker, { x: stop!.x, y: stop!.y, vx: 0, vy: 0 });
    await t.frames();
    await sleep(500);
    t.check('the board lists the buses from Římská', g.board.kind === 'bus' && g.board.shown === 'Římská', g.board.el.innerText);
    t.check('and says Space waits for a bus', hint().includes('wait for a bus'), hint());
    const [slon, slat] = g.dev.toLonLat(stop!.x, stop!.y);
    t.camera({ at: [slat, slon], height: 26, tilt: 0 });
    await sleep(300);
    await t.shot('bus-stop');
    t.camera(null);

    key('Space');
    let sped = false, bus = null;
    for (let i = 0; i < 120 && !bus; i++) { await sleep(500); sped ||= hint().includes('Waiting for a bus'); bus = g.busRide.boardable(g.walker.x, g.walker.y); }
    key('Space', true);
    t.check('holding Space speeds the wait up', sped);
    if (!t.check('a bus pulls up beside you', !!bus, g.board.el.innerText)) return;
    t.check('and E gets you on it', hint().includes('get on the'), hint());
    await t.shot('bus-at-stop');
    key('KeyE'); key('KeyE', true);
    await sleep(300);
    if (!t.check('on the bus', t.where().mode === 'bus', t.where().mode)) return;
    t.check('the strip lists the stops ahead', document.getElementById('busride')!.innerText.includes('135'), document.getElementById('busride')!.innerText);
    key('KeyS'); key('KeyS', true);
    const dest = g.busRide.dest, name = dest !== null ? g.busRide.run!.line.stops[dest][1] : '';
    t.check('S picks the next stop', dest !== null && dest === g.busRide.upcoming()[0], name);
    // Riding without a ticket, and sure to be checked at the next stop: the bus waits there
    // for your answer, and goes on (letting you off) once you've paid.
    t.roll = 0;
    let checked = null as { phase: string; where: string } | null, held = false;
    for (let i = 0; i < 180 && t.where().mode === 'bus' && !checked; i++) {
      await sleep(500);
      if (t.inspection().phase === 'decide') checked = t.inspection();
    }
    t.roll = null;
    if (t.check('an inspector checks you at the next stop', !!checked, t.inspection())) {
      await sleep(3000);
      held = t.where().mode === 'bus' && g.busRide.run!.dwell > 0;
      t.check('the bus stands there until you answer', held, { mode: t.where().mode, hint: hint() });
      t.payFine();
    }
    for (let i = 0; i < 180 && t.where().mode === 'bus'; i++) await sleep(500);
    const left = g.busStops.near(g.walker.x, g.walker.y, 60).map((s) => s.name);
    t.check('let off at that stop', t.where().mode === 'foot' && g.walker.mesh.visible && left.includes(name), { mode: t.where().mode, name, near: left });
  },
} satisfies Scenario;
