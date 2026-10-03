---
read_when: Checking plan 023 seasonal surface colours, reproducing its renderer captures, or interpreting the ground-cost measurements.
---

# Seasonal ground checks

3 October 2026. Renderer source snapshot: `37fedb0`, following `0a6525c` (the final
street camera is adjusted in the evidence commit). Step 3 changes
grass, woodland floor, fields and evergreen hedges in both renderers. The date
stays fixed; the terrain geometry and tree implementation are unchanged.

`groundSeason.ts` computes linear colour multipliers when the date changes. Grass
also changes the strength of its existing dry patches. Neither renderer adds
texture reads. The original palette and patch strength are restored exactly on
15 July. Woodland litter approaches `#80633f`, spring crops `#79a452`, and harvested
fields `#947658`. Hedges retain their leaves and opaque shadows throughout the year.

## Visual checks

The three comparison sheets pair WebGL and WebGPU on each of eight dates:
15 January, 15 March, 20 April, 20 May, 15 July, 20 August, 20 October and
15 November. Each `seasonal-ground` scenario passed 30 checks. Its developer panel
is hidden during capture; the clock is held at 14:00 and the weather is clear.
The original 1280 × 800 PNGs remain in `/tmp/streets-season-step3/{webgl,webgpu}`;
the sheets use proportional reductions of those images.

| View | Latitude, longitude | Height / tilt / heading | Sheet |
| --- | --- | --- | --- |
| Kampa lawn | 50.083, 14.4073 | 70 m / 30° / 90° | [park](park.jpg) |
| Mapped Petřín wood | 50.08456415, 14.39211258 | 55 m / 35° / 90° | [woodland](woods.jpg) |
| Karlovo náměstí street | 50.0757, 14.422 | 55 m / 35° / 270° | [street](street.jpg) |
| Mapped field | 50.04907455, 14.49817345 | 180 m / 25° / 90° | [field](field.jpg) |
| Mapped hedge | 50.08511022, 14.43052256 | 25 m / 35° / 0° | [hedge](hedge.jpg) |

The field views cover April, July, October and January and found seven non-empty
field meshes in each renderer. They show green crops, summer straw and harvested
earth. The hedge views cover April, July and January; foliage, texture and shadows
remain present. No errors were reported by the final capture commands.

The centrum map marker is `2026-10-02T20:16:12Z`; the field's praha map marker is
`2026-10-02T20:51:35Z`. Both were private APFS clones of existing local data. Each
browser reported the intended backend. The served source was this worktree on
port 5408. No map rebuild or download was performed.

At the fixed July Kampa camera, 41 ground meshes were switched to the original
summer shader variant without changing geometry, camera, weather or date. The
mean absolute screenshot difference was 0.0182 channel levels out of 255 on WebGPU
and 0.0160 on WebGL. The pictures visually match; this is not a claim of pixel
identity. The CPU regression also checks exact summer factors, brown woodland
colour in linear space, daily colour continuity, restoration after date changes,
stable uniform objects and evergreen hedge semantics.

## Ground cost

Google Chrome 154 on the M5 MacBook Air, High, 1440 × 900 viewport, 2× renderer
resolution, clear 14:00 on 15 November. The camera and date were fixed with the
test API, and simulation was paused. Each run alternated original-summer and
seasonal ground materials in two-second windows for 16 seconds, warming both
states for two seconds first. A second run reversed the starting state. An
unchanged-state control used the same camera and timing with no material switch.

The comparison preserves each surface's pattern, relief, sky shading, cutaway,
weather and lighting. It does not flatten the ground or remove geometry. Hedge
tint is present in both states and is not separately timed. The `summerGround()`
material hook is only a measurement aid; normal play creates no comparison clones.

| WebGPU run | Original → seasonal mean ms/frame | Change | Original → seasonal p95 / p99 ms |
| --- | --- | --- | --- |
| Petřín, summer first | 8.580 → 8.635 | +0.6% | 16.0 / 180.4 → 16.4 / 177.0 |
| Petřín, seasonal first | 9.526 → 8.492 | −10.9% | 17.4 / 195.4 → 17.4 / 192.2 |
| Kampa, summer first | 3.321 → 3.338 | +0.5% | 16.2 / 36.7 → 16.3 / 51.9 |
| Kampa, seasonal first | 3.381 → 3.367 | −0.4% | 16.0 / 36.5 → 16.0 / 36.6 |

The unchanged Petřín control changed from 8.663 to 8.847 ms (+2.1%). Its p95 was
16.9 ms in both states; p99 was 184.7 and 188.5 ms. Draw calls and triangle counts
were identical between the states of every feature comparison: 112 calls and
about 4.37 million triangles in Petřín, 118 calls and about 1.11 million at Kampa.
Triangle counts differ slightly between fresh page loads, so these are within-page
comparisons, not claims of identical populations across all runs.

**The WebGPU ground cost is unresolved.** The small forward differences fall
inside the control's variation, while the Petřín reverse result changes direction
substantially. The runs were CPU limited; after the reverse run Spotlight was
using approximately one core. Memory pressure was normal and GPU use was 0% before
the batch. The observation does not establish Spotlight as the cause of the
contradiction. No valid slow windows were discarded. These uncapped desktop
numbers do not prove smoother play or establish a phone cost.

| WebGL run | Original → seasonal mean ms/frame | Change | Original → seasonal p95 / p99 ms |
| --- | --- | --- | --- |
| Petřín, summer first | 10.802 → 10.787 | −0.1% | 11.9 / 28.4 → 11.9 / 28.4 |
| Petřín, seasonal first | 10.568 → 10.507 | −0.6% | 11.7 / 28.2 → 11.6 / 28.2 |
| Kampa, summer first | 4.591 → 4.583 | −0.2% | 5.6 / 9.1 → 5.6 / 9.1 |
| Kampa, seasonal first | 4.675 → 4.687 | +0.3% | 5.6 / 9.3 → 5.6 / 9.1 |

The unchanged WebGL Petřín control was 11.420 versus 11.415 ms (−0.04%); p95
12.2 versus 12.1 ms, p99 29.3 versus 29.4 ms. Each feature pair preserved its draw
calls and triangles: 110–112 calls and about 4.37 million triangles in Petřín,
116 calls and about 1.10 million at Kampa. No console or page errors were recorded
in any timed run. The reverse and control fixtures explicitly checked the actual
2× pixel ratio; logs also record High, the backend, camera and map marker.

These short WebGL comparisons found no consistent added frame time, but do not
establish a gain or a precise cost at sub-percent differences. The fresh-page
Petřín mean also varied by about 6% between the feature and control batches.
The study therefore leaves ground cost unresolved in both renderers. After the
WebGL batch, GPU use was 0%, memory pressure normal and system load about 3.

Raw A/B results retain each window's frame timestamps, draw calls and triangles.
The temporary harness was a copy of `scripts/bench.mjs` with only those arrays
added to its A/B result, leaving scheduling and mean-FPS aggregation unchanged.
The table's means are the harness's mean reciprocal window FPS; percentiles use
the unfiltered adjacent timestamp differences within each measured window.
Unsupported GPU timers remain unknown.

## Repeating the checks

Run `node scripts/check-ground-season.mjs` and `npm run typecheck`. For the visual
scenario, use `scripts/scene.mjs serve --url <server> --port <scene-port> --date
summer --extra '&area=centrum&dev'`, then `run seasonal-ground` on that scene port.
Repeat with `&renderer=webgl`, closing the first browser before starting the next.
The cameras and dates are in `scenarios/seasonal-ground.ts`.

For a ground-cost comparison, `scripts/bench.mjs --ab` can cache each material's
`userData.summerGround()` and alternate it with the original material, preserving
the geometry. The benchmark fixtures and temporary raw-interval harness remain
in `/tmp/streets-season-step3/`. Both states must be warmed; keep one rendering
game at a time and use the shared GPU and heavy-work locks during overnight work.

Typecheck, whole-year CPU regressions and the focused real-renderer checks passed.
The full production build and unrelated gameplay scenarios were intentionally
skipped. No push, deployment or integration checkout writes were made.

The owned scene and benchmark browsers are closed and both locks were released.
The registered dev server remains on port 5408 in the `8ccf` worktree. Loopback
and the LAN URL were verified. The Tailscale hostname exists but Tailscale was
stopped, so that access path was unavailable.
