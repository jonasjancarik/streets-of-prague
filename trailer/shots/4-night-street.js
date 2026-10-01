await t.go('vodickova'); t.time('22:00'); t.weather('clear'); t.set({ stars: 0 }); await t.drive('sedan'); t.camera(null); t.view(0.42);
await settle(); await t.wait(1.5, DRIVE); await t.film('night-street', 5, DRIVE);
