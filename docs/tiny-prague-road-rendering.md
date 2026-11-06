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

## Shared asphalt trial, 6 November 2026

The WebGPU preview uses a cropped, one-channel coverage texture for surveyed
asphalt polygons. The tile worker rasterizes at two texels per metre and keeps
only the shared terrain triangles whose bounds touch the texture. Asphalt keeps
its procedural material and a separate pass so the ground layers draw in their
existing order. The mesh refines road-bearing edges when
height probes differ from a linear edge by over 8 cm. This refinement uses the
existing sampler and step cuts, with the same fixed stations along tile seams.

The first trial rasterized lane lines and zebra crossings too. It blurred the
thin markings at Kongresová and added 3.0–4.8 MB of mask buffers across the three
sampled views. The retained trial uses vector markings, which keep their original
screen-width behavior. Setts, tram beds, bridge decks and tunnel floors also use
their existing geometry.

Open the local WebGPU game with `?roadraster` to compare the asphalt path. The
option can be combined with `?roadsurfaces`. Both variants used `?roadsurfaces`,
map build `2026-11-06T00:13:10Z` and identical top-down camera poses. WebGL
and aerial photo mode use the vector asphalt mesh. I forced the WebGL 2
fallback inside Three.js's WebGPU renderer and verified it also drew vector asphalt.

### Shape and geometry

I inspected the Šperlova junction, the 5. května approaches over Kongresová,
and a Bohnická crossing of the 54_85 / 55_85 tile seam. The asphalt outline
shows some raster stair-stepping. The lane lines remained clear and the
bridge deck at Kongresová retained its visible perimeter.

The first mask sampled different interior texels on either side of a tile
join. Where a kerb crossed diagonally, the two halves could meet with a small
offset. Border texels now use coverage computed from the clipped road
outlines along the join. The coverage matched at the three sampled joins.
Across Prague, 11,780 of 874,195 asphalt edge texels (1.35%) still differed
at the rendering threshold when computed from the outlines on each side.
That count includes real kerbs along tile edges and is a comparison of
outline data.

The height checker matched the baseline on all 57,188 road segments. A
separate geometry probe compared rendered mesh heights with vehicle terrain
heights at 361 matching asphalt centreline points. The first, coarser shared
mesh reached a 47.2 cm error near Kongresová. Refinement brought the largest observed
error there down to 5.6 cm.

| Site | Ground triangles, baseline → raster | Largest sampled mesh/height difference |
|---|---:|---:|
| Šperlova junction | 696,734 → 623,740 | 10.3 → 7.8 cm |
| Kongresová | 701,580 → 649,156 | 31.7 → 5.6 cm |
| Bohnická seam | 698,895 → 632,351 | 9.7 → 9.3 cm |

These ground-triangle counts cover the loaded, dressed ground meshes in
each view, including the other ground layers. Each matched pair had the
same loaded tile set. The raw geometry and coverage buffers together rose by
0.48, 1.43 and 1.31 MB in those three views, respectively.

I also compared a top-down view of the curved street beside the retaining
wall at Hořejší nábřeží. The wall and the separate lower carriageway
remained visible, with some stair-stepping along the riverward kerb.
Ground triangles fell from 543,310 to 513,647, while the raw buffers
grew by 1.34 MB.

### Work as tiles arrive

A census of the assembled Prague map found asphalt bounds on 10,518 of
14,595 tiles. A cropped mask takes a median of 204 kB and about 250 kB at
the 95th percentile, counting raw one-byte texels. The total across all 10,518
tiles is 1.74 GB. The game generates masks with its streamed tile geometry
and disposes them when those meshes are dropped.

After optimizing coverage queries and caching refinement decisions, six
ground-worker round trips per variant gave these medians. They include
worker dispatch and transferring the geometry back to the page. These
timings predate the tile-edge coverage change.

| Tile | Current geometry | Raster trial |
|---|---:|---:|
| Šperlova junction | 34.2 ms | 35.8 ms |
| Kongresová | 47.5 ms | 59.3 ms |
| Bohnická seam | 18.8 ms | 20.5 ms |

Before the worker optimization, four eight-second headless Chrome/WebGPU
frame runs at Kongresová used High graphics, DPR 1, clear 14:00 and paused
simulation. The final version preserved the sampled mesh heights and added
three ground triangles at this view. The first pair averaged 3.45 ms per frame
for the baseline and 3.89 ms for raster. With raster first, the pair averaged
3.90 ms for raster and 4.12 ms
for the baseline. Draw calls stayed at 175. The raster runs had 95th-percentile
frame times near 33 ms, compared with 17–18 ms for the baseline.

The preview remains opt-in given the larger raw buffer footprint and slower
tile construction. Evidence, screenshots and reproduction probes are under
`docs/evidence/road-raster/` in the integration worktree.
