await t.go('vodickova'); t.time('19:20'); t.weather('cloudy'); t.set({ stars: 0 });
await t.camera({ at: 'vodickova', height: 55, tilt: 40, heading: 40 });
await settle(); await t.film('tram', 5);
