# Wrap-up final confirmation

read_when: reviewing the independently accepted lamp/tow fixture integrations or the final scene result.

**15 of 15 existing top-level scenarios passed in one normal-order run.** No
scenario assertions were changed for this confirmation, and no rerun or additional
diagnostic scope was started after the result.

## Fixed checkpoint and runtime

- Integration HEAD/source: `edbf011ca44ef2dab1a8cb8747422a83ab586716`, including the
  accepted tow and lamp fixture changes.
- Private final centrum map: built `2026-10-03T05:44:19Z`, unchanged from the earlier
  final suite; map pipeline `ae86cf4823`.
- Chrome using the actual WebGPU backend; 1280×800, DPR 1, High graphics. Initial
  URL: `place=staromak&go&day=wed&time=14:00&weather=clear&date=10-03&area=centrum`.
- Run on 3 October 2026, **11:23:51–11:24:26 Prague time**
  (09:23:51–09:24:26 UTC).
- 136 source files and all 804 map files fingerprinted before and after; HEAD,
  source and map remained unchanged. Aggregate SHA-256 values:
  - Source: `3d97da9fcc7902ee8950bfdf0e1d4233f8d6e1b516a4d8c9fb38a4111d4e78b0`
  - Map: `d57d814798fe4cd7c99a79d34c4cc6daac9b6c08f581b9780cf64ece53c4df52`

## Requested CPU checks

All passed:

- [Typecheck](typecheck.log)
- [Lamp runway fixture](lamp-cpu.log)
- [Tow fixture](tow-cpu.log)
- [Scenario starting state](scenario-start-cpu.log)

## Full existing suite

| Scenario | Result |
| --- | --- |
| ambulance | Pass |
| boat-boarding | Pass |
| bridge-exit | Pass |
| bus-displays | Pass |
| fire-brigade | Pass |
| fire-driver | Pass |
| heli-bridge | Pass |
| lamp-knock | Pass |
| police-chase | Pass |
| police-stand-down | Pass |
| police-stolen-lights | Pass |
| seasonal-ground | Pass |
| vehicle-entry-order | Pass, including both original nested assertion sets |
| wall-crash | Pass |
| wreck-tow | Pass |

No scenario or observation reported a page/console error. The normal-action player
preparation remained active. Cases shared the live world rather than starting a
fresh page each time. The existing `vehicle-entry-order` scenario internally runs
heli/lamp scenes; those nested runs are part of its normal definition.

[Complete assertions, observations and hashes](results.json), [run log](run.log),
and [finite observation-only collector](run-suite.mjs) are preserved in this
assigned directory. Native screenshot names can be reused by nested scenarios;
those files represent their last capture, while JSON preserves each result.

## Cleanup and limits

The scene/browser/controller PID 22548 is stopped, port 5315 is closed, and the
owned GPU lock is released. Port 5204 was not listening at the start, so the existing
integration command was restarted with existing dependencies; PID 21509 remains
available for parent handling. Its registration is retained.

Only this evidence directory was written. Production source, main, map data and
other evidence/handoff files were untouched. This is ready-to-commit evidence,
left uncommitted for the parent. No rebuild, additional full pass, alternate
renderer or broad benchmark was performed. The 15/15 result is one successful
behavior run on this frozen snapshot, not a claim about every future live-world
ordering or device.
