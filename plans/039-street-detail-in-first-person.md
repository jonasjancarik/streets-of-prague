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
| **Traffic signs** | Round/triangle signs on grey 60 mm poles, often 2–3 per pole; the blue **zone parking** sign (*zóna placeného stání*), one-way, no entry, *obytná zóna* | OSM `traffic_sign` nodes are sparse; infer the common ones from the road graph: one-way ends, no-entry, give-way at minor-road joins, pedestrian zones, the start of paid-parking streets | Low+ (pole and disc), Med+ (backs, brackets, stickers) | Pole dot only |
| **Bollards** | Old Town's cast-iron *pražský sloupek* (dark, ribbed, rounded cap), plain steel tubes and concrete blocks elsewhere | OSM `barrier=bollard`; infer rows along pavement edges in Prague 1 where cars could mount the kerb, at the ends of pedestrian streets and round squares | Low+ | Yes, as dots: they explain where cars can't go |
| **Parking machines** | Grey TSK pay-and-display post with a small screen and blue P | OSM `vending=parking_tickets`; else one per paid-parking block | Low+ | No |
| **Litter bins** | Prague's dark grey/green city bin, often on a lamp post, some with an ashtray top | OSM `amenity=waste_basket`; else one at each crossing and stop | Low+ | No |
| **Recycling container nests** | Row of 4–6 bell or wheelie containers: yellow (plastic), blue (paper), green and white (glass), orange (cartons), grey (metal), on a marked bay | OSM `amenity=recycling` (well mapped in Prague; the city also publishes the *sběrná hnízda* list) | Low+ | Yes, a colourful row is very Prague from above |
| **Bike stands** | Prague's inverted-U stands in rows, often with a bike locked to them | OSM `amenity=bicycle_parking` | Low+ stands, Med+ parked bikes (reuse bike models) | No |
| **Shared e-scooters** | Lying or standing in twos and threes at corners, fictional operator colours like the shared bikes | Near shared-bike stations and stops, made up | Med+ | No |
| **Electricity and signal cabinets** | Grey or beige steel boxes (PRE, ČEZ, TSK signal controllers), tagged and stickered, at junctions and against walls | Infer one per signalled junction (`build_signals.py` already has them); a few per block against walls | Low+ | No |
| **Advertising columns and panels** | Round *reklamní sloup* with posters; lit glass panels (citylight) on pavements | OSM `advertising=column` / `board` / `poster_box` | Low+ column, Med+ lit panel at night | Column yes |
| **Pedestrian guard rails** | Grey tubular rails at crossings, tram islands and school gates | Along kerbs within a few metres of mapped crossings on primary roads and tram islands | Low+ | Yes, thin line |
| **Post boxes** | Orange Česká pošta box on a wall or post | OSM `amenity=post_box` | Low+ | No |
| **A-frame boards and shop clutter** | Chalk boards, menus, flower buckets, fruit crates in front of shops by day, taken in at night | Beside the game's own shopfront bays that have a display, during opening hours | High+ | No |
| **Tree grates and guards** | Cast-iron grate round a street tree's foot, sometimes a steel cage or posts | Every surveyed street tree in a paved pavement (IPR trees already loaded) | Med+ | No |
| **Grit bins** | Yellow or green *posypový materiál* box on hilly streets | Streets above a gradient, winter only | Med+ | No |

## 2. On the walls at eye level

Mostly additions to the façade atlas and the street façade meshes, so no new
placement data: they hang off bays the game already chooses.

| Item | Prague look | Where it goes | Tier | Overhead |
|---|---|---|---|---|
| **House numbers** | Red enamel *číslo popisné* above blue *číslo orientační* beside every house door | Next to each house entrance; RÚIAN has both numbers per address point, so they could even be right | Low+ | No |
| **Intercom and bell panels** | Steel panel with name slots beside the house door, sometimes a camera | Every house entrance bay | Med+ | No |
| **Utility doors** | Yellow gas box (*HUP*), grey electricity meter door, small steel hatches low on the plinth | One or two per house front on the plinth | Low+ (decal) | No |
| **Cellar grilles and coal hatches** | Bars or mesh over low cellar windows, steel hatches in the pavement against the wall | Plinth bays without a door; the facade already has low cellar lights | Med+ | No |
| **Projecting shop signs** | Signs and lightboxes sticking out at right angles above shop doors (pharmacy cross, pub sign, bank) | Shop bays; lit after dark | Med+ | No |
| **Roller shutters** | Steel shutters pulled down over shops at night and on Sundays; often tagged | Shop bays, by time of day | Med+ | No |
| **Graffiti and tags** | Tags on plinths, doors, cabinets and shutters; heavy in Žižkov and Vinohrady, rare on the Royal Route | Decals on the lowest 2.5 m, density by district | High+ | No |
| **Posters and stickers** | Layers of torn gig posters on drainpipes, cabinets and boarded windows; stickers on sign poles | Decals on rainpipes, cabinets, poles | High+ | No |
| **Window boxes, flags, laundry** | Geraniums on sills, a flag over an embassy or hotel door | Some first-floor windows, by building age | Med+ | Window boxes yes, faintly |
| **Air conditioners and satellite dishes** | White AC boxes on courtyard and modern façades, dishes on balconies | Upper floors, mostly on non-historic façades | Med+ | Yes on roofs; roof clutter already exists |
| **Security cameras and alarm boxes** | Small dome cameras by doors and banks, a red or blue alarm box high on the wall | Shops and banks | High+ | No |
| **Shops where the map has them** | On Seifertova the photo has a kebab shop, florist and pharmacy in a row; the game gives the same houses barred flat windows | OSM `shop=*` / `amenity=*` points already guide displays on Mostecká; use them on every street, with the shop's kind picking the display and sign | Med+ | Signs no; the lit window at night yes |
| **Blank walls at the pavement** | A wall with no openings beside you is plain brown plaster to the cornice (Resslova, `fpv-karlak2`); the photos show a stone plinth, rustication, cabinets, posters and tags | Give windowless stretches a plinth course and some of the items in this table | Med+ | No |
| **Memorial plaques** | Bronze or stone plaques; *Stolpersteine* brass cobbles in the pavement | OSM `memorial=plaque` / `stolperstein` (well mapped) | Med+ | No |

## 3. The ground

| Item | Prague look | Notes | Tier |
|---|---|---|---|
| **Paving mosaics** | Black-and-white limestone mosaics: chequerboard, Prague-star and wave patterns (Resslova, Na Příkopě, Václavské náměstí) | At eye level the game's pavement reads as irregular crazy paving (`fpv-vinohrady2`, `fpv-karlak2`). Most Prague pavements are 4–5 cm limestone cubes, grey with a darker border, in fans or a grid, and the patterns above on show streets. A few pattern textures chosen by district | All (it's a texture swap) |
| **Setts on squares** | Malostranské náměstí shows as flat grey at eye level; the real square is granite setts with a granite gutter | Check the square surface material up close | All |
| **Parking lane dashes** | White broken line between the parking lane and the traffic lane (Seifertova), bay ends at corners | Along the parked-car rows (`parking.ts`) | All |
| **Blue zone lines** | Blue (resident), orange (short stay) and purple (mixed) lines along parking bays | Parked-car rows already exist (`parking.ts`); paint along them by zone | Low+ |
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
  Old Town and Wenceslas Squares in December.
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
  case (`fpv-vodickova-se`).
- On Old Town Square (`t.go('staromak', { heading: 200 })`) the trees stand as plain
  grey prisms on a carpet of large flat leaf clumps, the overhead models rather than
  the barked street trees and individual fallen leaves. It looked the same after 16
  and after 60 frames, so the close trees and leaves aren't reaching that spot. The
  same carpet floats over the paving out to the far side of the square.

## Suggested order

1. Remove phone boxes.
2. House numbers and intercoms (cheap, on every door, instantly Prague).
3. Traffic signs and parking zone signs, with blue zone lines.
4. Bollards, bins, parking machines, bike stands (one instanced-props layer from OSM).
5. Recycling nests and cabinets.
6. Utility doors, cellar grilles, projecting shop signs, shutters by time of day.
7. Paving mosaics and tactile strips.
8. Graffiti, posters and stickers (High+), litter and weeds.
9. Roadworks, dogs, seasonal sets.
