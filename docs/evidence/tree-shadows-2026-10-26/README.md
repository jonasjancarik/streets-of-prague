# Tree shadow experiment, 26 October 2026

The opt-in `?treeShadows=simple` mode uses eight existing rim vertices per broadleaf
tuft during the shadow pass. The main pass retains all vertices. Ordinary crowns
use 148 shadow triangles instead of 340; big crowns use 292 instead of 564. Shrubs
(92) and conifers (180) are unchanged. Both index ranges live in one shared buffer;
the two extra ranges total 2,640 bytes of uint16 indices across the forest's shapes.
There are no additional meshes, instance uploads, materials or draws. The original
seasonal twig mask and instance outlines still run. Shadow edges can be a little
coarser and smaller; visible crown geometry is unchanged.

## Measurement setup

Base source: `00499184b2838d06f8326b8d83455fd012a09dbd`, plus the vegetation change.
A frozen copy was served at port 5193, sharing the local public assets. The measured
vegetation source SHA-256 was
`b918a881819d1bbd1fa0158d1dbb3727a06fdc2869857325917db260bc3be6b1`.
The final source differs from that snapshot only in its explanatory opt-in comment.
The unrelated dirty `main.ts` and launch configuration were not in the snapshot or
this change. Tests on the main checkout also included the user's main.ts changes.

Google Chrome on Pixel 5, Android, WebGPU required, High, DPR 1, clear weather at
14:00. Summer is `date=07-15`, winter `date=01-15`. Each phone comparison alternates
five full and five simple four-second windows, after four seconds warming each
mode. The initial control uses the full mode for both labels. Starting battery
temperatures were 26.0 C (control), 26.7 C (forward), 29.5 C (reverse), 33.5 C
(winter), 33.6 C (verified drive) and 33.1 C (reversed verified drive). These are
battery readings, not direct GPU temperature measurements.

The A/B baseline includes the added hooks and combined index buffer; it isolates
changing shadow topology, not the whole patch against a pristine old build.
The temporary harness additions in `benchmark-instrumentation.patch` retain raw
frame timestamps/JS samples, take optional phone screenshots and record the car
fixture. They were applied only in the snapshot; the repository benchmark is
unchanged. `frame-summary.json` computes percentiles from adjacent timestamps
within each window, excluding the harness's deliberate transition gaps. Counts
above 50 ms are frame gaps, not browser Long Task API measurements.

## Results

The table uses the harness's mean window FPS and reciprocal frame cost, rather
than pooled raw intervals; the latter are separately available in frame-summary.

| Device / scene | Full FPS | Simple FPS | Full / simple ms per frame |
| --- | ---: | ---: | ---: |
| Pixel 5 summer woods, forward | 26.5 | 30.0 | 37.7 / 33.4 |
| Pixel 5 summer woods, reversed | 26.4 | 29.8 | 37.9 / 33.5 |
| Pixel 5 suburb, forward | 32.4 | 36.2 | 30.9 / 27.7 |
| Pixel 5 suburb, reversed | 32.7 | 35.9 | 30.6 / 27.9 |
| Pixel 5 winter woods, one comparison | 19.9 | 23.2 | 50.4 / 43.2 |
| Pixel 5 verified drive, forward | 29.4 | 33.2 | 34.5 / 30.3 |
| Pixel 5 verified drive, reversed | 31.3 | 29.7 | 32.1 / 34.3 |
| M5 woods, one comparison | 156.6 | 159.3 | 6.4 / 6.3 |
| M5 suburb, one comparison | 308.6 | 314.9 | 3.2 / 3.2 |

The phone control differed by 2.2% in frame time with identical rendering. Summer
woods improve by about 11.5% in both orders; suburb improves by about 9–10.5%.
Pooled p95/p99 intervals also improved in those static summer comparisons: woods
p99 about 111.4 to 100.3 ms, suburb about 89.2 to 78.0 ms. This does not establish
less stutter across a whole drive. Winter's 14.3% frame-time improvement is from
one alternating comparison, without a reversed winter run.

Driving remains inconclusive: the two verified runs disagree. They used an explicit
`__test.drive('hatch')` fixture and ended in a car at about 13.9 m/s, respectively
329 and 337 m from their fixture starts. A/B windows on a moving route see different
scenery; their later windows often ran faster in either mode. The reversed drive
also overlapped the desktop noise control: separate GPUs avoid direct GPU contention,
but their shared local server is a possible streaming confounder. Neither verified
run is discarded. The earlier drive in `phone-reverse.json` logged an entry warning
and had no car-state verification; it is retained but excluded from driving claims.

The desktop control differed by 0.7%. The single candidate comparisons favoured
simple mode by 1.7–2%, but other apps already held the GPU around 78–84% busy and
no reversed desktop comparison was run. Treat this as provisional, not proof of a
general desktop gain or no regression. No other phone/GPU was measured.

## Verification and decision

Passed: `npm run build` (includes typecheck); offline `check-tree-shadows.mjs`;
real WebGPU and legacy WebGL checks in spring, summer, autumn, winter and settled
snow; `check-tree-pool.mjs --case all` both normally and with `--simple-shadows`;
`tunnel-layers` with simple mode enabled. The pool checks retain UUID/buffer identity,
release/refill behavior and no new builder on prepared first use. They do not prove
that an entire new district contains no unrelated shader builds.

The seasonal checks compare actual submitted ranges, draw counts and instance
counts, then switch back and require restoration. At the fixed summer Petřín view,
tree main-pass triangles remain 4,492,548, while tree shadow triangles fall from
4,641,268 to 2,173,924 at the same 29 shadow draws. Other seasons retain their own
culling/coverage and also reduce shadow triangles without changing main geometry.
Matched top-down images were reviewed; the retained summer/winter pairs illustrate
the look. Snow and foliage still draw. The full gameplay scenario suite was not run;
the targeted rendering/lifecycle/tunnel checks cover this change's scope.

Keep the prototype opt-in. Its fixed-view Pixel 5 benefit is repeatable, while a
matched-route phone comparison and a quiet, reversed desktop comparison are still
needed before broad default adoption. Do not describe this as a general 10% driving
speedup, enable a different graphics tier, or reduce tree density.

## Reproduce

Use a stable served snapshot and the performance skill. Apply the instrumentation
patch to that snapshot only if raw windows/fixture receipts are wanted. The forward
phone command (actual device ID must come from `adb devices`) was:

```sh
node scripts/bench.mjs --url http://localhost:5193/ --android 09081FDD4001DA --scenes woods,suburb --seconds 40 --window 4 --warmup 4 --dpr 1 --graphics high --time 14:00 --weather clear --extra '&date=07-15' --require-webgpu --loading-frames --ab "(async()=>{const m=await import('/src/map/vegetation.ts');window.__ab=on=>{m.SIMPLE_TREE_SHADOWS.value=on}})()" --json /tmp/tree-shadow-phone-forward.json
```

For reversed order use `value=!on`; in reverse JSON, `off` is simple and `on` is
full. For the control use `window.__ab=()=>{}` in a fresh page with the full default.
Winter changes the date to `01-15`. Desktop omits `--android` and used 24-second
comparisons with three-second windows/warmup. The verified drive additionally used:

```js
// --eval
(async()=>{await window.__test.drive('hatch');const c=window.__drive.car;if(!c)throw Error('No driving car');window.__driveStart=[c.x,c.y];return {car:c.type}})()
// --ab, with =!on for reversed order
(async()=>{const m=await import('/src/map/vegetation.ts');window.__ab=on=>{if(!window.__drive.car)throw Error('Lost driving car');m.SIMPLE_TREE_SHADOWS.value=on}})()
```

For seasonal checks, start `scene.mjs serve` with the desired backend, then run
`node scripts/check-tree-shadows.mjs --url http://localhost:5191/`. Stop that browser
before benchmarking. These checks require actual frames; repeated manual `render()`
calls within a single animation frame can skip the shadow update.
