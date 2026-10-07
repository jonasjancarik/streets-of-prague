---
read_when: Working on bridge heights or levels, on which deck paint and tram tracks go, or reading check-bridge-decks.mjs or check-terrain-spikes.mjs output.
---

# Bridge decks and ground spikes, checked offline

Work of 5–6 October 2026 on the branch `night-bridges`. Two scripts read a built map
with the game's own samplers, without a browser:

- `scripts/check-bridge-decks.mjs`: every street and path on a bridge walked a metre
  at a time on its level, the worst change of height along the deck ("break") and the
  difference at each end with what it runs on into ("join"); the 27 named bridges of
  the terrain-steps skill apart.
- `scripts/check-terrain-spikes.mjs`: lattice points more than 2 m above or below
  every neighbour of their label.

## The named bridges on main's map of 5 October

Full output: [evidence](evidence/bridge-deck-check/praha-main-2026-10-05.txt).
Over a metre somewhere: most Závodu míru (join 3.7 m), Lahovice (9.6 m), Barrandovský
most (7 m), Železniční most (2.45 m), Mánesův, Čechův, Štefánikův and Hlávkův most
(sever) (3.8 to 5.3 m, footways and stairs at their ends) and Libeňský most (a 5.8 m
break on the footways at its east end). The long decks at Lahovice and Radotín have no
breaks any more (0.22 m over a metre at most, Radotínský most).

- **Železniční most at Výtoň.** The solved profile is right: the footways end at
  195.8 m where the stairs begin, and the stairs are bridge ways down to 192.3 m. They
  share the deck's level, and on the 4 m lattice the deck's last points take the stairs'
  heights: 1.64 m and 2.45 m at the two footways' ends.
- **Libeňský most (jih)** is path way 376889215: level at 183.9 to 184.3 m, the water's
  level, with the ground running down to it from 187.6 m at both ends. No step, but
  the deck is about 3.5 m too low: both ends are fixed to the ground read at the bank's
  foot, and IPR has no deck there.

## Stairs on a level of their own: tried, taken out

Keeping stairs that leave the deck's height by 1.5 m out of the deck's group (so they
get their own level) was built for praha and compared
([output](evidence/bridge-deck-check/praha-with-stairs-rule.txt)). The footways at Výtoň
then follow their profile to 0.2 m, but a walker meets a bigger step, not a smaller
one: the stairs alone on the lattice read 2.45 to 3.4 m under the deck at their top
(1.64 to 2.45 m before). Karlův most's stairs to Kampa went from 0.39 m to 3.73 m and
Libeňský most's east footways from 0.8 m to 5.9 m; no named bridge got better at its
joins. The rule was reverted. Stairs are narrower and steeper than the lattice can
hold; they need their own profile in the tile, as the flat terraces have `h`.

## Which deck a street or a tram is on

Done, see the terrain-steps skill: `level` on bridge and tunnel edges and `deckRails`
per tile, used by the game for paint, tracks and wires. On the rebuilt praha map 186
stretches of track are on a deck (146 on level 1, 34 on level 2, 6 on level 3). The
trams on Rašínovo nábřeží, which the old guess laid on Železniční most's footways
where they pass under it, are on the ground.

## Spikes and pits

On main's map: 1,124 lone points over 2 m, 224 over 5 m, 28 over 10 m
([worst places](evidence/bridge-deck-check/spikes-main-2026-10-05.txt)). Of the 417 on
terraces, 402 are spikes: points labelled as the strip at a wall's foot that carry the
height of the wall's top, most of them on Vyšehrad's bastions (50.0635, 14.4225). The
strip's lattice points are labelled whether or not the height rule in
`dtm_heights.py` took them for the wall's low side. Not fixed: the cause at a given
point (the wall doubling back, a point past the reach, a street on the strip) wasn't
established, and removing the label alone would leave the strip's outline over the
point and turn the spike into a pit.

## 7 October: stairs with their own profile, bridges over water, walls on both faces

A praha terrain build with the rules below against main's map of 6 October
([before](evidence/bridge-deck-check/praha-2026-10-07-before.txt),
[after](evidence/bridge-deck-check/praha-2026-10-07-after.txt),
[spikes after](evidence/bridge-deck-check/spikes-2026-10-07-after.txt)). The deck check's
"break" is now the jump the slope either side doesn't explain, so both columns are
measured the same way and stairs don't count as breaks.

| | Before | After |
| --- | ---: | ---: |
| Bridge edges with a break over 1 m | 8 | 3 |
| Bridge edges with a join over 1 m | 198 | 127 |
| Železniční most at Výtoň, break / join | 1.4 / 1.64 m | 0.37 / 0.41 m |
| Karlův most (stairs to Kampa), join | 3.73 m | 0.39 m |
| Libeňský most (east footways), break / join | 3.42 / 6.49 m | 0.24 / 0.8 m |
| Štefánikův most, break | 1.3 m | 0.03 m |
| Barrandovský most, break | 1.44 m | 0.34 m |
| Lone ground points over 2 m / 5 m / 10 m | 1,124 / 224 / 28 | 233 / 24 / 7 |
| of them on terraces | 417 | 48 |
| Decks too low for a cruise boat | 4 | 0 |

- **Stairs.** `structures.stairs` picks the bridge ways that are stairs (tagged `steps`;
  as steep as 20 % from end to end and climbing 1.5 m, whatever the map calls them; the
  landings between flights). Each carries its own profile (`ramps` on the tile's level,
  read by the game through `withRamps`) and stays out of the level's lattice. The solve
  runs a second time with them known: a link along stairs holds two heights together a
  twentieth as much as one along a deck, in the harmonic solve and in the smoothing.
  They share a level only with what is within 1 m of their height.
- **Edges of several ways.** 139 edges change level along themselves (a slip road
  parting from a deck, a footway running on into stairs): `levels` on the edge says
  where, and the paint follows. Half of the apparent faults at Karlův and Libeňský most
  were the check reading such an edge on one level.
- **Bridges over open water** clear it by 5.5 m away from their ends unless IPR measured
  the deck; an outline with no street on it is at IPR's top where IPR has it. Dvorecký
  most, the cycleway under Barrandovský most and Branický most's footway come out
  5.5 m over the Vltava, the railway bridge at Holešovice at IPR's 192 to 196 m. None of
  these is the bridge's surveyed height: Branický most's footway is really 12 m higher
  (IPR has two faces there, 4 m apart, and the stairs up to it are 22 m long).
- **Walls on both faces.** A point one retaining wall has put at its foot is not lifted
  by another wall's high side. Terrace spikes: 402 to 39.
- **Lone surveyed points.** A surveyed surface smaller than a lattice cell no longer
  makes a spike or a pit (595 points on the plain ground).

Still open: joins of 3.7 to 5.3 m at most Závodu míru, Mánesův, Čechův, Štefánikův and
Hlávkův most (sever), each at the foot or the top of stairs to a quay, where the
ground path beside the wall reads the other side of it; Libeňský most (jih), now 5.5 m
over the water in mid-span but still on the bank's slope at its ends, 3.5 m under the
streets; Nuselský most's corners at Pankrác, not looked at closely.
