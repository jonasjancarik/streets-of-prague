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
