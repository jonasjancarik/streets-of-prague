---
read_when: Changing the traffic signs, the direction plates and boards, their posts or faces, the lanes' painted arrows, or pipeline/build_traffic_signs.py.
---

# Traffic signs and lane arrows

OpenStreetMap maps almost no traffic signs in Prague: a few hundred `traffic_sign`
points, mostly city limits. It does record the rules the signs announce, and the Czech
rules put each sign in a known place. So the signs are inferred from the rules
(`pipeline/build_traffic_signs.py` → `traffic-signs.json`, about 75,000 signs in
`praha`). No public inventory of the city's real signs turned up (TSK keeps one), so
none of this is a survey of where the posts actually stand.

## What the rules give

The pipeline reads the car streets, the tagged nodes and the turn restrictions from
the OSM extract. A junction is where three or more ends of public streets meet (a
service road's mouth is not one; nor is it a junction in the traffic rules). Every sign
stands on the right of the traffic it is for, 0.8 m beyond half the street's width,
facing that traffic.

| Signs | From | Where |
|---|---|---|
| One way, no entry | `oneway` on town streets (secondary to living street), 15 m or longer | Where it starts from a junction, for those turning in; where it ends at one, for those who would turn in against it |
| Give way, stop | `highway=give_way|stop` with `direction`, else towards the nearer junction | At the mapped node |
| Give way (inferred) | Junctions without mapped give-way or stop and no lights within 30 m, where a road of tertiary class or above runs through | On each lesser street 4 m before the junction, not on living streets (leaving one, drivers give way by the rules alone) |
| Give way and roundabout | `junction=roundabout` | On each street into it |
| Main road | Junctions whose side streets give way | On the through road leaving the junction, at most one per 40 m for the same traffic |
| Crossing | `highway=crossing` marked (`uncontrolled`, `marked`, `zebra`), not with lights | On each side, 1 m before it |
| Lit crossing | IPR's technical map: its powered traffic signs (`dopravní značka`, code 605270), which record a position only | A crossing sign within 6 m of one becomes a lit box |
| Speed bump | `traffic_calming` bump, hump, table, cushion | At it, for the traffic coming up |
| Zone 20/30/40, living street, pedestrian zone, and their ends | `maxspeed:type`, `zone:maxspeed`, `source:maxspeed`; `highway=living_street|pedestrian` | Where a street of the zone meets a car street outside it: the zone's sign for those going in, its end for those coming out |
| Speed limit, and its end | `maxspeed` other than the town's 50, outside zones | A prohibition holds only to the next junction, so after every junction, and where the limit starts between junctions; an end sign where it goes back to 50 between junctions |
| Weight, height, no lorries, no motor vehicles, "mimo dopravní obsluhy" plate | `maxweight` (to 60 t), `maxheight`, `hgv`, `motor_vehicle`/`access`; the plate for `destination` or `delivery` | Like the speed limits |
| No left/right turn; ahead, left or right only | Turn restriction relations (not no-U-turn: most are for the routing of dual carriageways) | On the street coming up to the junction, 12 m before it, if it is 14 m long or more |

The same sign for the same traffic within 3 m is kept once. The file also lists, for the
streets into each junction, OSM's `turn:lanes` (`:forward`/`:backward` on two-way
streets) and the junction's position.

## In the game

`src/map/signs.ts` puts up a tile's signs in the land worker; `src/signs.ts` loads the
file (with the lamp survey's three-second deadline), draws the faces and makes the mesh.
A sign the pipeline put on the game's carriageway moves out past the kerb, one out in
the pavement moves in to 0.5 m from the kerb. Where a house front stands at the kerb, the
sign hangs on the wall from two arms, its edge to the wall (in the old town's lanes).
Signs for the same traffic within 1.2 m of each other share a 60 mm galvanised post,
two to a post besides plates: the more important on top (priority, then prohibitions
and zones, then orders, then information), each plate under the sign it came with. The
lowest sign's bottom is 2.1 m above the pavement. Free-standing posts are solid in the
collision grid.

The faces are drawn on a canvas in the Czech designs, one cell per sign in the file,
including each speed, weight and height value, with decimal commas. Each face is
planar-mapped onto its own outline (disc, triangle, octagon, diamond, square,
rectangle) with a grey back and a folded rim. A whole tile's signs are one draw. The lit
crossing boxes show the sign both ways and glow after dark (`lightSigns`, with the lit
windows' night value). The signs are drawn in the street views only: from above they are
too small to read. `&nosigns` leaves them out.

## Direction signs

OSM names where a street leads in `destination` on the street itself, after the junction
(`destination:forward`/`:backward` on a two-way street; a plain `destination` there is
taken as the forward one), with `destination:ref`, `destination:symbol` and
`destination:colour`. About 1,300 ways have it in Prague, nearly all main roads and their
slip roads: the old town's lanes have none. For the traffic coming up to each junction
(`direction_signs`), every street on from it that is named is a branch, with its turn from
the way the traffic comes. A branch that only crosses to another junction within 40 m
(across a dual carriageway) takes the name of the street straight on from there, and a
link that short gets no signs of its own. Where no branch is named, the street coming up
may name its lanes (`destination:lanes` with `turn:lanes`). U-turns are left out.

- **Arrow plates**, 6 m before the junction on a post: one per branch, straight on first,
  then left to right, two places to a plate and at most two plates a branch. Within 30° of
  straight on the plate is square with an up arrow; otherwise it points left or right. The
  road numbers stand on the first plate in badges (red for motorways and one- or two-digit
  roads, green for E roads, white otherwise), and the airport has its symbol. Blue for
  places further out, white where every place is one of the city's parts (`districts.json`)
  or "centrum", green to the motorway, as `destination:colour` says where it is mapped. On
  the wall where there is no pavement, like the other signs.
- **Boards**, 70 m before the junction on trunk, primary and secondary roads with two
  branches or more: blue (green when every branch is), 2.6 m wide on two posts, with the
  junction drawn as a stem and a line out to each branch's head, its places beside it on
  a panel of its own colour. Only where the board's whole width is clear of houses.

About 830 junction approaches get plates and 90 a board. Each tile draws its signs' faces
on a canvas of its own (`directionLayout` packs them; `src/signs.ts` draws them in a
narrow sans, narrowed to fit), one draw per tile with a material of its own.

## Lane arrows

The arrows painted in the lanes before a junction come from `turn:lanes`
(`turnArrows` in `src/ground.ts`, with the rest of the road paint). They are in the lanes
`roadPaint` divides the carriageway into: on a one-way street between the kerb less its
parking and the left kerb, on a two-way street in the right half. The first arrow is 6 m
short of where the junction's widest street begins, a second 25 m further back if the
street is long enough. Through, left, right and slight turns combine on one shaft. A
street shorter than about 20 m (a link between dual carriageways) has none, nor do
setts, bridges and tunnels.

## Checks

`node scripts/check-traffic-signs.mjs` covers placement against the kerb and walls,
posts, order, plates, the geometry and reading the file. The pipeline's inference is
`pipeline/test_traffic_signs.py` (one-way, priority, crossings, lit crossings, zones,
speed limits after junctions, limits with plates, turn bans, lane arrows and direction
signs), and the check script covers the direction plates' faces, canvas and posts.

## Not done

No parking or no-stopping signs (OSM barely records them), no overhead gantries over the
main roads yet, no roadworks. The zone tagging in OSM has gaps, so a zone sign can stand inside a zone
where one street is untagged, and a speed limit of 30 may be signed on a street that is
really part of a zone.
