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
