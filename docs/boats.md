# Boats: lights, bank access, the fairway and the ferries

Read when changing boat models, mooring, boarding, river travel, `pipeline/build_river.py`,
`src/river.ts` or `src/ferries.ts`.

Cruise boats have warm cabin windows and red, green and white navigation lamps.
Pedal and swan boats carry a small white lamp. Their geometry is merged into each
boat's body and the existing `glow` attribute uses the street lamps' night switch
on WebGPU and WebGL. These lamps add no light objects, shadow maps or draw calls.
They make the lamps themselves visible; they do not illuminate the river around them.

A player can board within 4.5 metres of a boat's centre from dry walkable ground
within 0.8 metres of its deck, 0.4 metres above the sampled water. A path sampled
every 0.25 metres must reach the bank without crossing a wall, railing, unloaded
ground or a second stretch of water. Each dry route sample checks the walker's
0.3 m footprint and bank height, preventing access through a narrow corridor.
Only the first 0.3 m of that dry route may overlap water while stepping across
the shoreline; dry parts still need clearance. The player must fit on the bank, and the
player's current height is checked to prevent boarding from a bridge above.

Moored boats spawn only beside such a bank with a metre of clear ground on its
four sides, leaving room to stand and turn. Passing boats cannot displace them.
Placement attempts take turns, so a boat waiting for a suitable bank cannot block
the rest of the fleet. Exiting searches for the same safe landing, then puts the
walker on the ground level. A high quay without low access remains inaccessible.

Run `node scripts/check-boat-access.mjs` for CPU regressions covering low banks,
high quays and decks, walls, railings, water, unloaded ground, unchanged reach,
stable moorings and placement fairness. With the scene server running, run
`node scripts/scene.mjs run boat-boarding --port <scene-port>` to board and exit
all three moored boats through the ordinary game interaction.

The local WebGPU check on 3 October 2026 used source based on `b3c22d5` and a
private APFS copy of centrum data built `2026-10-02T20:16:12Z`, pipeline
`934283de3e`. Day/night views confirmed pedal and cruise lamps. A controlled
northbound pedal route at longitude 14.411 passed beneath Legion Bridge: sampled
water height 5.53–5.80 m, boat roof 7.64–7.94 m and bridge deck 15.58–15.64 m
above the world's reference height. This verifies that route, not every bridge.
Water-height variation in the existing map remains a terrain limitation. No
phone, frame-time benchmark, citywide rebuild or ferry implementation was included.

## The fairway, weirs and bridges (6 October 2026)

`pipeline/build_river.py <area>` writes `public/data/<area>_now/river.json` (run it
after `build_tiles.py`; it reads the tiles' water and weirs, OSM's line of the Vltava
from `pipeline/.cache/osm/<area>.osm.pbf` and PID's timetables; about a minute for
centrum and several for praha on a busy machine). Without the file the game runs as
before: cruise boats wander on open water and there are no ferries.

The fairway is the cheapest way through the navigable water (2 m cells, at least 5 m
from a bank, dearer near the banks) from where the river enters the area to where it
leaves, never within 5 m of a weir. A gap under 40 m between the loose ends of two
weir lines (a sluice for rafts) is closed. Cruise boats follow it, keeping up to 14 m
right of its middle, slow down behind each other, and turn round at the end of a
stretch. A boat's height follows the water at 0.3 m/s at most, so it doesn't jump where
the water's height does.

How boats pass a weir: the decision was the lock beside it, and the code for it is
there (one boat at a time in water narrower than 14 m to the bank; the other waits in
wide water). But on today's map **no lock is passable**: once a tile's water is drawn
exactly (the outlines of lock walls and moles kept dry), none of the lock chambers
leaves 5 m either side of a boat's middle, so the fairway comes out as one stretch
between each pair of weirs (seven in praha: Modřany, Šítkov, Old Town, Štvanice, Troja,
Klecany) and the boats turn round at each weir. An earlier, coarser drawing of the water
let the path through, but through walls a metre thick too. To get boats through the
locks: draw the fairway inside a lock from OSM's `lock=yes` line (kept in the file as
`locks`) and let the cruise boat's own width test pass there, then check it in the game.

`node scripts/check-river.mjs [area]` sails every stretch and every ferry crossing
without a browser. On main's praha data of 5 October it reports:

- every point on open water;
- four decks too low for a cruise boat (4.8 m over the water; a deck's edge hangs
  1.2 m below its surface): tile `49_37` (deck at the water's own height), `52_43`
  and `54_48` (deck 4.3 m over the water; the real bridges there are far higher) and
  `64_76`, Libeňský most (4.6 m). These are deck heights in the map, the business of
  the bridge-height work in the pipeline; the check fails until they are right. Every
  other deck over the fairway, the central bridges included, leaves room;
- steps in the water's height: a few metres at the end of a stretch by each weir
  (the water runs down the weir there, as it should), and two places where the
  water's own height is wrong: fairway 6 from about 3.1 km (tile `49_81`) and from
  7.05 km (tiles `50_94`, `50_95`, where the water climbs 35 m), and 79 steps on
  fairway 7. They are in the terrain's water heights north of Troja, not at tile
  edges (one step in 370 is at an edge). Not fixed: it needs `dtm_heights.py` and a
  terrain rebuild there.

## PID ferries

P1, P2, P4, P5 and P6 from the feed (P3 and P7 aren't in it). One boat a line shuttles
between its landings by the game's clock, between the timetable's first and last
sailing; P1 and P2 all year, the others from 1 April to 31 October by the game's date.
It waits 75 s at each landing instead of keeping the 15 or 20 minutes between sailings.
Each landing gets a pontoon from the bank to the boat. E by the landing while the boat
is in; a PID ticket as on a tram (the grace period, then "No ticket"); no inspector
comes aboard. E at a landing puts you on the bank.
