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

**Done on 7 October 2026: the library is gone** (option 3 below). The game's pitched roofs
are now built on its own straight skeleton, `src/map/skeleton.ts`, written for the game
from the definition of a straight skeleton and holding no code from CGAL or from any
other library. `straight-skeleton` is out of `package.json` and the lockfile, the build
no longer holds WebAssembly or CGAL (searched: no `.wasm` file, and no "CGAL",
"create_straight_skeleton", "wasm" or "WebAssembly" in any built file), `licenses.txt`
no longer lists it and the credits no longer name it. Nothing was added to `licences/`:
that folder is for bundled packages that ship no licence text, and none was added.

What was looked at before writing our own:

| Candidate | Licence, and what it carries | Health | Verdict |
| --- | --- | --- | --- |
| `straight-skeleton` 1.1.0, the pure TypeScript version of the same package | MIT (vHawk). A port of StraightSkeletonNet (`reinterpretcat/csharp-libs`, Apache-2.0), itself a port of `kendzi/kendzi-math` (BSD-3-Clause): clean, no CGAL | Last 1.x release March 2023; the package's 11,000 weekly downloads are for all versions | Not good enough: on 10,275 roofs of the sample its skeleton failed on 896 (8.7 %), which would have gone flat, and 98 more did not cover their footprint |
| `straight-skeleton-geojson` 0.1.1 | MIT, adapted from the above | 36 downloads a week; its README lists footprints with holes as not done | The same algorithm, without courtyards |
| `@proc-geo/core` 0.2.1 | MIT, own code | 21 downloads a week, a personal project | Simple polygons only, no courtyards |
| `@matthewjacobson/str8` 0.5.0 | MIT wrapper | | CGAL in WebAssembly again: the same problem |
| JavaScript ports of `polyskel` | `polyskel` is LGPL-3.0 | | Not permissive |
| Roofs made in the pipeline | CGAL used only at build time would be fine | | Heavier tiles, a map rebuild, and no roofs for the countryside tiles made in the browser; not needed |

How the replacement compares with the library (`scripts/roof-compare.mjs`, which builds
every building of `ujezd`, `centrum` and every 40th tile of `praha` through the roof
builder; and one-off runs of both skeletons side by side while the library was still
installed):

- All 10,275 pitched roofs of the sample are as high as before at every sampled point, to
  within 2 cm (667,150 points). None newly flat, none newly roofed. The triangles and the
  per-slope shades are the same too, because the new code gives its polygons in the
  library's order.
- On every building of the three areas (257,457 footprints, flat-roofed ones included,
  44 million points) the two skeletons' surfaces agree to within a millimetre on 257,449
  and within 2.3 mm on three more, when each footprint is first moved to the origin. Of
  the other five, the library gives nothing for four that now get a roof, and neither
  gives one for the fifth (`way/50148306`, the only footprint in Prague without a
  skeleton, before and after).
- With the coordinates the game really passes, the library's roofs were up to 17 cm off
  on three footprints and 1 to 10 cm off on 495: it read coordinates as 32-bit numbers,
  a millimetre coarse 15 km from the map's middle, which moved its corners. The new code
  works in 64 bits and is the more exact of the two there.
- Random footprints (9,000: houses of grid squares, stars, courtyards, turned,
  stretched, some rounded to the centimetre): the same surface, to a quarter of a
  millimetre, wherever the library gave one. The library ran out of its 2 GB of memory
  on some and gave nothing for 104 that the new code roofs; the reverse never happened.
- Time: 1.3 ms a tile where the library took 35 to 56 ms (the slowest tile 73 ms for
  0.9 to 1.2 s), and no WebAssembly to start in each tile worker.
- The built JavaScript is 2.06 MB smaller (5.03 → 2.97 MB; gzip 1.57 → 0.91 MB): the
  WebAssembly was in both the main bundle and the tile worker.

What is not as good: the new code works in ordinary floating point with a tolerance of a
thousandth of a millimetre, where CGAL computed exactly. No footprint in Prague shows a
difference, but a footprint could exist on which it goes wrong; it then checks that its
slopes cover the footprint exactly, and gives the building a flat roof if they don't. A
footprint with more than 1,200 corners gets a flat roof without trying (the most in
Prague is 346).

The rest of this section is the review as written on 5 to 6 October, before the change.

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
