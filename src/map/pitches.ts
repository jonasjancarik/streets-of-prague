// What pitches, courts, playgrounds and running tracks are made of. pipeline/sports.py
// picks the look from the OSM tags and puts each in its own area kind; this is how the
// ground draws them, in drawing order (the grass pitch on top, so it stays grass where
// it lies inside a sports centre or a track's infield).
export const PITCH_LOOKS: [kind: string, color: string, pattern: string][] = [
  ['pitch_site', '#7fa152', 'grass'],
  ['pitch_tartan', '#b2503e', 'concrete'],
  ['pitch_sand', '#d8c58f', 'dirt'],
  ['pitch_play', '#a89f8c', 'concrete'],
  ['pitch_clay', '#bf6a44', 'dirt'],
  ['pitch_grey', '#8d908d', 'concrete'],
  ['pitch_blue', '#4f77a8', 'concrete'],
  ['pitch_green', '#4d8a5e', 'concrete'],
  ['pitch_red', '#b5584a', 'concrete'],
  ['pitch_turf', '#3f8a45', 'pitch'],
];
export const PITCH_KINDS = ['pitch', ...PITCH_LOOKS.map(([kind]) => kind)];
