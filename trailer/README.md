# The release trailer

A 37-second, 1920×1080, 30 fps trailer cut with [fframes](https://github.com/dmtrKovalenko/fframes)
(`cargo install --locked cargo-fframes`; on a Mac also `brew install nasm ninja`, with
ffmpeg, x264, x265 and opus already there). The picture is filmed from the game itself.

| File | What |
| --- | --- |
| `shots/*.js` | one clip each: where, when, in what weather, what is driven, how long |
| `record.sh` | films the shots frame by frame (`t.film` in `src/testkit.ts`) and encodes them into `clips/` |
| `soundtrack.sh` | mixes `media/soundtrack.wav` from the game's CC0 recordings in `public/audio` |
| `src/lib.rs` | the cut: the title, the clips in order with their captions, the closing card |
| `src/main.rs` | the command line (`fframes::cli`); reads `clips/` when it runs |
| `media/` | the fonts (Bebas Neue and DM Sans, both under the Open Font License) |

The clips, the mixed sound and the rendered video are not in git.

## Making it again

```sh
npm run dev                                   # the game, port 5191
node scripts/scene.mjs serve --graphics ultra --size 1920x1080 --out /tmp/trailer-frames
trailer/record.sh                             # every shot, or name some: trailer/record.sh police rain
node scripts/scene.mjs stop
trailer/soundtrack.sh
cd trailer && cargo run --release -- render   # writes out.mp4
```

Traffic and people differ from take to take, so look at a clip before keeping it
(`cargo run --release -- strip -n 12` writes a contact sheet, `frame 22s` one frame,
`preview` plays it). A clip must be at least as long as its scene in `CLIPS` (`src/lib.rs`).
There is no music: `soundtrack.sh` is the place to add a track.

## The atmospheric trailer ("silence / engine")

`atmo.mp4`, 50 seconds: one red car gets faster from dawn to night in bursts that keep
getting shorter, cut against still places (Petřín, the Old Town Square, Charles Bridge,
Letná…); then the dark, and the camera pulls back from the car on most Legií until
every street lamp of the city is in the picture, with what the map holds counted up.

Everything follows one timeline, `atmo/timeline.py`:

| File | What |
| --- | --- |
| `atmo/timeline.py` | how long each quiet shot and burst is, the car's speed, the camera's height through the pull back → `timeline.json` |
| `atmo/shots.js`, `lib.js`, `film.sh` | the shots: places, times, cameras; `film.sh [names]` films them into `clips/` |
| `atmo/engine.js`, `engine.py` | the engine, rendered offline by the game's own engine sound (the `SPORTY` voice in `src/audio.ts`) along the timeline's speed → `engine.wav`, and its revs and gears → `engine.json` |
| `atmo/map.py` | the night maps of the pull back (three pictures, each wider) with all the lamps of `lamps.bin.gz`, and the numbers shown (`stats.json`) |
| `atmo/soundtrack.py` | the sound: engine against near silence, thumps on the cuts, the rush's rising noise, the chord under the pull back → `media/atmo.wav` |
| `atmo/build_data.py` | `src/atmo_data.rs` for the cut |
| `src/atmo.rs`, `src/bin/atmo.rs` | the cut: captions, bars, speed and revs, the maps, the title |

```sh
cd trailer/atmo
python3 timeline.py && python3 map.py         # the map needs numpy and Pillow
./film.sh                                     # with the scene server running as above (about 25 minutes)
python3 engine.py && python3 build_data.py && python3 soundtrack.py
cd .. && touch src/lib.rs && cargo run --release --bin atmo -- render && mv out.mp4 atmo.mp4
```

The speed on screen is the speed the car is held at while it is filmed, and the revs and
gear are the ones the engine sound was rendered with. The numbers at the end are counted
from the map data: lamps in the utility map, buildings and street length (each street
once) in the tiles, and the area the tiles cover, which is more than the city itself.
`atmo-zoom-teaser.mp4` is the last 16 seconds cut out with ffmpeg.
The birds, the night and the bell are the game's CC0 recordings; the rest is synthesized.

## "One day"

`day.mp4`, 29 seconds: the Old Town Square from one spot while the game's clock runs from
04:40 to 23:40, the shadows turning and the lamps coming on, with the time in the corner
and the day's course along the bottom, then the title.

```sh
trailer/day/film.sh                    # 720 frames, about 8 minutes, with the scene server running as above
python3 trailer/day/soundtrack.py      # birds, the garden, the night, a far bell on four of the hours
cd trailer && touch src/lib.rs && cargo run --release --bin day -- render && mv out.mp4 day.mp4
```

The film's length and its first and last time of day are written three times: in
`day/shot.js`, `day/soundtrack.py` and `src/day.rs`. The bell is the tram's, played an
octave and a half lower to stand in for a tower's.

## "The same street"

`street.mp4` (English lines) and `street-cs.mp4` (Czech), 58 seconds, 2.39:1 in a 1080p frame.
One drive along Rašínovo and Masarykovo nábřeží filmed ten times at other hours and in
other weather (mist at dawn, morning, noon, rain, golden hour, dusk, night, a storm, snow,
and a night with the police after you), every take the same shot to the centimetre, cut
from one to the next ever faster; for two seconds five of them stand side by side as one
picture. Then the dark, the pull back from where the drive ended to the whole city, the title.

| File | What |
| --- | --- |
| `street/plan.py` | the drive (how fast at each frame), which camera films which stretch, the takes → `plan.json` |
| `street/route.py` | the car's path, worked out from the street network (straight on at each junction, the game's lane offset, smoothed) → `path.json` |
| `street/cut.py` | the cut (which take shows when), the lines in both languages, what of each take needs filming (`needs.json`), `src/street_data.rs`, the near map for the pull back, and with `sound` the mix `media/street.wav` |
| `street/lib.js`, `film.sh`, `assemble.py` | film a take: the car put on the path at every frame, the camera worked out from the car, and the game's own sound rendered alongside into `street/sound/<take>.wav` |
| `street/finish.sh` | the last pass: contrast, darker corners, grain |
| `src/street.rs`, `src/bin/street.rs` | the picture: bars, the takes and strips, labels, lines, the pull back and title |

```sh
cd trailer/street
python3 plan.py && python3 route.py && python3 cut.py
./film.sh                      # with the scene server running as above (about 40 minutes)
python3 cut.py sound
cd .. && touch src/lib.rs
cargo run --release --bin street -- render && street/finish.sh out.mp4 street.mp4
cargo run --release --bin street -- render --czech && street/finish.sh out.mp4 street-cs.mp4
```

The sound is the game's, with the radio off: for each take the game's sound graph is
built on an `OfflineAudioContext` that is advanced one frame's worth at a time as the
take is replayed, so engine, tyres, rain, thunder, trams and the city's ambience are
what the game would play at that frame. `SOUND_ONLY=true ./film.sh` records it again
without filming. The mix only evens the takes out, cuts with the picture and fades.
A led car collects damage from whatever it brushes; `lib.js` keeps it at none.
