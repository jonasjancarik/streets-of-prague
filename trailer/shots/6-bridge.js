t.time('23:00'); t.weather('clear'); t.set({ stars: 0 }); await driveAt([[50.08135, 14.4122], [50.08135, 14.4118], [50.0814, 14.4090]], 'police'); t.camera(null); t.view(0.6);
await settle(); await t.wait(1.5, DRIVE); await t.film('bridge', 4.5, DRIVE);
