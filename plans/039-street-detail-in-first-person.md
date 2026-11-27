# 039: Street detail in first person

Status: PROPOSED (26 November 2026). A list to pick from, not a schedule.

## How this list was made

First-person frames from the game (`?fps`, Ultra, 14:00, clear, 26 November) were
set against Mapy.com Panorama views of the same streets (2023 imagery): Vodičkova and
the U Nováků passage, Seminářská by Karlova, Resslova at Karlovo náměstí, Malostranské
náměstí, Staroměstské náměstí, Blanická in Vinohrady and Seifertova in Žižkov. Both sets
are local working records in `docs/evidence/039-street-detail/` (`fpv-*` from the game,
`sv-*` from Mapy.com) and are not committed.

What already reads well at eye level: door portals with steps and stone surrounds,
rainpipes, shopfront displays with Czech signs and awnings, street plates, tram span
wires anchored to the walls, cast lids and drains, gas lanterns, café terraces in
season, shared bikes, stop signs and fallen leaves.

What the photographs have and the game doesn't is almost all **small, repeated,
slightly untidy objects at the foot of the walls and along the kerb**. The game's
pavements are clean planes between a tidy wall and a tidy kerb. In the photographs
that strip is busy: signs on poles, bollards, a parking machine, bins, a bike stand,
an electricity cabinet, house numbers, intercoms, stickers, tags on the plinth, a
grille over a cellar window, blue parking lines on the setts.

## Remove

- **Phone boxes.** Almost all of Prague's public telephones were taken out in the
  early 2020s, so a kiosk now dates the street. They come from the IPR utility survey
  (`PHONE` in `src/map/utility.ts`, `standingMarks`/`fitPhoneBox`; the model is `kiosk()`
  in `src/furnitureModels.ts`, its glass `kiosk-glass` in `src/furniture.ts`).
  DONE (26 November): `standingMarks` keeps only hydrants, and the kiosk models, glass
  draw and furniture kind are gone. The marks stay in the tile data, so no map rebuild.

## Feasibility

Counted in the local OSM extract of the centre (`centrum_0_0.osm`: Hradčany and Malá
Strana to about Vodičkova, 26 November). Outer districts are mapped more thinly.

| | Items | Why |
|---|---|---|
| **Easy: mapped, one instanced model** | Litter bins (348 mapped), tactile strips (1,033 `tactile_paving=yes`), plaques (234) and Stolpersteine (58), bike stands (102), parking machines (98), recycling (64), post boxes (24) | A pipeline layer and a model, the pattern of the terraces and shared bikes |
| **Easy: no new data** | House numbers (3,512 `addr:conscriptionnumber` from the RÚIAN import), intercoms, gas and meter doors, cellar grilles | They hang on doors and plinths the façade already makes; only the door position is inferred |
| **Medium** | Shops everywhere (below), shutters by time, projecting signs, paving mosaics, cabinets (27 mapped, infer at signals), bollards (112 mapped, mostly inferred), weeds and litter | |
| **Hard or risky** | Traffic signs (5 `traffic_sign` in the extract), graffiti and posters, roadworks, dogs | Signs would all be inferred and must agree with traffic rules; decals have no system yet; roadworks touch routing; dogs need a new animated figure |

## Shops from OpenStreetMap

Mostecká already does the hard part: a ray from the street to a mapped shop finds the
ground-floor bay it crosses, and that bay becomes a shopfront with matching stock
(`src/mappedFrontages.ts`, `displays` in `src/map/streetFacade.ts`). The extract has
1,442 shops, cafés, restaurants and pubs (95 % named, 127 with a brand). Within 18 m
of the street: Spálená 16 per 100 m, Myslíkova 9, Karlova 11 (really wall to wall, so
OSM is a floor there and the inferred shopfronts fill in). The 12 commonest kinds cover
71 %, 20 cover 80 %.

1. **Citywide data** (started 26 November): `pipeline/build_shops.py` writes
   `data/<area>_now/shops.json`, street foot and shop point per mapped shop, with its
   trade by name; it replaces the hand-made Mostecká file. Shops on an upper `level`
   are skipped.
2. **Signs** (started 26 November): a Czech trade word on the mapped shop's fascia
   (KAVÁRNA, RESTAURACE, LÉKÁRNA, POTRAVINY …). Generic words only: no OSM names, so
   no brands and nothing that dates when a shop closes.
3. **Stock**: today four display pictures (books, bakery, flowers, ceramics). Kinds
   without a picture show the usual random stock. Next pictures, by count: a café or
   restaurant room with tables, clothes, groceries, a pharmacy, hair salon.
4. **Later**: projecting signs for pharmacies, pubs and banks; shutters after closing
   from `opening_hours`; shops on modern façades (today only historic styles get them).

Steps 1 and 2, 26 November: `build_shops.py` found 11,244 shops in `praha` (4,291 in
`centrum`, 260 in `ujezd`); it left out 3,496 with no street within 20 m and 814 on
another level. 32 fascia words (`SIGN_WORDS`). Seen in first person on WebGPU and
WebGL: Spálená's west side reads CUKRÁRNA, KADEŘNICTVÍ, KAVÁRNA, the corner of
Lazarská KNIHKUPECTVÍ, Mostecká SUVENÝRY and POTRAVINY (`docs/evidence/039-street-detail/shops-*`).
The pharmacy opposite on Spálená is in a functionalist building and isn't drawn (step 4).
A hairdresser or grocer still shows random stock until step 3. The live data on R2 needs
`shops.json` uploaded with the next data version; until then the game has only inferred
shops, Mostecká included.

The distant façade pictures don't know about mapped shops, so a barred window can turn
into a shop as the detailed walls come in. Mostecká has always behaved that way.

## Tiers

Proposed for each item below, in the graphics table's terms:

- **All** — kept on Lowest too; it reads from above or matters for collision.
- **Low+** — cheap instanced props, hidden on Lowest.
- **Med+** — needs close geometry or another instanced draw; Medium and above.
- **High+** — decals, extra variety or animation that only pays off up close.

"Overhead" says whether the item is worth sharing with the top-down view (CLAUDE.md:
when it reads there and costs little).

## 1. Kerbside and pavement furniture

The biggest gap. Most of these are in OSM as nodes, so placement can follow the
terraces and bikes pattern (pipeline layer → tile → instanced street model).

| Item | Prague look | Source for placement | Tier | Overhead |
|---|---|---|---|---|
| **Traffic signs** | Round/triangle signs on grey 60 mm poles, often 2–3 per pole; the blue **zone parking** sign (*zóna placeného stání*), one-way, no entry, *obytná zóna* | DONE in part (27 November): no-entry and one-way signs at the ends of one-way town streets, inferred from the driving graph (`oneWaySigns`). No zone, give-way or parking signs yet | Low+ (pole and disc), Med+ (backs, brackets, stickers) | Pole dot only |
| **Bollards** | Old Town's cast-iron *pražský sloupek* (dark, ribbed, rounded cap), plain steel tubes and concrete blocks elsewhere | DONE (27 November): the 10,895 mapped ones (`build_street_furniture.py`); none inferred yet | Low+ | Yes, as dots: they explain where cars can't go |
| **Parking machines** | Grey TSK pay-and-display post with a small screen and blue P | DONE (27 November): the 1,195 mapped ones | Low+ | No |
| **Litter bins** | Prague's dark grey/green city bin, often on a lamp post, some with an ashtray top | DONE (27 November): the 5,957 mapped ones, as the park bin | Low+ | No |
| **Recycling container nests** | Row of 4–6 bell or wheelie containers: yellow (plastic), blue (paper), green and white (glass), orange (cartons), grey (metal), on a marked bay | DONE (27 November): a container per kind each mapped point takes, in its colour | Low+ | Yes, a colourful row is very Prague from above |
| **Bike stands** | Prague's inverted-U stands in rows, often with a bike locked to them | DONE (27 November): one U per two bikes of `capacity`; no parked bikes yet | Low+ stands, Med+ parked bikes (reuse bike models) | No |
| **Shared e-scooters** | Lying or standing in twos and threes at corners, fictional operator colours like the shared bikes | Near shared-bike stations and stops, made up | Med+ | No |
| **Electricity and signal cabinets** | Grey or beige steel boxes (PRE, ČEZ, TSK signal controllers), tagged and stickered, at junctions and against walls | DONE (27 November) for the 1,050 mapped (`man_made=street_cabinet`); none inferred at signals yet | Low+ | No |
| **Advertising columns and panels** | Round *reklamní sloup* with posters; lit glass panels (citylight) on pavements | DONE (27 November): 79 mapped columns and 116 poster cases, totems and boards; not lit at night yet | Low+ column, Med+ lit panel at night | Column yes |
| **Pedestrian guard rails** | Grey tubular rails at crossings, tram islands and school gates | Along kerbs within a few metres of mapped crossings on primary roads and tram islands | Low+ | Yes, thin line |
| **Post boxes** | Orange Česká pošta box on a wall or post | DONE (27 November): on the wall when mapped by one, else on a post | Low+ | No |
| **A-frame boards and shop clutter** | Chalk boards, menus, flower buckets, fruit crates in front of shops by day, taken in at night | DONE in part (27 November): a chalkboard with the trade word outside about half the mapped cafés, bakeries, restaurants and pubs, day and night (`chalkboard`); no flower buckets or crates | High+ | No |
| **Tree grates and guards** | Cast-iron grate round a street tree's foot, sometimes a steel cage or posts | DONE in part (27 November): a cast-iron grate round surveyed trees standing in paving by a road or on a paved square, where no green is mapped under them (`treeGrates`); no guards | Med+ | No |
| **Grit bins** | Yellow or green *posypový materiál* box on hilly streets | Streets above a gradient, winter only | Med+ | No |

## 2. On the walls at eye level

Mostly additions to the façade atlas and the street façade meshes, so no new
placement data: they hang off bays the game already chooses.

| Item | Prague look | Where it goes | Tier | Overhead |
|---|---|---|---|---|
| **House numbers** | Red enamel *číslo popisné* above blue *číslo orientační* beside every house door | DONE (27 November): the address's own numbers (RÚIAN via OSM, `pipeline/build_addresses.py`, 174,066 in `praha` in 500 m cells), by the house door nearest the ray from its street (`src/houseNumbers.ts`, `doorPlates` in `src/map/streetFacade.ts`). A door no address reaches has none | Low+ | No |
| **Intercom and bell panels** | Steel panel with name slots beside the house door, sometimes a camera | DONE (27 November): every house door, on the side away from the numbers (`cellShape`) | Med+ | No |
| **Utility doors** | Yellow gas box (*HUP*), grey electricity meter door, small steel hatches low on the plinth | DONE (27 November): a gas or meter door under the house numbers where there is room (`utilityDoor`) | Low+ (decal) | No |
| **Cellar grilles and coal hatches** | Bars or mesh over low cellar windows, steel hatches in the pavement against the wall | Cellar lights with grilles were already in the façade modules; no coal hatches yet | Med+ | No |
| **Projecting shop signs** | Signs and lightboxes sticking out at right angles above shop doors (pharmacy cross, pub sign, bank) | DONE (27 November): mapped shops' trade word on a board at the bay edge, always for pharmacies, pubs, restaurants, cafés, banks and exchanges (`projectingSign`). Not lit yet | Med+ | No |
| **Roller shutters** | Steel shutters pulled down over shops at night and on Sundays; often tagged | DONE (27 November): after dark, most closed shops; not by `opening_hours` yet, no tags | Med+ | No |
| **Graffiti and tags** | Tags on plinths, doors, cabinets and shutters; heavy in Žižkov and Vinohrady, rare on the Royal Route | Decals on the lowest 2.5 m, density by district | High+ | No |
| **Posters and stickers** | Layers of torn gig posters on drainpipes, cabinets and boarded windows; stickers on sign poles | Decals on rainpipes, cabinets, poles | High+ | No |
| **Window boxes, flags, laundry** | Geraniums on sills, a flag over an embassy or hotel door | DONE in part (27 November): geranium boxes on about a fifth of the first-floor windows of tenements and baroque houses, bare earth while the trees are bare (`windowBox`); no flags or laundry | Med+ | Window boxes yes, faintly |
| **Air conditioners and satellite dishes** | White AC boxes on courtyard and modern façades, dishes on balconies | DONE (27 November): under some upper windows, about one bay-storey in eleven on functionalist and panel fronts and one in forty on older ones; dishes rarer (`airConditioner`, `satelliteDish`) | Med+ | Yes on roofs; roof clutter already exists |
| **Security cameras and alarm boxes** | Small dome cameras by doors and banks, a red or blue alarm box high on the wall | DONE in part (27 November): a red alarm box high by about a third of the shops (`alarmBox`); no cameras | High+ | No |
| **Shops where the map has them** | On Seifertova the photo has a kebab shop, florist and pharmacy in a row; the game gives the same houses barred flat windows | OSM `shop=*` / `amenity=*` points already guide displays on Mostecká; use them on every street, with the shop's kind picking the display and sign | Med+ | Signs no; the lit window at night yes |
| **Blank walls at the pavement** | A wall with no openings beside you is plain brown plaster to the cornice (Resslova, `fpv-karlak2`); the photos show a stone plinth, rustication, cabinets, posters and tags | Give windowless stretches a plinth course and some of the items in this table | Med+ | No |
| **Memorial plaques** | Bronze or stone plaques; *Stolpersteine* brass cobbles in the pavement | DONE (27 November): the 1,198 mapped plaques on clear plaster (`src/plaques.ts`, inscriptions only suggested) and 739 Stolpersteine in the pavement | Med+ | No |

## 3. The ground

| Item | Prague look | Notes | Tier |
|---|---|---|---|
| **Paving mosaics** | Black-and-white limestone mosaics: chequerboard, Prague-star and wave patterns (Resslova, Na Příkopě, Václavské náměstí) | At eye level the game's pavement reads as irregular crazy paving (`fpv-vinohrady2`, `fpv-karlak2`). Most Prague pavements are 4–5 cm limestone cubes, grey with a darker border, in fans or a grid, and the patterns above on show streets. A few pattern textures chosen by district | All (it's a texture swap) |
| **Setts on squares** | Malostranské náměstí shows as flat grey at eye level; the real square is granite setts with a granite gutter | Check the square surface material up close | All |
| **Parking lines** | White broken line between the parking lane and the traffic lane (Seifertova), blue in residents' zones | DONE (27 November): mapped bays always had their outlines (`bayLines`, `src/ground.ts`); kerbside rows without a mapped area now get their TSK zone's line too (`kerbPaint`, `src/parking.ts`), short of zebras. Outside the zones none | All |
| **Repairs and stains** | Asphalt patches in setts, darker oil under parked cars, chewing gum dots, trench scars | Decals; the oil stain can ride on the parked car's spot | High+ |
| **Tactile paving** | Rust-red or white blister strips at every crossing and tram platform edge | At mapped crossings and stop edges | Low+ |
| **Cigarette butts and litter** | Butts in sett joints by doors and stops, a cup or a flyer | Same scatter system as the fallen leaves (`streetLitter.ts`), all year | High+ |
| **Weeds** | Grass and moss in the joint between wall and pavement in old lanes and courtyards | Thin strip along wall feet in Prague 1 and 2, seasonal | High+ |
| **Roadworks** | Red-white barriers and tape, a pile of lifted setts, a trench plate, a blue site toilet | A few random sites per area that come and go by game week; cars route round | Med+ |

## 4. Life on the street

| Item | Notes | Tier |
|---|---|---|
| **Dogs on leads** | A share of walkers in residential areas with a dog; also dog-waste bins | Med+ |
| **Delivery riders** | Couriers exist; add the parked scooter or bike with its box outside restaurants | Med+ |
| **People at doors** | Smokers outside pubs and offices, someone unlocking a door, a shopkeeper in a doorway | High+ |
| **Shop lights by hours** | Displays dark and shutters down after closing, lit kiosks and pubs open late | Med+ |

## 5. Seasonal and occasional

- **Christmas**: light strings across the main shopping streets and the markets on
  Old Town and Wenceslas Squares in December. DONE in part (27 November): the light strings, Advent to
  Epiphany (`src/christmasLights.ts`); no markets, nothing on the wide squares.
- **Election and event posters** on the advertising columns, changed by game date.
- **Snow** pushed into heaps along kerbs and against parked cars, grit on the pavements.

## Noticed while looking (not detail, but they hurt realism at eye level)

- Photo-mesh landmarks tear into dark shards up close: the church beside the
  Malostranské náměstí portals and Týn opposite the square's trees. Fade them out or swap in a
  simpler wall within some 30 m.
- The silver saloon parked on Seifertova has paint that sparkles like TV static
  (`fpv-zizkov`); the metallic flake is too coarse at eye level.
- Three identical arched portals in a row (Seminářská, Malostranské náměstí): vary
  the door leaf, colour and steps per bay.
- The bookshop display inside U Nováků shows vertical streaks across the right-hand
  case (`fpv-vodickova-se`). 27 November: the same streaks at Vodičkova turned out to be
  the dither fade of a surface right in front of the camera (the view stood in the
  window). The arcade shop windows really do streak (Celetná's Hrzánská arcade, Myslbek):
  the glass was set 25 cm back, into the building's own walls behind the lining. At 7 cm
  most of the window is clean; vertical stripes of stock and oak surround remain on part
  of some, likely the lining fighting itself where two edges of the room overlap
  (`src/map/passageLining.ts`). A polygon offset on the lining didn't change them.
- A manhole lid lies on top of a house's doorstep on Národní (27 November, `grate-d`):
  the surveyed cover is drawn at the ground's height under the steps.
- RESOLVED 27 November: the scripts drew in software (`--use-angle=metal` on Windows); on
  the GPU the trees here have their bark and leaves. Was: on Old Town Square (`t.go('staromak', { heading: 200 })`) the trees stand as plain
  grey prisms on a carpet of large flat leaf clumps, the overhead models rather than
  the barked street trees and individual fallen leaves. It looked the same after 16
  and after 60 frames, so the close trees and leaves aren't reaching that spot. The
  same carpet floats over the paving out to the far side of the square.

## Suggested order

1. Remove phone boxes. DONE 26 November.
2. House numbers and intercoms (cheap, on every door, instantly Prague). DONE 27 November,
   with gas and meter doors.
3. Traffic signs and parking zone signs (the zone lines are done). No-entry and one-way
   signs DONE 27 November; the rest not yet.
4. Bollards, bins, parking machines, bike stands (one instanced-props layer from OSM).
   DONE 27 November for everything mapped, with post boxes, benches, drinking fountains,
   advertising columns and poster cases (`docs/furniture.md`).
5. Recycling nests and cabinets. DONE 27 November for the mapped ones; cabinets at signals
   are not inferred yet.
6. Utility doors, cellar grilles, projecting shop signs, shutters by time of day. DONE 27
   November, with memorial plaques, Stolpersteine, chalkboards, alarm boxes, air
   conditioners and dishes, and tree grates. Shutters follow the night, not `opening_hours`.
7. Paving mosaics and tactile strips. (Ground work: another session has the kerbs and
   paving in hand; not started here.)
8. Graffiti, posters and stickers (High+), litter and weeds.
9. Roadworks, dogs, seasonal sets. Christmas lights DONE 27 November.

Left for later, roughly by value: lit projecting signs and poster cases after dark;
display pictures for cafés, clothes, groceries and pharmacies (shop step 3); inferred
cabinets and bollards; flags and laundry; the arcade windows' remaining stripes;
the other traffic signs (give way, zones, parking); decals (graffiti, posters, stickers); dogs; roadworks.
