# Places fixed by hand

<!-- read_when: a place looks wrong and a general rule can't fix it; adding to terrain_keep.json or terrain_walls.json; asked which parts of the map aren't straight from the data -->

The map is built from open data by rules that apply across the whole city. In a few
places the data itself is wrong or missing something, and no rule can tell. Those places
are listed by hand, each with its name and the reason, in small files in `pipeline/`.
This page lists all of them.

When a rule is wrong in general, we change the rule. When a rule is right for the city
but the data misleads it in one spot, we list the spot instead of bending the rule for
it, since a bent rule quietly changes other places too. Each listed place carries a
short note on what was wrong there, so anyone can check it again when the data changes.

## The terrain

The ground comes from IPR Praha's terrain model, sharpened by the technical map's
survey of kerbs, walls and quays (see [the terrain steps](../.agents/skills/terrain-steps/SKILL.md)).

### Places left as the terrain model has them

[`pipeline/terrain_keep.json`](../pipeline/terrain_keep.json) lists places where the
survey's lines made the ground worse than the plain terrain model. Each is a box in
degrees (west, south, east, north) with a reason. There are two:

- **Barrandovský most, the bank below its west end.** A path runs down a grassed bank
  between the road and the river, and the bank came out as ragged cliffs.
- **Trojský most, beside its north end.** A pit in the grass beside the bridge.

### Walls the survey is missing

[`pipeline/terrain_walls.json`](../pipeline/terrain_walls.json) lists retaining walls
that are really there but that the survey records as something else, so the ground ran
down as a slope instead of stepping. Each is a line in degrees (longitude, latitude)
with a reason. There are three:

- **Divadelní, by the National Theatre.** Náměstí Václava Havla stands 3 m over the
  street in its cutting, but the survey has the top of that wall as the edge of a paved
  area.
- **5. května over Hvězdova at Pankrác, both sides of the underpass.** The road crosses
  on short bridges off embankments 6 m high. The survey has the top of each embankment
  but no wall, and the ground under the bridges came out as a torn slope.

## Ramps at U Bulhara

[`pipeline/ramp_approaches.json`](../pipeline/ramp_approaches.json) joins the streets to
the two ramps of the U Bulhara interchange, whose decks in IPR's model don't meet the
streets that lead onto them. It names the deck's triangles in IPR's model, so it holds a
fingerprint of the file it was made from and refuses to run on any other. It belongs to
the work on road surfaces ([findings](road-surface-findings.md)) and isn't in the game's
map yet.

## Other places named in the code

A few places are picked out on purpose rather than to correct the data:

- **Roof colours** ([`pipeline/roofs.py`](../pipeline/roofs.py)): five buildings whose
  roof OSM tags wrongly (St Vitus, the Rudolfinum and others), and three parts of the
  Castle that OSM and IPR draw as one building with one roof.
- **Landmarks** ([`pipeline/landmarks.py`](../pipeline/landmarks.py)): the buildings
  baked from IPR's photographed 3D model, chosen one by one.
- **Skylines** ([`pipeline/skyline.py`](../pipeline/skyline.py)): the viewpoints for the
  views of the city on the loading screen, such as the Castle from Charles Bridge.
- **The main station** ([`pipeline/station_tracks.py`](../pipeline/station_tracks.py)):
  where its tracks and platforms are, for laying them out.

Everything else on the map comes from the data and the rules.

## Adding a place

Look at the place in the game first, and check that the data is at fault and not a rule.
If a rule is wrong, change the rule: other places probably have the same problem. If the
data is wrong, add an entry with a `name` someone can find on a map and a `why` that
says what was wrong and what the data has there. The next build notices the changed file
and rebuilds the terrain; then look at the place again.
