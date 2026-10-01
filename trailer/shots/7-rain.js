t.time('21:30'); t.weather('rain'); t.set({ stars: 0 }); await driveAt(['malostranske', 'ujezd', 'karlak'], 'taxi'); t.camera(null); t.view(0.4);
await settle(); await t.wait(1.5, DRIVE); await t.film('rain', 4.5, DRIVE);
