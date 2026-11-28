import type { Scenario } from '../src/testkit.ts';
import { onCrash } from '../src/impacts.ts';

// Signs knocked over like a lamp post: a traffic sign's post hit at 30 km/h goes over, the
// car carries on through where it stood (its grid cells freed), and the sign comes down onto
// the ground; at 8 km/h the car is stopped by it as before. A bus or tram stop's sign goes
// over flat at 30, and a café's chalkboard when you run into it on foot.
export default {
  title: 'A traffic sign and a stop sign knocked over at 30 km/h (not a sign at 8), and a chalkboard run into on foot',
  async run(t) {
    t.time('14:00');
    t.weather('clear');
    for (const c of [{ kmh: 30, over: true }, { kmh: 8, over: false }]) {
      let post = null, car = null;
      for (const place of ['vodickova', 'karlak', 'mustek', 'staromak', 'ujezd']) {
        await t.go(place, { heading: 315 });
        car = await t.drive('hatch');
        if ((post = t.signPost(300, c.over ? 14 : 5, 8))) break;
      }
      if (!post || !car) { t.check('a sign post with a clear run up to it', true, 'none found: skipped'); continue; }
      await t.wait(0.3, { brake: true });
      const hits: string[] = [];
      const stop = onCrash((e) => { if (e.a === car || Math.hypot(e.x - post!.x, e.y - post!.y) < 1) hits.push(`${e.kind} ${(e.speed * 3.6).toFixed(0)} km/h`); });
      const h = Math.atan2(post.y - car.y, post.x - car.x);
      t.push(c.kmh);
      // On until it's 2 m past where the sign stands (along the way the car was aimed), or 3 s.
      let passed = false, speed = 0;
      for (let i = 0; i < 60; i++) {
        await t.wait(0.05, { move: c.over ? 0.4 : 0 });
        speed = Math.hypot(car.vx, car.vy) * 3.6;
        if ((car.x - post.x) * Math.cos(h) + (car.y - post.y) * Math.sin(h) > 2) { passed = true; break; }
      }
      await t.wait(2, { brake: true });
      stop();
      const standing = t.signPostsNear(post.x, post.y, 0.2).length > 0;
      if (c.over) {
        t.check('a sign post hit at 30 km/h went over', !standing, hits.join(', '));
        t.check('the car went on past where it stood', passed, `${Math.round(speed)} km/h then, ${hits.join(', ')}`);
        const body = t.pieces().find((b) => Math.hypot(b.from[0] - post!.x, b.from[1] - post!.y) < 0.01), away = body ? Math.hypot(body.x - post.x, body.y - post.y) : NaN;
        t.check('the sign lies on the ground near where it stood', !!body && away < 15 && body.up < 0.5, body ? `${away.toFixed(1)} m on, its top ${body.up.toFixed(2)}` : 'no body');
        await t.look({ x: post.x, y: post.y, h: 0 }, { name: 'sign-knock', views: ['top', 'third', 'front-left'] });
      } else {
        t.check('a sign post hit at 8 km/h still stands', standing, hits.join(', '));
        const d = Math.hypot(car.x - post.x, car.y - post.y);
        t.check('the car was stopped by it', d < 4, `${d.toFixed(1)} m from it`);
      }
    }

    // A bus stop's sign at 30 km/h: over flat, and the car on past it.
    let stopSign = null, car = null;
    for (const place of ['vodickova', 'karlak', 'mustek', 'ujezd', 'malostranske']) {
      await t.go(place, { heading: 315 });
      car = await t.drive('hatch');
      await t.wait(0.5, { brake: true }); // (the signs near you put up)
      if ((stopSign = t.stopSign(200, 10, 5))) break;
    }
    if (!stopSign || !car) { t.check('a bus stop sign with a clear run up to it', true, 'none found: skipped'); return; }
    const h = Math.atan2(stopSign.y - car.y, stopSign.x - car.x);
    const near: string[] = [], sign = stopSign;
    const listen = onCrash((e) => { if (Math.hypot(e.x - sign.x, e.y - sign.y) < 3) near.push(`${e.kind} ${(e.speed * 3.6).toFixed(0)}`); });
    t.push(30);
    let passed = false, closest = Infinity, side = 0;
    for (let i = 0; i < 60 && !passed; i++) {
      await t.wait(0.05, { move: 0.4 });
      const d = Math.hypot(car.x - sign.x, car.y - sign.y);
      if (d < closest) { closest = d; side = -(car.x - sign.x) * Math.sin(h) + (car.y - sign.y) * Math.cos(h); }
      passed = (car.x - stopSign.x) * Math.cos(h) + (car.y - stopSign.y) * Math.sin(h) > 2;
    }
    listen();
    await t.wait(2, { brake: true });
    // (It falls in real time, as a lamp post does: a moment of that, and a frame to show it.)
    await new Promise((r) => setTimeout(r, 1500));
    await t.frames(2);
    // (How far over: the angle it has turned through, 90° flat.)
    // (Its up, as its matrix now has it: loose, its body moves it.)
    const e = stopSign.sign.matrix.elements, over = Math.acos(Math.min(1, e[5] / Math.hypot(e[4], e[5], e[6]))) * 180 / Math.PI;
    const post = (sign.sign as unknown as { post?: { down: unknown } }).post;
    t.check('a bus stop sign hit at 30 km/h went over', over > 70, `${over.toFixed(0)}°; passed ${closest.toFixed(1)} m from it, ${side.toFixed(1)} m aside; heard there: ${near.join(', ') || 'nothing'}; ${post ? (post.down ? 'its post down' : 'its post standing') : 'no post'}`);
    t.check('the car went on past it', passed);
    await t.look({ x: stopSign.x, y: stopSign.y, h: 0 }, { name: 'sign-knock-stop', views: ['top', 'third', 'front-left'] });

    // A café's chalkboard, drawn close up, run into on foot.
    const g = window.__drive as unknown as { grid: { at(x: number, y: number): number }; walker: { x: number; y: number; h: number } };
    let board: { x: number; y: number; down: boolean } | null = null;
    try {
      for (const place of ['karlova', 'staromak', 'malostranske', 'mustek', 'vodickova']) {
        await t.go(place, { heading: 0 });
        await t.onFoot();
        t.eyes = { yaw: 0, pitch: 0 };
        const deadline = performance.now() + 15000, me = g.walker;
        while (performance.now() < deadline) {
          await t.frames(5);
          // (One with clear ground 3 m out from it, along any way but into the wall.)
          for (const b of t.boardsNear(me.x, me.y, 60)) for (let a = 0; a < 16 && !board; a++) {
            const h = (a * Math.PI) / 8, c = Math.cos(h), s = Math.sin(h);
            let clear = true;
            for (let d = 0.6; d <= 3.2 && clear; d += 0.2) clear = !(me as unknown as { blocked(x: number, y: number): boolean }).blocked(b.x + c * d, b.y + s * d);
            if (clear) { me.x = b.x + c * 3; me.y = b.y + s * 3; me.h = h + Math.PI; board = b; }
          }
          if (board) break;
        }
        if (board) break;
      }
      const at = board as { x: number; y: number; down: boolean } | null;
      if (!at) { t.check('a chalkboard outside a café', true, 'none drawn near: skipped'); return; }
      await t.frames(2);
      let closest = Infinity;
      const start = [g.walker.x, g.walker.y];
      for (let i = 0; i < 24; i++) {
        await t.wait(0.05, { move: 1, run: true });
        closest = Math.min(closest, Math.hypot(g.walker.x - at.x, g.walker.y - at.y));
      }
      const w = g.walker as unknown as { vx: number; vy: number; speed: number; down: number; h: number };
      const state = `speed ${w.speed?.toFixed(1)}, v ${Math.hypot(w.vx, w.vy).toFixed(1)}, down ${w.down?.toFixed(1)}, facing ${(Math.atan2(at.y - g.walker.y, at.x - g.walker.x) - w.h).toFixed(2)} off`;
      await new Promise((r) => setTimeout(r, 1500));
      await t.frames(2);
      const now = t.boardsNear(at.x, at.y, 0.1)[0];
      t.check('a chalkboard run into on foot went over', !!now?.down, `${now ? '' : 'its wall was no longer drawn; '}came within ${closest.toFixed(2)} m (${state}), from ${Math.hypot(start[0] - at.x, start[1] - at.y).toFixed(1)} m`);
      await t.look({ x: at.x, y: at.y, h: g.walker.h }, { name: 'sign-knock-board', views: ['third', 'front-left'] });
    } finally { t.eyes = null; }
  },
} satisfies Scenario;
