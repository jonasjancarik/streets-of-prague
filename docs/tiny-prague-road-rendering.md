---
read_when:
  - Comparing Tiny Prague's smooth-looking roads with Streets of Prague
  - Evaluating terrain textures, road height profiles, or bridge approaches
---

# How Tiny Prague renders roads

Tiny Prague uses a shared terrain mesh for ordinary road paving, a separate
height lookup along road segments, and separate geometry for bridges. This
lets road colour follow one continuous surface while the application can
sample a more specific height for a vehicle or a route.

This note describes the public browser build inspected on 6 November 2026.
The example is the linked view near 5. května and Kongresová, where the upper
carriageways read as continuous bands of paving. The view establishes how
the crossing looks from that camera angle. The public code establishes the
rendering and sampling methods described below. The upstream process that
produces the elevation samples and the exact tile records used at this
crossing were outside the inspection.
[Linked view](https://tinyprague.cz/#v=50.06098,14.43175,135,-135,69).

## Ordinary roads and terrain

The project's About panel credits OpenStreetMap for the street network and
Terrain Tiles from AWS Open Data and Mapzen for the terrain elevation model.
It lists ČÚZK DMP and DMR 5G for deriving building and tree heights and roof
pitches. The browser receives tile heights already prepared for rendering.
[Project credits](https://tinyprague.cz/).

The tile worker builds an indexed terrain grid from the tile's stored heights.
It also paints land cover and ordinary roads into a bitmap on an offscreen
canvas. Roads are strokes along their centre lines, drawn in class order with
rounded caps and joins. The worker draws their outlines before drawing their
fills. The browser maps the bitmap onto the terrain mesh and computes normals
from that mesh for lighting. The paving and its outline follow the same triangles. Their visible edges
come from the texture, while the terrain's grade determines the shape of
the visible road.
[Tile worker](https://tinyprague.cz/assets/cell-worker-Xe7VmrLZ.js) and
[browser renderer](https://tinyprague.cz/assets/index-BAhPdx6o.js).

## Heights along roads

For detailed tiles, the worker also provides a compact set of segments with
an elevation at each end and a lateral reach. The browser indexes them in
spatial buckets. At a query point, it finds the nearest eligible segment,
projects the point onto it and interpolates between the two elevations. A
matching segment overrides the sampled terrain height in the lookup. Across
a single segment the height depends on distance along it, so the lookup has
no independent crossfall term. The terrain mesh and the query can therefore
represent different heights at the same position. The inspected
browser code does not establish how the source elevations were fitted.
[Tile worker](https://tinyprague.cz/assets/cell-worker-Xe7VmrLZ.js) and
[height lookup](https://tinyprague.cz/assets/index-BAhPdx6o.js).

## Bridge decks and approaches

Bridge pieces have their own mesh and height data. This lets an upper road
continue over the terrain without forcing the terrain grid to represent both
levels. The renderer checks bridge endpoints and nearby crossing alignments
when deciding whether to draw a railing along an edge. The height lookup can
query decks separately and use a reference elevation to choose among nearby
surfaces. These are features of the renderer as a whole. The linked view
alone cannot establish the height or clearance of the road underneath.
[Tile worker](https://tinyprague.cz/assets/cell-worker-Xe7VmrLZ.js) and
[deck lookup](https://tinyprague.cz/assets/index-BAhPdx6o.js).

## An experiment for Streets of Prague

Our game triangulates and drapes its ground layers separately. We could
rasterize our surveyed carriageway outlines and markings into a shared
material mask while keeping our procedural asphalt and existing height data.
Compare that rendering with the current one at a normal junction and at the
Kongresová approach, using the same top-down camera. With heights held constant, changes in visible roughness would show how
much the paving layers contribute. Inspect lane
markings, seams between tiles, and the transition from ground paving to the
deck. Measure the rendering cost before expanding the trial.
[Our ground renderer](../src/ground.ts) and
[road surface findings](road-surface-findings.md).

For a separate driving experiment, the Italská trial measured smoother cross-slope
transitions on a strip fitted to surveyed kerbs. Our next comparison
should use the same height function for the vehicle and the visible surface
inside the tested strip, then check the joins and the roads beneath any deck.
The Hořejší nábřeží trial explains why a smooth-looking interpolation still
needs survey checks where a road meets a retaining wall.
[Italská and Hořejší nábřeží measurements](road-profile-pilot.md).
