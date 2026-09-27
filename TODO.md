# To do

## Angled parking

Parking orientation is guessed from the width of the mapped OSM parking area alone
(`slots()` in `src/parking.js`): under 4.5 m it's parallel, wider gets rows of
perpendicular bays. Streets with angled parking end up with parallel cars.

1. **Close the 4.5–5.5 m gap.** The perpendicular rows need more than 5.5 m (first
   row at `v0 + 3`, loop while `v < v1 - 2.5`), so an area 4.5–5.5 m wide gets no
   bays and the kerbside fallback fills it with parallel cars. That's the usual depth
   of angled parking: give these areas angled bays (about 45–60°, spaced along the
   long side) instead.
2. **Read the orientation from OSM.** Keep `parking:left/right/both:orientation`
   (`parallel`, `diagonal`, `perpendicular`) on the street ways in
   `pipeline/osm_area.py`, pass it through `build_tiles.py` into the tiles and use it
   for the kerbside spots, falling back to the width guess only where the tag is
   missing. Needs a map rebuild.
