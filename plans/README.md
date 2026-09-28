# Implementation plans

| Plan | Scope | Status |
| --- | --- | --- |
| [001: Transition to TypeScript](001-transition-to-typescript.md) | Browser `src/`, entry page, compiler gate, documentation | DONE (local) |

Plan 001 was written on 2026-09-28 against commit `4658c59` and an already
modified working tree. Preserve and inspect those edits before implementation.

Implementation verified with `npm run build` (which runs strict typecheck) and
browser startup in default `praha`, `ujezd`, and `centrum`, including a second starting tile,
car entry, developer street search, and visible touch controls. Direct tram
and metro panel interaction was not exercised. Nothing was deployed.
