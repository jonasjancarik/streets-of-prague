# Licences to check before a wider release

Written on the night of 5 to 6 October 2026 from public pages and the installed package. This is
research for the owner, not legal advice. Two things were open in `todo.md`: what licence TSK
Praha's data carries, and whether `straight-skeleton` brings GPL code into the game.

## TSK Praha's data

The credits (`src/cs.ts`, keys `credits.tsk` and `credits.traffic`, and the English copy beside
them) name TSK Praha twice and state no licence for either:

| What the game uses | Where it comes from | Used in |
| --- | --- | --- |
| Paid-parking zones, their number of spaces and how full they are by day and by night | The monthly occupancy files published at `zps.tsk-praha.cz` (`parked_cars`, one file per district and month), downloaded into `~/projects/parkovani-praha` | `pipeline/build_parking.py`, `src/parking.ts`, `src/parkingDemand.ts` |
| How busy the main roads are hour by hour (24 numbers per day type) | TSK's measured travel times (`fact_v_route_travel_times.csv`), as published on Data Praha's traffic dashboard (`data.praha.eu/dashboardy/dopravni-ukazatele`) and kept in `~/projects/doprava-praha` | `pipeline/build_traffic_profile.py`, the constant `TRAFFIC_LOAD` in `src/traffic.ts` |

What I could establish:

- `zps.tsk-praha.cz` answers a plain request with HTTP 401, so its terms of use could not be
  read from here, and a web search found no licence statement for the occupancy files. Nothing
  on the pages I could reach says CC BY or any other open licence for them. The same search found
  that TSK stopped giving out the data that checks parking permits after a data-protection
  ruling; the occupancy statistics are a different dataset, but it shows TSK is careful here.
- The traffic dashboard shows "Waze for Cities" as the source of the travel times, so the
  rights may sit partly with Waze and the city, not only with TSK. The page states no licence
  either. Data Praha's catalogue (`opendata.praha.eu`, run by Operátor ICT as the Golemio
  platform) uses CC0 and CC BY for many datasets, so the dataset's own catalogue entry is where
  the answer should be.
- The game ships only derived numbers (per-street parking spaces and occupancy in the map
  tiles, 72 traffic numbers in the code), not the files themselves. That helps if the data
  turns out to be free to use with attribution, and does not help if its terms forbid use.

To do, by a person with a login or an email:

1. Open the dataset pages for the occupancy files and the travel times on `opendata.praha.eu`
   and read the licence field. If one says CC BY 4.0, change the two credits to name it, as the
   IPR and PID lines already do ("CC BY 4.0").
2. If no licence is given, write to TSK Praha (`tsk-praha.cz`, "Poskytnuté informace" page) and
   ask which terms apply to the occupancy data and the travel times, and whether the credit line
   is enough.

## `straight-skeleton` and CGAL

`straight-skeleton` 3.0.0 (npm, author StrandedKitty) declares MIT, and its own code is MIT. Its
README says it "wraps the basic functionality of CGAL's straight skeleton implementation using
Wasm". The built `dist/index.js` (1 MB) contains the compiled WebAssembly (`_create_straight_skeleton`,
an Emscripten build), so the CGAL code itself is inside the file the browser downloads.

CGAL's package "2D Straight Skeleton and Polygon Offsetting" is licensed GPL (its reference pages
from version 4.5 to 5.5.1 say so; other CGAL packages are LGPL, and the straight skeleton is one
of the GPL ones). I did not check version 6 of CGAL, and I did not find which CGAL version the
wasm was built from. The npm licence field says MIT because it describes only the wrapper.

What that means:

- Shipping the wasm in the browser bundle is distributing a work that contains GPL code. The GPL
  asks that the whole combined work is offered under the GPL, with its source, to everyone who
  receives it. Today the game is served from `streetsofprague.com`, so the game's code is
  distributed to every visitor. `licenses.txt` (written by the build) lists `straight-skeleton`
  as MIT and the credits say "open-source libraries", which is accurate for the wrapper and
  silent about CGAL.
- Whether the repository is public, and under what licence, decides how serious this is. If the
  game's source is not published, the GPL terms are not met. If it is published under a licence
  that is GPL-compatible, they are close to met.
- The one place it is used is the roof builder in the tile worker (`src/tileWorker.ts`, `src/tiles.ts`),
  so the dependency is narrow.

Options, cheapest first:

1. Publish the game's source under a GPL-3.0-compatible licence and name CGAL and its GPL in
   `licenses.txt` and the credits. No code change; it limits what the owner can later do with the
   code (closed source, app stores that conflict with the GPL).
2. Buy a commercial CGAL licence from GeometryFactory for the straight-skeleton package. No code
   change; costs money and needs a contract.
3. Replace the library. Version 1 of the same package is "less robust but faster" and written in
   pure TypeScript (the README says so; check that it is MIT and not derived from CGAL, and
   how it copes with the odd footprints in OSM). Other pure-code straight skeletons exist (for
   example JavaScript ports of `polyskel`); each needs the same check, and a measured comparison
   of roof quality and build time, because roofs are the slowest part of a tile.
4. Build the roofs in the pipeline instead of the browser. Using CGAL inside the build is not
   distribution, and the data it produces is not covered by the GPL; but the game would then
   ship heavier tiles and lose roofs for tiles that are made in the browser, so it is a large
   change.

Recommendation: option 1 or 3. For a fast decision, ask whether the owner wants the game's
source public; if yes, option 1 plus a line in the credits closes the issue this week, and the
roof builder can be swapped later without hurry.
