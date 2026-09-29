---
name: sound-levels
description: How Streets of Prague's sound is built and how to tune it without listening, measuring loudness offline instead of in the browser. Use when the user says a sound is too loud, too quiet, too aggressive or in the wrong place, when changing src/audio.ts or src/soundmix.ts, when adding recordings from Freesound (trams, city ambience, birds), or when working on pipeline/build_audio.py.
---

# Sound in Streets of Prague

You can't hear the game, and checking sound through the Browser pane is slow and
fragile. Measure it offline instead: the recorded sounds are files and their gains are
formulas, so their loudness at any place and time can be computed in a few seconds.
Report numbers (dB) to the user and let them judge by ear.

## Where things are

- `src/audio.ts`: the Web Audio graph. Code-made sounds: the player's engine
  (`EngineVoice`: `EVERYDAY` on all cars; `SPORTY` is the old aggressive sound, kept
  for faster cars later, on no car yet), tyres by road surface, rail-joint clicks,
  weather. Recorded: the four nearest trams (`TramVoice`, distance falloff in
  `place()`: `15 / (15 + d)`) and the city ambience (`Ambience`).
- `src/soundmix.ts`: the ambience gains (`AMBIENCE`, `ambienceGains(busy, hour, wet)`).
  Pure, no imports, so Node can run it: the measuring script uses the same code as the
  game. Keep new level formulas there, not in `audio.ts`.
- `public/audio/`: the clips, committed. Tram loops are WAV (gapless), one-offs and
  `amb-*` loops AAC (browsers decode them at their exact length, so no seam gap).
  `SOURCES.md` lists every clip's recording, author and licence.
- `pipeline/build_audio.py`: cuts the clips from Freesound previews (downloaded into
  `pipeline/.cache/audio/freesound/`, no login needed). Loops are evened out to about
  -20 dBFS RMS, one-offs peak at -1 dBFS; birdsong (`song`) isn't evened out.
- `main.ts` passes `busy` (footfall within 150 m / 0.2, capped at 1) and `hour` from
  the game clock into `sound.update`.

## Measuring

```bash
node .claude/skills/sound-levels/levels.mjs            # the ambience mix at 11 places × 4 hours
node .claude/skills/sound-levels/levels.mjs --clips    # plus every clip's own loudness
node .claude/skills/sound-levels/levels.mjs --places "Karlín:14.4520,50.0925" --hours 7,23 --wet 0.8
node .claude/skills/sound-levels/levels.mjs --wav /tmp/mix   # 20 s WAVs of each, for the user to play
```

It prints per place and hour the whole mix, the birds, the birds against everything
else, and the loudest layers, in LUFS (perceived loudness; clip loudness is cached in
`pipeline/.cache/audio/loudness.json`). Run it before and after a change and quote the
difference.

- **LUFS isn't RMS.** Every loop is levelled to the same RMS, yet the blackbird clip
  measures -12 LUFS and the crowd -17.5: high-pitched sounds are heard as louder. Set
  levels by the LUFS the script reports, not by the -20 dBFS the pipeline aims at.
- **Rules of thumb:** 1–2 dB is barely noticed, 3 dB is clear, 10 dB sounds about
  half as loud. When the user says "still too loud", go 6–10 dB, not 2.
- **Busyness is lopsided.** Half the city is under 0.01 and only 3 % over 0.2.
  Measured: Old Town and Malostranské 1, Wenceslas Square 0.9, Náměstí Míru 0.36,
  Jiřího z Poděbrad 0.21, Vinohrady side streets 0.09, Dejvice 0.065, Stromovka 0.056,
  Petřín 0.049, Letná park 0.031, Barrandov 0.007, Kunratice 0.004. Anything meant to
  fade with busyness wants a log scale (as the birds do: none from 0.1, all below
  0.006). The footfall map doesn't know parks, so city parks only get a little.
- **Loud needs room (advice from a game audio designer).** Loudness is perceived
  loudness, and the same mixing principles apply as in music mastering. A sound only
  feels big if the others make space for it: to make one loud, duck the rest. Brains
  prioritise impact sounds, so the first ~0.2 s of an impact (explosion, gunshot) is
  what counts. Duck the ambience, engine and tyres briefly under it, then
  release. Raising the impact's own gain instead makes the whole mix louder without
  making it hit harder. For a new impact sound, add a short duck of the other buses
  (a few dB, ~0.2 s attack, slower release) rather than only setting its level. Meant
  for explosions, gunshots and the like; the game has none yet, and `audio.ts` has no
  ducking today.
- **Not covered offline:** the code-made sounds (engine, tyres, clicks, weather). To
  measure those, run `audio.ts` in Node with the `node-web-audio-api` package (a new
  dependency: check it first), or read the engine's output with an `AnalyserNode` in
  the page (see below).

## Checking in the game

Only to confirm the clips load and nothing throws; the levels come from the script.

- Find the dev server first: several sessions run their own, ports change
  (`lsof -nP -iTCP -sTCP:LISTEN` and each node process's cwd). Don't start a new one
  if one serves this checkout.
- `window.__drive.sound`: `.clips`, `.ambience.gains`, `.engine`, `.voices`. The
  sound may be switched off in the pane's browser (`sound.on === false`); if you
  switch it on to test, keep the master at 0 and put it back, and don't call
  `toggle()` (it saves the choice).
- A hidden Browser pane throttles the game, so long scripts time out: split them
  into short calls. Another session's edit can reload the page mid-script.

## Adding recordings (Freesound)

1. **Search** in the Browser pane on freesound.org (the user is logged in there).
   The API works with that login from the page:
   `fetch('/apiv2/search/text/?query=…&filter=license:("Creative Commons 0" OR "Attribution")&fields=id,name,username,license,duration,previews,description&format=json')`.
   Prefer recordings made in Prague. Never NC licences (see "Licences for added
   assets" in the README).
2. **Ask before downloading**: list each file (id, name, licence, length, size of
   the preview) and wait for a yes.
3. **Download the previews** (`previews['preview-hq-ogg']`) with curl straight from
   cdn.freesound.org: they're public. The Browser pane can't save downloads or reach a
   local server, so the original WAVs are out of reach; the previews are good enough.
   The CDN can be slow: run it in the background.
4. **Pick the stretch** with `windows.py` (next to this file), then add the recording
   to `SOURCES` and a clip to `CLIPS` in `pipeline/build_audio.py` and run
   `cd pipeline && uv run build_audio.py`. Existing clips come out byte-identical.
   Mid-side recordings: channel 0 is the mid, a plain mono recording. Stereo bells
   recorded out of phase: take one channel.
5. **Credit it**: `public/audio/SOURCES.md` always; CC BY also in the README's
   Credits, the in-game credits in `index.html` (`data-t="credits.…"`) and the Czech
   text for that key in `src/cs.ts`.
6. Measure with `levels.mjs --clips`, set the gain, measure again.

## Committing

Other sessions often have uncommitted changes in `src/main.ts`, `src/cs.ts` and
others. Commit only your own hunks: build a patch from `git diff -U1` with just your
hunks, `git apply --cached` it, and typecheck the staged snapshot
(`git checkout-index -a --prefix=<dir>/`, symlink `node_modules`, `npx tsc --noEmit`)
before committing.
