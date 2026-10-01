await t.go('ujezd'); t.time('14:00'); t.weather('clear'); t.set({ stars: 0 }); await t.drive('sedan'); t.camera(null); t.view(0.8);
await settle(); await t.wait(2.5, DRIVE); await t.film('day-drive', 5, DRIVE);
