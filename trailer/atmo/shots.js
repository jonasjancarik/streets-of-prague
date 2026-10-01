// The atmospheric trailer's shots, by name (timeline.json has their lengths). Run one with
// trailer/atmo/film.sh <name>; traffic and people differ from take to take.
const ROADS = {
  masarykovo: [[[50.0786, 14.4138], [50.0778, 14.4135]], 5],
  rasinovo: [[[50.0725, 14.4141], [50.0735, 14.4141]], 180],
  legii: [[[50.08135, 14.4116], [50.08135, 14.4112]], 270],
  benese: [[[50.0925, 14.4130], [50.0921, 14.4100]], 80],
  magistrala: [[[50.0655, 14.4303], [50.0650, 14.4303]], 180],
  evropska: [[[50.1003, 14.3900], [50.1000, 14.3930]], 290],
  jecna: [[[50.0755, 14.4260], [50.0755, 14.4250]], 90],
  legerova: [[[50.0740, 14.4300], [50.0730, 14.4300]], 0],
  manesuv: [[[50.0893, 14.4135], [50.0893, 14.4140]], 270],
};
const drive = (road, time, cam, weather = 'clear') => async (s) => {
  t.time(time); t.weather(weather); t.set({ stars: 0 });
  await driveAt(ROADS[road][0], 'sedan', ROADS[road][1]);
  await settle();
  return burst(s, cam);
};
const still = (time, weather, at, cam, d) => async (s) => { t.time(time); t.weather(weather); return quiet(s, at, cam, d); };
const SHOTS = {
  'quiet-01': still('05:40', 'mist', [50.0838, 14.3945], { height: 55, tilt: 38, heading: 60 }, { height: -4, north: 4 }),
  'quiet-02': still('06:20', 'clear', 'staromak', { height: 70, tilt: 52, heading: 20 }, { height: -5, heading: 4 }),
  'quiet-03': still('08:00', 'clear', 'most', { height: 90, tilt: 55, heading: 300 }, { east: 8, heading: -3 }),
  'quiet-04': still('10:30', 'clear', [50.0955, 14.4160], { height: 70, tilt: 45, heading: 160 }, { height: -6 }),
  'quiet-05': still('13:00', 'clear', [50.0812, 14.4135], { height: 85, tilt: 55, heading: 95 }, { heading: 4 }),
  'quiet-06': still('16:00', 'clear', [50.0900, 14.4155], { height: 75, tilt: 55, heading: 60 }, { height: -5 }),
  'quiet-07': still('18:40', 'cloudy', 'malostranske', { height: 65, tilt: 50, heading: 300 }, { heading: 3 }),
  'quiet-08': still('19:50', 'clear', [50.0876, 14.4280], { height: 65, tilt: 55, heading: 330 }, { height: -4 }),
  'quiet-09': still('21:00', 'clear', 'most', { height: 85, tilt: 35, heading: 20 }, { north: 5 }),
  'quiet-10': still('22:30', 'clear', 'staromak', { height: 60, tilt: 50, heading: 200 }, {}),
  'engine-01': drive('masarykovo', '06:00', 'top'),
  'engine-02': drive('rasinovo', '07:00', 'behind'),
  'engine-03': drive('legii', '09:00', 'side'),
  'engine-04': drive('benese', '11:30', 'high'),
  'engine-05': drive('magistrala', '14:00', 'behind'),
  'engine-06': drive('evropska', '17:00', 'top'),
  'engine-07': drive('masarykovo', '19:00', 'front'),
  'engine-08': drive('manesuv', '20:15', 'high'),
  'engine-09': drive('rasinovo', '21:30', 'top'),
  'engine-10': drive('jecna', '22:00', 'top'),
  'rush-01': drive('masarykovo', '23:00', 'top'),
  'rush-02': drive('legii', '23:00', 'behind'),
  'rush-03': drive('legerova', '23:00', 'high'),
  'rush-04': drive('benese', '23:00', 'side', 'rain'),
  'rush-05': drive('rasinovo', '23:00', 'front'),
  'rush-06': drive('masarykovo', '23:00', 'behind', 'rain'),
  'rush-07': drive('manesuv', '23:00', 'top'),
  'rush-08': drive('magistrala', '23:00', 'top'),
  'rush-09': drive('evropska', '23:00', 'high'),
  'rush-10': drive('jecna', '23:00', 'behind'),
  'rush-11': drive('masarykovo', '23:00', 'high'),
  'rush-12': drive('legii', '23:00', 'behind'),
  // The pull back: the car stopped on the bridge, the camera straight up from it.
  rise: async (s) => {
    t.time('23:30'); t.weather('clear'); t.set({ stars: 0 });
    await driveAt([[TL.rise.lat, TL.rise.lon]], 'sedan', 270);
    const c = __drive.car;
    // (Without the red cars the earlier takes left on the bridge.)
    const loose = __drive.loose;
    for (let i = loose.length - 1; i >= 0; i--) if (loose[i] !== c && loose[i].paint === '#c4161c') loose.splice(i, 1);
    await t.camera({ at: [TL.rise.lat, TL.rise.lon], height: 600, tilt: 0, heading: 0 }); await settle(9000);
    await t.film('rise', TL.filmed / TL.fps, {}, { each: (i) => { t.cam = { x: c.x, y: c.y, height: TL.height[i], tilt: 0, heading: 0 }; } });
    t.cam = null;
    return [c.x, c.y];
  },
};
return await SHOTS[NAME](seg(NAME));
