await t.go('staromak'); t.time('17:10'); t.weather('clear'); t.set({ stars: 0 });
await t.camera({ at: 'staromak', height: 70, tilt: 52, heading: 20 });
await settle(); await t.film('square', 4);
