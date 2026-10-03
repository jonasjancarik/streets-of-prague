# Lamp impact wrap-up

read_when: reviewing the final-suite lamp failure or the impact-runway fixture.

The final 13/15 suite's first lamp failure remains recorded in the integrated
report. This wrap-up uses isolated worktree `lamp-final-wrap` from
`46b1f3e14e5f96161351c1da7609dfb75f5bee10`, private APFS dependencies/data, and the
same centrum map built `2026-10-03T05:44:19Z`. No main, integration or shared map
files were changed.

## Demonstrated cause

The seven necessary predecessors were replayed once in normal order: ambulance,
boat-boarding, bridge-exit, bus-displays, fire-brigade, fire-driver and heli-bridge.
All passed. The following lamp case reproduced the two failed assertions: its post
remained standing and the car ended at 1.7 km/h. This is the same assertion failure
class as the final suite, not an identical complete-world-state reconstruction.

The selected standing lamp was `(292.486212488, -105.818985025)`, radius 0.18 m,
height 16.800, toughness 9 m/s. `aimAt` chose a car start at
`(275.099547615, -110.477727837)`, heading 15°, 18 m back. The initial checks found
no nearby car obstruction.

On physics steps 1 and 2 the car's velocity was changed by `collideBodies`. The
recorded call stack resolves to served `src/main.ts:1984`: the tram loop calls
`collideBodies(t, t.circles, 1.25, 0, a, ca, a.r, 1/a.mass)`. Thus the actual
intercepting body was an immovable tram collision body, not the selected post.
The grid/post/fence observers recorded no impact in that failed replay. At the
first recorded mutation the car was `(275.212265561, -110.297321978)`; velocity
changed from `(13.40598, 3.59212)` to `(9.70932, 7.61673)` m/s, then again on the
second step. [The full trace](first-lamp.json) preserves the pose, call sites,
trajectory and selected-post geometry.

The first trace did not capture the specific tram vehicle ID/circle array. A later
fresh probe captured KT8 tram ID 94, route 9 to Spojovací, including all 21 collision
circles and level heights, but that is **not asserted to be the original colliding
tram**. It tested the standing wire pole nearest the saved failed position and
passed at 19.7 km/h; [its record](saved-wire-confirmation.json) is a separate
candidate/control, not a replacement for the failed trace. The intermediate
`saved-vicinity-wire-replay.json` stopped at ordinary car-entry failure and provides
no impact evidence. Observer delegates preserve original collision calls and
values; no post state or collision response was forced.

## Fixture repair

`aimAt` previously checked only the collision grid and nearby cars. A standing or
moving tram can occupy a run that passes those checks. The helper now queries
`Trams.bodies` and tests every longitudinal car collision circle along each trial
approach against the same 1.25 m tram circles used in gameplay, with 0.2 m setup
clearance. It tries a clear alternative or reports no clear run without relocating
the car. Gameplay collisions and the original post-down/speed assertions are intact.

This clearance omission predates the overnight work: the `aimAt` corridor and
tram/post collision code in `b3c22d5` and `46b1f3e` are unchanged in the relevant
paths. No introduced gameplay defect was demonstrated. The exact collider/target
of the earlier immutable full-suite run cannot be proven from its saved data; its
original position and 0.2 km/h outcome differ from this reproduced failure. The
repair addresses a directly observed fixture defect without claiming a new green
full suite or universal immunity to later moving traffic.

## Verification

- `npm run typecheck`, `node scripts/check-scenario-start.mjs`, and whitespace checks pass.
- `node scripts/check-lamp-runway.mjs` passes: occupied tram approach rejected,
  full-body alternate approach clear, empty approach unchanged, fully blocked
  target fails without placement.
- Actual WebGPU [standalone lamp](after-fix/standalone.json): post down, retained
  speed 21.6 km/h; all original assertions pass.
- Existing [helicopter-to-lamp order](after-fix/order.json): both complete assertion
  sets pass, lamp speed 15.2 km/h.
- [Runtime provenance](after-fix/provenance.json): WebGPU and the final map marker.

No full-suite repeat, map rebuild, alternate-renderer run, build or timing benchmark
was used. Only finite diagnostic and confirmation browser batches were started;
owned browsers/locks are closed after capture. The local dev registration is kept,
and its owned server is stopped at handoff. No push or deployment.
