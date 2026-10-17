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

How boats pass a weir: through the lock beside it. In a lock and for 150 m beyond its
ends along the same line (the cut to the open river, from OSM's `lock=yes` ways, kept
in the file as `locks`) a boat may keep 3.6 m from the walls instead of 5 m; the
chambers are 11 to 12 m wide on the map. Opposing boats take turns in water narrower than
14 m to the bank: the other waits in wide water (each fairway's cuts are worked out once, a boat waits 70 m before one while another
comes through, and one going down the line gives way to a boat about to enter at the far end). In praha the fairway
is three stretches: one of 26 km from Modřany through the Smíchov lock and its cut,
the Štvanice lock and the Podbaba canal to Klecany, and one beyond each end. At the
Modřany and Klecany weirs the map's water has no lock a boat fits through, so boats
turn round there. The cruise boat stands 3.75 m over the water (a low cabin, no mast),
which fits under the footbridge over the Smíchov cut with 4 cm to spare.

`node scripts/check-river-boats.mjs` also checks opposing hull clearance, a queue of
three boats passing one coming the other way, and release of a waiting boat after
the other disappears, encounters unloaded water or turns away in wide water. The
coordination is recalculated from live boats; there is no retained lock owner.
These are offline synthetic-fairway checks. The live `cruise-lock` scenario covers
one boat through the Smíchov lock; a two-boat live check remains open.

`node scripts/check-river.mjs [area]` sails every stretch and every ferry crossing
without a browser (`--all` lists every step in the water, `--strict` fails on them).
On the praha map it passes and reports:

- every point on open water;
- every deck over the fairway with room for the boat. Four were too low until the
  pipeline's rules of 7 October 2026 (bridges over open water clear it; an outline with
  no street takes IPR's top): Branický most's footway, the cycleway under Barrandovský
  most, Dvorecký most and the railway bridge at Holešovice. A map built before that
  fails here. `KNOWN_LOW` in the script is where a deck the map has too low can be
  listed, reported and not failed, until its height is put right;
- steps in the water's height: 7 at locks (a boat rises or sinks there at 0.3 m/s),
  and 376 elsewhere on the map of 5 and 6 October, nearly all north of Troja.

That was the terrain: the water's height was the lowest terrain within 16 m on the
water, and north of Sedlec the Vltava leaves IPR's terrain model, where the ground
carries on at the height of the nearest known ground: the plateau above the river.
Since 7 October `dtm_heights.level_water` makes water lie as water does (see the top of
`pipeline/dtm_heights.py`): each pool of wide water is level between weirs, narrow water
comes down to the pool it runs into, and past the model's edge the land rises from the
water as a valley's side. Rebuilt in a clone (`uv run ipr_terrain.py praha`, 15 minutes,
97 tiles changed), the check counts 10 steps besides 3 at locks, all of them the water
running off at a weir or a lock's mouth (Modřany, the Smíchov cut, Štvanice); the
pools' levels in the city are the same to a decimetre (189.6, 187.3, 184.6, 180.3,
175.2 m), and beyond the model the river carries on from 175.2 m, rising a metre a
kilometre, where it stood at up to 295 m.

## PID ferries

P1, P2, P4, P5 and P6 from the feed (P3 and P7 aren't in it). One boat a line shuttles
between its landings by the game's clock, between the timetable's first and last
sailing; P1 and P2 all year, the others from 1 April to 31 October by the game's date.
It waits 75 s at each landing instead of keeping the 15 or 20 minutes between sailings.
Each landing gets a pontoon from the bank to the boat. E by the landing while the boat
is in; a PID ticket as on a tram (the grace period, then "No ticket"). Without one, an
inspector may check you as the boat comes in to a landing, with the chance a tram stop
has: pay the fine, or get off and run; if the boat sails on while you make up your mind,
the fine is taken. E at a landing puts you on the bank.

Checked in the game on 6 October 2026 (praha, WebGPU, headless Chrome): `ferry-ride`
boards P5 at a landing without a ticket (the time to buy one starts) and with one,
crosses twice and steps onto the bank 2 m from the landing; `cruise-lock` sails a cruise
boat 420 m past the Šítkov weir through the Smíchov lock, 4.3 m from its walls, without
turning; `cruise-weir` turns one round 73 m before the Modřany weir; `boat-boarding`
still passes. `upload-data.sh` and `deploy-mbxp.sh` copy the whole of `public/data`, so
`river.json` goes with the map once it has been built there. After any rebuild of an
area's tiles, run `uv run build_river.py <area>` again: the fairway and the landings
are worked out from the tiles' water.
