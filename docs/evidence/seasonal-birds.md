---
read_when: Changing seasonal bird ambience, its date/time curves or suppression rules, or repeating the offline sound check.
---

# Seasonal bird ambience

3 October 2026. The three recorded bird loops previously used only the time of day,
street busyness and rain or snow. They now also read the existing `fresh`, `dry` and
`cold` curves of the fixed game date. No recordings, playback rates, source timing,
engine or tyre sounds change.

Spring adds up to 40% gain during the existing 04:00–10:00 morning window, reaching
full strength from 05:00–08:00. The later parts of the day retain their old levels.
As the dry curve passes 0.2 just after mid-July, gain gradually falls toward 35% in
late August. Winter's cold curve reduces it toward 3%. This represents activity
through the level of existing loops, rather than inventing a new bird-call scheduler.

15 July retains the old mix exactly. Rain and snow still silence birds, busy streets
still suppress them from busyness 0.1, and the existing daily windows remain. Other
ambience layers, high-altitude fading and the metro's master mute are unchanged.
The `Season` object is passed by reference through `SoundState`; no per-frame season
object or additional audio source, gain or filter node is created.

`ambienceGains(busy, hour, wet, season?)` now accepts the optional date curves.
Three-argument callers, including the existing sound-levels measuring script,
continue to return the old summer reference. Use `scripts/check-seasonal-birds.mjs
--clips` for dated offline comparisons. The mix remains a pure module without
browser APIs or imports.

## Offline evidence

`node scripts/check-seasonal-birds.mjs --clips` passed deterministic checks for the
whole year at half-hour intervals, exact July gains, spring mornings, late-summer
and winter reduction, midnight silence, rain/snow suppression, partial-wet fading,
busy-place suppression, smooth date changes and unchanged non-bird layers.
`npm run typecheck` passed after connecting the game date to the audio state.

ffmpeg EBU R128 measured the existing recordings at −12.2 LUFS (blackbird),
−13.7 LUFS (garden birds) and −18.8 LUFS (morning chorus). The table calculates the
combined bird power at busyness 0.004 in clear weather, before the master bus and
compressor, using the same method as the sound-levels helper.

| Date | Time | Activity factor | Gain change from July | Calculated bird mix |
| --- | --- | --- | --- | --- |
| 20 April | 07:00 | 1.400 | +2.92 dB | −31.11 LUFS |
| 20 April | 12:00 | 1.000 | 0.00 dB | −36.43 LUFS |
| 15 July | 07:00 | 1.000 | 0.00 dB | −34.03 LUFS |
| 15 July | 12:00 | 1.000 | 0.00 dB | −36.43 LUFS |
| 20 August | 07:00 | 0.358 | −8.93 dB | −42.97 LUFS |
| 20 August | 12:00 | 0.358 | −8.93 dB | −45.36 LUFS |
| 15 January | 07:00 | 0.030 | −30.46 dB | −64.49 LUFS |
| 15 January | 12:00 | 0.030 | −30.46 dB | −66.89 LUFS |

The dB changes describe gain targets, not measured speaker output or a listening
judgement. Loop phases, the other sound layers, bus volumes and the compressor can
change the heard mix. The offline measurement read the committed clips directly;
it did not download recordings or write shared caches.

## Runtime scheduling

The existing `setTargetAtTime(..., currentTime, 2)` gain smoothing remains. A changed
date therefore approaches the new target continuously over seconds, rather than
jumping the level or restarting a recording. A short Chrome runtime smoke passed
with the master forced to zero before audio initialization, without toggling or
saving the sound preference. It used the existing benchmark harness only to load
the game and inspect audio; its incidental frame timings are not a performance study.

The real game forwarded all four dates to the audio state. Actual scheduled bird
gain targets matched the pure function, with a two-second time constant. The same
seven gain nodes and seven filters remained in place across date changes. Rain and
snow scheduled zero bird targets, and the master stayed at zero throughout. At the
Petřín smoke location (busyness 0.0250), the 07:00 blackbird targets were 0.04920 in
April, 0.03514 in July, 0.01256 in August and 0.001054 in January. See
[the runtime result](seasonal-birds-runtime.json). The owned browser closed and
the GPU lock was released.

The full build, broad listening exercise and unrelated gameplay checks are omitted.
