t.time('22:30'); t.weather('clear'); await driveAt(['karlak', 'mustek', 'ujezd'], 'hatch'); t.camera(null); t.view(0.6); t.unhurt = true;
await settle(); t.set({ stars: 2 });
// Wait where you are until a police car is close, then run for it.
for (let i = 0; i < 45; i++) {
  await t.wait(1);
  const me = __drive.car;
  if (__drive.police.cars.some((p) => Math.hypot(p.car.x - me.x, p.car.y - me.y) < 45)) break;
}
await t.film('police', 6, DRIVE);
t.set({ stars: 0 }); t.unhurt = false;
