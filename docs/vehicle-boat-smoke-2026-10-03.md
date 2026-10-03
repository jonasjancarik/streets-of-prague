---
read_when: Reviewing the accepted boat, bus-display and stolen-police-light integration, or repeating its focused smoke check.
---

# Boat and vehicle integration smoke

The three focused scenarios passed from fresh page state on integration commit
`5f66b6565aa588f0bf87e6de9926607b8a52b6c6` on 3 October 2026, 04:32–04:33 Prague
(02:32–02:33 UTC). This report commit changes no implementation. The tile-download
fix `ae1a49f` was not integrated and is outside this result.

## Code, map and browser

The tested checkout was `/Users/janca/.codex/worktrees/overnight-city-integration/streets-of-prague`,
clean before and after the browser batch. It includes the accepted boat changes
`e88f704` and `cf1e1a8`, vehicle changes `9a3b20e` and `00222e6`, and vehicle triage
`5c72c3d`; their integration ends at `5f66b65`.

The existing strict centrum generation was reused without rebuilding:

- Built `2026-10-03T00:26:37Z`, pipeline `5182c47670`, format 2, 234 tiles.
- Index SHA-256 `c2ec699a13d019ae552860f53a467ad50863843a751bd8557f55e1407f01f0a3`.
- Every fresh page asserted WebGPU, centrum, and the same served build/pipeline markers.
- Google Chrome through the existing scene runner; 1280×800, DPR 1, High graphics,
  clear weather, date `10-03`. Each case began on foot with a fresh page and `?go`.
- Game server `http://localhost:5204/`, owned scene runner on 5307. The shared GPU
  lock was acquired after parking's completed replay and the seasonal WebGPU batch.
  No other game browser was launched by this task; its browser closed before releasing the lock.

## Results

Typecheck and the CPU boat-access regressions passed before browser work. The
separate [CPU vehicle fixture](evidence/vehicle-boat-smoke-2026-10-03/vehicle-cpu.mjs)
checked bus/minibus route text, direction changes, missing/empty/burnt states,
400 stable renders, retained resources, police ownership/light lifecycle, instance
colour changes, chase-list separation and the testkit entry/route helpers.
The CPU police fixture uses the police dimensions on a procedural body; the real
loaded model and beacon instances were checked in the game separately.

| Focused scenario | Result | Checks | Scope |
|---|---|---:|---|
| `boat-boarding` | Pass | 10 | All three moored boats had reachable banks and passed ordinary boarding/exiting. |
| `bus-displays` | Pass | 5 | Loaded PID metadata, bus/minibus route numbers and destinations, and re-entry. |
| `police-stolen-lights` | Pass | 9 | Stopped/forward/reverse lights, exit/re-entry, theft once and stand-down. |

The existing live resource checks also passed on the same WebGPU page:
`check-bus-displays.mjs` exercised 200 renders with three retained boards, no new
per-frame canvases/textures, and correct hidden states. `check-police-lights.mjs`
verified two roof lamps whose colours changed while stopped, their removal on exit
or burnout, re-entry restoration and zero final instances. Both returned no
collected page errors. No source defect was found by this smoke check.

Raw [scenario results and exact camera snapshots](evidence/vehicle-boat-smoke-2026-10-03/results.json),
[bus resource result](evidence/vehicle-boat-smoke-2026-10-03/bus-resources.json),
[police resource result](evidence/vehicle-boat-smoke-2026-10-03/police-resources.json),
and [CPU/scenario logs](evidence/vehicle-boat-smoke-2026-10-03/) are retained.

## Views and limits

The later [minibus overhead view](evidence/vehicle-boat-smoke-2026-10-03/minibus-route-overhead.png)
clearly shows roof labels 194 and 148. The [bus front capture](evidence/vehicle-boat-smoke-2026-10-03/bus-route-front.png)
contains part of the loading-screen fade: the runner considers `.done` ready, while
`index.html` fades the overlay over 0.6 seconds. Preserve this capture as taken;
it is not a clean visual comparison. The [stopped police view](evidence/vehicle-boat-smoke-2026-10-03/police-stolen-stopped.png)
records one strobe phase; animation is established by the instance-colour check,
not a single still. The boat scenario records behaviour and heights, with no new screenshot.

No full scenario suite, phone check, WebGL run, timing benchmark, map rebuild,
main merge, push or deployment was included. Known broad-suite failures remain
covered by the separate vehicle triage report. This smoke does not establish a
performance gain or validate every river bank. The earlier boat day/night and
Legion Bridge results used the older map snapshot and remain separately qualified.

The owned scene browser and GPU lock are closed/released. The pre-existing
integration Vite server remains on port 5204; the no-longer-needed owned boat
review server on 5207 was stopped. Weekly quota was 91% remaining at closeout,
above the user's 50% stop threshold.
