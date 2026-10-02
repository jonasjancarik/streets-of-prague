// Drives the route once, kept in its lane at the plan's speed, with the traffic ahead
// taken away, and notes where the car is at every frame: path.json, which every take
// then follows exactly. Run through scripts/scene.mjs eval with PLAN = plan.json.
t.time('13:00'); t.weather('clear'); t.set({ stars: 0 }); t.unhurt = true;
await t.go(PLAN.start, { heading: PLAN.heading }); await t.drive('sedan'); t.push(0, PLAN.heading);
await t.wait(0.5); await new Promise((r) => setTimeout(r, 4000));
const DRIVE = { move: 1, run: true };
const path = [], streets = [];
for (let i = 0; i < PLAN.routeFrames; i++) {
  const c = __drive.car, v = PLAN.speed[i], now = Math.hypot(c.vx, c.vy);
  if (now > 0.5) { c.vx *= v / now; c.vy *= v / now; } else { c.vx = Math.cos(c.h) * v; c.vy = Math.sin(c.h) * v; }
  const A = __drive.traffic.agents;
  for (let k = A.length - 1; k >= 0; k--) if (Math.hypot(A[k].car.x - c.x, A[k].car.y - c.y) < 90) A.splice(k, 1);
  await t.wait(1 / 30, DRIVE);
  path.push([+c.x.toFixed(3), +c.y.toFixed(3), +c.h.toFixed(4), +(c.gz ?? 0).toFixed(2)]);
  if (i % 90 === 0) streets.push(t.where().street);
}
t.unhurt = false;
await window.__saveFile('path.json', btoa(JSON.stringify(path)));
return { streets, end: t.where(), km: path.reduce((s, p, i) => s + (i ? Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0), 0) };
