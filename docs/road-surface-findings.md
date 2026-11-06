---
read_when:
  - A street looks broken, tilted, bumpy or sunk in the game
  - Changing pipeline/dtm_heights.py's street heights, structures.py's bridges and tunnels, or src/stepEdges.ts
  - Thinking of another source for street or ground heights
---

# Road surfaces: findings, fixes and further research

Work of 5 November 2026 on branch `flat-roads` (worktree with cloned data). The
user's complaint: street surfaces "not flat, broken up a lot", then a wall across
5. května and a dip at náměstí Hrdinů, then a broken patch on 5. května by
Kongresové centrum (50.06130, 14.43124).

Consolidated on 6 November 2026 with additional research into data sources and road
reconstruction. The fixes, visual observations and before-and-after counts below
come from Claude's implementation investigation. The additional research inspected
the pipeline and cached survey records and checked public data catalogs on 5 November;
it did not rebuild the map or validate the proposed approaches in the game. Source
availability and licensing below describe that research snapshot. Subsequent
[implementation trials](#implementation-trials-6-november-2026) record the work
and measurements from later on 6 November.

## Where a street's shape comes from

- **Outline:** the technical map's (DTM ZPS) street polygons, cut per tile in
  `osm_area.py`. OSM only says which street it is and whether it's a bridge or a tunnel.
- **Height:** the shared lattice, a point every ~4 m, from IPR's terrain model
  (a TIN with points ~10 m apart), corrected by `dtm_heights.apply` with the survey's
  kerb lines. The game drapes the ground over the lattice (`src/ground.ts`, triangles
  of 8 m, normals straight up).
- **Bridges and tunnels:** levels of their own with their own heights
  (`structures.py`), drawn over or under the ground.

A street 15 m wide is only three or four lattice points across, so whatever the
lattice gets wrong shows on the street.

## Findings

1. **Streets leaned and twisted across.** Each point on a street took its height
   from the 6 nearest kerb points. On a hillside the uphill and downhill kerbs differ
   by up to a metre, so the street tilted towards whichever kerb was nearer, and
   the tilt changed from cell to cell. Fix: `_level_across` makes a car street level
   from kerb to kerb (the mean of both kerbs across from each point). It skips kerbs of
   streets passing under or over it, and blends where streets meet.
   `ipr_terrain.py --no-level` builds without it.
2. **The parapet across 5. května at náměstí Hrdinů** was a step-edge parapet
   (`src/stepEdges.ts`), not a bridge's. A bridge's street gets a flat terrace before the
   bridge (`structures.pads`), a step over the ground under the deck, and bridge ways
   never counted as streets crossing that step. Fix: each end of a bridge's raised
   stretch now counts (`bridgeEnds` in `src/tiles.ts`).
3. **The dip before the bridge there** came from fix 1: the levelling skipped
   everything within 6 m of a bridge, so the street's last metres kept heights smeared
   down from the cutting. Fix: skip only points under the bridge's outline.
4. **Tried and dropped:** extra flat terraces for the low ground under bridges. They
   made steps over 1 m rise from 36 to 48 (Pražský okruh under overpasses, Štefánikův
   most's join) with no visible gain.
5. **5. května by Kongresové centrum:** Kongresová passes under it. OSM maps a tunnel
   45 m long; IPR's terrain model has an open cutting 20 m wide and 6 m deep there,
   because the model leaves the deck over it out, as it does every bridge's. So the game
   stood the tunnel's 5.5 m walls up out of the cutting and laid 5. května down in it.
   The surface used by the existing survey-height path merges the street on top and
   the one below, so those kerbs did not resolve the crossing. The later inspection
   found additional elevated survey objects nearby; their relevance to the full
   crossing still needs checking (see "More of the existing technical map").
   - Tried: raising the ground over a tunnel from the ground beside it. Nothing
     changed: the ground beside the tunnel is in the cutting too.
   - Tried: bridging each street that crosses a tunnel straight from its heights on
     either side. It filled the dip but left the road patchy and the walls in pieces,
     and it hit streets going down past real portals (Radlická at the Strahov tunnel,
     Za Elektrárnou, Blanka).
   - Done: `structures.cuttings`. A tunnel under 80 m long, crossed by a car street
     whose terrain dips more than 2 m under it, with the street about level from side
     to side, is turned round as the terrain model has it. The underpass is on the
     ground in its cutting, and the street over it is on a short bridge (a way marked
     `cut`, without pads). The street on the ground gets that stretch as a level
     (`OnLevels.over_cutting`), and the game paints it on the deck (`onDeck` in
     `src/ground.ts`). Under such a bridge the ground is the cutting's, whatever kerbs
     are nearest. Two traps on the way: the underpass's own street crosses the new
     bridge's line, so only stretches running along it count as on the deck; and a
     two-way street is two edges along one line, which gave two decks until one was
     dropped. Footway and cycleway subways are left alone: Povltavská's became a deck
     standing across the street, and a subway really is covered.

     The praha build turns 6 underpasses round: Kongresová under 5. května, under
     Barrandovský most's approach, under Wilsonova, under Pražská, under a motorway
     link at 49.98, 14.48, and Hartenberská under Pražský okruh. In Claude's visual
     inspection, all but Wilsonova (no change) looked better than before.
     Pražský okruh keeps one step
     where its deck ends (4.7 m, flagged `deck` by the flatness check), still less
     broken than before.

## Numbers

`node scripts/check-road-flatness.mjs praha` (car streets with a finding):

| Problem | Before | After fixes 1–3 |
|---|---|---|
| Steps over 1 m | 40 | 35 |
| Bumps over 0.5 m | 683 | 563 |
| Leaning over 15 % | 4039 | 3026 |
| Ridges or troughs over 1 m | 216 | 151 |
| Twisting over 12 % | 2912 | 2479 |

Fixes 1–3 are in main since 34c361d, with the map rebuilt. Fix 5 is committed on
`flat-roads` as `ccd182f3`; its results are not included in the table. It changes
these counts by a street or two either way (steps over 1 m 35 → 36: the Pražský
okruh deck end).

## Checking a place

- `node scripts/check-road-flatness.mjs praha --near lat,lon,120` lists what's
  wrong with the streets round a place; `--save`/`--against` compare two builds.
- `uv run --project pipeline python .agents/skills/terrain-steps/terrain_at.py praha lat lon`
  prints the lattice there, with labels and level heights.
- `node scripts/check-step-edges.mjs praha` checks solid edges and parapets. It now
  uses the same raised bridge-approach segments as the game (`src/roadLevels.ts`),
  so bridge entrances are open in the offline check as well as at runtime.
- A height map with the tunnels, bridges and streets drawn over it shows a trench
  or a hump at a glance. That's how the cutting at Kongresová showed up.
- From above and from a low oblique angle, before and after:
  `node scripts/scene.mjs eval --url … "await t.camera({at:[lat,lon], height:25, tilt:55, heading:330, level:true}); await t.shot('x')"`.
  A first-person view shows the same breaks much more harshly.

The normal top-down camera is the acceptance view for the game. Oblique and
first-person views are diagnostic aids. Keep the actual camera pose fixed when
comparing builds: a camera height relative to changed terrain can move the viewpoint.
See [the terrain investigation](river-terrain-findings.md) and the
[terrain skill](../.agents/skills/terrain-steps/SKILL.md) for the comparison workflow.

## Data sources to investigate

### More of the existing technical map

There is useful information in the cached DTM ZPS packages that the road-height
reader does not retain. The packages inspected contain bridge footprints
(`Plocha mostní konstrukce`), tunnel surface polygons, terrain breaklines, object
identifiers, placement levels, height-accuracy classes and acquisition methods.

In [dtm_heights.py](../pipeline/dtm_heights.py), `_tables` returns object type,
placement level and geometry. `survey` retains selected objects at level zero;
surface polygons become two-dimensional, and wall lines lose their heights.
Most source attributes are not carried forward. This is specifically the
survey-height path: [dtm.py](../pipeline/dtm.py) already retains placement levels
for its selected surface types and exposes raised carriageways.

Within 35 m of the reported Kongresová coordinate, the cached packages contained
a bridge footprint, level-1 road polygons and level-1 survey lines. For example,
bridge footprint `1000338903053` and road polygons `1000338903031` and
`1000338903032` have placement level 1. Their polygon geometries have no Z values,
so they can inform the extent and identity of a deck, not directly its height.
Elevated line records nearby do carry measured heights.

Matching the survey polygons to the actual crossing, near 50.06160, 14.43082,
showed why the original cutting rule missed part of 5. května. Its 38.0 m deck
follows one carriageway (DTM `1000338903031`). The other carriageway and its slip
road run through DTM `1000338903032` on the same footprint. The nearby level −2
tunnel `1000414175124` belongs to a different crossing. Its closest point is
14.6 m from the original deck centreline. The carriageway and footprint exports
are from 31 October 2026. The construction-line export is from 31 August 2026.
The bridge perimeter has uncertain height accuracy (class 9). Class 3 and 5
measurements along the second carriageway's kerbs and median support a surface
around 241 m. [ČÚZK rules for structure footprints](https://dtmwiki.cuzk.gov.cz/01_pravidla/01_zaklad/04_plosne_objekty_zps),
[survey accuracy classes](https://dtmwiki.cuzk.gov.cz/01_pravidla/01_zaklad/02_presnost).

The optional `--survey-companion-decks` uses that relationship to add 39.2 m of
5. května and 43.7 m of its slip road. The source observations verify the deck
level against both approaches, and the profiles join the terrain heights at
their ends. In a six-tile comparison, the largest bump on the added 5. května
stretch fell from 1.05 m to 0.01 m, and its cross-slope from 31.7% to 3.9%.
The slip road went from a 1.01 m bump and 41.6% cross-slope to 0.06 m and 4.7%.
Kongresová stays on the lower ground, where it still has a 0.71 m bump and
29.5% cross-slope. The change relies on an existing cutting deck and leaves the
original rule in place for crossings without a match.

The separate DTM transport-infrastructure model also defines road axes, network
nodes and bridge extents. Its populated coverage and usefulness here remain to be
checked; the existence of a schema does not prove local completeness.
[Official DTM transport-infrastructure attributes](https://dtmwiki.cuzk.gov.cz/03_di_metodika/07_prilohy/03_atributy_di).

### IPR's LiDAR-derived terrain raster

IPR describes a new terrain survey acquired in 2023 using LiDAR, with at least
20 input points/m², and an open terrain raster at 1 m resolution. The raster's
metadata describes approximately 40 input points/m², a 2023 revision and CC BY
licensing. These densities concern the source survey, not the output grid.
[IPR terrain description](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-model-dtm),
[raster metadata](https://www.arcgis.com/sharing/rest/content/items/97d2c9c11aa9478cb21b469b8a4f820e/info/metadata/metadata.xml?format=default&output=html).

The current importer reads `TER_*` CityGML TIN sheets, documented as having points
approximately 10 m apart. Compare the two products at difficult places before
assuming the 1 m raster is an improvement: the research verified its publication
and provenance, not its accuracy relative to the imported TIN. It remains bare
terrain and omits bridges.

The ArcGIS catalog item is `97d2c9c11aa9478cb21b469b8a4f820e`. Use the numeric
terrain download for such a comparison. The inspected `d3m/stinovany_relief`
ImageServer returns an unsigned-byte shaded image, not elevations; even its
`None` rendering function does not turn those pixels into heights.

### IPR's surface model and photorealistic mesh

The project already has a local 1 m digital surface model (DSM), used by
[ground_cover.py](../pipeline/ground_cover.py) for ground cover and vegetation.
Its catalog item is `a6120ef1652e4df2b1202c1a8ad4e0c7`. IPR also describes a
25 cm DSM, generated from aerial images and updated annually. Unlike bare
terrain, it includes visible structures, but also vehicles and vegetation.
[IPR surface model](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-model-dsm).

Use it as evidence for road patches that join smoothly to their approaches.
Directly copying its heights, or taking the maximum of terrain and DSM, would
turn cars and trees into road humps. A promising combination is surveyed polygons
for road extent, bare terrain for surrounding land, and selected DSM observations
for a deck above a cutting. Aerial data cannot measure a lower road hidden by a deck.

IPR's photorealistic mesh can provide visible deck geometry and structural edges
missing from the terrain model. It is an open dataset based on summer 2023 imagery
and contains vegetation, vehicles and other objects. Its approximately 5 cm texture
resolution is not a claim of equivalent geometric accuracy. The project already
reads the mesh through [photomesh.py](../pipeline/photomesh.py).
[IPR photomesh description and downloads](https://geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3D-mesh).

One experiment would fit simple road surfaces to selected mesh observations,
rejecting vehicles and vegetation, rather than importing the mesh triangles.
Coverage of lower roads remains limited by what the aerial acquisition could see.

### Street LiDAR

IPR's search-indexed mobile-mapping article describes laser scanning in 2020–2021
across publicly accessible paved streets. The article failed to load directly
during research, so citywide access remains an unconfirmed lead.
[Indexed mobile-mapping article](https://test.geoportalpraha.cz/data-a-sluzby/clanky-a-projekty/3D-model/3d-model-lidar).

Public IPR point-cloud catalog entries were independently verified, including
`Lidar_Col_10_Magistrala`, item `21e084b84af14421abb0cb09765cd888`. That sample
covers part of the central Magistrála, not Kongresová. Its license field was empty;
public visibility alone does not establish permission to redistribute derived
geometry. [Magistrála sample](https://www.arcgis.com/home/item.html?id=21e084b84af14421abb0cb09765cd888).

Road-only extracts or cross-sections could be especially useful for kerbs and
road floors under overhead structures, where aerial products cannot see. Before
depending on this source, establish actual coverage, downloadable formats and
terms for distributing derived game geometry. No request for data was sent.

### ČÚZK terrain and surface products

The existing [dmr5g.py](../pipeline/dmr5g.py) prototype uses DMR 5G for bare-earth
heights. It is a candidate for terrain comparisons and areas outside IPR's coverage.

The newer DMP OK is a different product: a surface model from image correlation.
Its metadata lists point data at 0.2 m spacing and a 0.5 m raster, with acquisition
in 2024–2025 and CC BY 4.0 licensing. It offers another source for comparison and
coverage beyond Prague. Fine spacing does not imply equivalent vertical accuracy,
and aerial measurements cannot recover hidden road surfaces.
[DMP OK metadata and downloads](https://geoportal.gov.cz/php/micka/record/basic/CZ-CUZK-DMPOK?dlang=cze).

### Mosaic REALMAP

Claude's original investigation records [Mosaic REALMAP](https://realmap.mosaic51.com)
as street-level photography, not a ready-made 3D model: approximately 1.2 million
georeferenced images, one every metre, totaling 4.6 TB, with access through a form
and a CC BY-NC-SA license. Those acquisition details and terms were not independently
rechecked during the additional research.

The original decision was to exclude it as a source for the game's distributed
data because of the non-commercial and share-alike terms. A few image sequences
could still help investigate what exists at a broken location, subject to their
access terms. Street photography is also less directly useful for the game's
top-down presentation. This dataset is separate from the street LiDAR lead above.

## Proposed road model

The main architectural experiment is to reconstruct connected road surfaces from
measurements. The coarse terrain would continue to describe the surrounding land.
This is a proposal, not an implemented or validated replacement for the fixes above.

### Profiles and junctions

Give each street a smooth height profile along its length and a controlled
cross-section across its width. Fit measurements robustly, weighting their quality
and rejecting outliers so one bad survey vertex or parked vehicle cannot bend the
road. Retain real longitudinal slopes, banking and road crown; zero cross-slope
should be a fallback when evidence is weak, not the universal definition of a
correct road.

Junctions need shared patches joining their approaches. Independently smoothed
streets can still arrive at different heights or slopes. ASAM OpenDRIVE's separation
of longitudinal elevation and lateral shape is a useful precedent; adopting the
format itself is not required.
[ASAM road geometry](https://www.asam.net/fileadmin/Standards/OpenDRIVE/ASAM_OpenDRIVE_BS_V1-7-0.html).

### Connections and crossings

Resolve which surfaces physically connect before fitting their heights. Use road
continuity, survey placement levels, bridge outlines, OSM connectivity and observed
heights to associate measurements with the upper or lower carriageway. Only surfaces
that actually join should share continuity constraints. Keep conflicting evidence
visible instead of silently averaging it.

The short-underpass rule can remain a fallback where structural information is
missing. Where explicit evidence exists, use it to establish the deck's extent and
connections rather than making tunnel length and a terrain depression the main test.

### Geometry and vehicle sampling

Keep fitted road surfaces out of the coarse terrain lattice. Triangulate them with
vertices along kerbs, junction joins, portals and deck ends; retain walls as explicit
edges that triangles cannot cross. Flat stretches need few triangles, while changing
profiles need more. Join surrounding terrain, pavements and walls to the road at
explicit edges, retaining genuine steps where appropriate.

Rendering and vehicle-height queries must use the same reconstructed surface.
A visual overlay alone would leave vehicles following the old bumps. A pilot can
replace one connected area while leaving the rest of the map on its existing model.
The runtime and memory cost of this representation has not been measured.

## Further experiments

These are untested extensions of the proposed reconstruction approach.

- **Find structures through source disagreement.** A continuous road-shaped surface
  above a depression in bare terrain is a candidate deck. Require connectivity and
  supporting mapped objects: buildings, trees, vehicles and different survey dates
  can also produce height gaps.
- **Use acquisition dates to reject temporary objects.** A protrusion that moves or
  disappears is weak evidence for permanent geometry. Compare dated observations;
  blindly taking the minimum across years could erase a rebuilt road or select the
  lower road at a crossing. Availability and alignment of suitable repeated coverage
  still need checking.
- **Record manual corrections as relationships.** A reviewed instruction such as
  "this carriageway joins this deck" or "this wall ends here," with its source, date
  and reason, could survive updates better than a location-specific smoothing rule.
  Let the same reconstruction process derive the geometry from those constraints.

## Suggested comparison

Start with four small areas rather than a citywide rebuild:

| Area | What it tests |
|---|---|
| Kongresová / 5. května | Assigning the crossing roads to the correct surfaces |
| Italská | Preserving a hillside street's profile without artificial cross-slope |
| Hořejší nábřeží | Separating a road from the retaining wall beside it |
| An ordinary junction, chosen before testing | Preserving a place that already works |

First match the unused technical-map objects to the roads and compare the terrain
products. Then fit independent road patches using the most reliable observations.
Keep input versions and a baseline so changes in data and reconstruction can be
distinguished.

Compare fixed top-down views, joins, slope continuity, separation between crossing
roads and agreement between rendered geometry and vehicle samples. Reuse
`scripts/check-road-flatness.mjs`, `scripts/check-bridge-decks.mjs` and
`scripts/check-step-edges.mjs` on baseline and candidate data; inspect the chosen
locations as well. Better flatness counts must not come from deleting genuine slopes
or hiding one road beneath another. Check seams where the pilot meets unchanged tiles.

Priority: use more of the existing survey, compare the LiDAR terrain raster, then
pilot explicit road surfaces. Investigate street LiDAR access for cases the existing
sources cannot resolve. The trials below test several of these directions.

For a comparison with a simpler renderer, see
[how Tiny Prague renders roads](tiny-prague-road-rendering.md).

## Implementation trials, 6 November 2026

The overnight work used isolated checkouts based on `flat-roads` at `3dfafe52`.
The integrated code is on `codex/road-reconstruction`. The baseline Prague map
was built at `2026-11-05T22:58:30Z`; its producer identifies itself as
`34c361d375-dirty` (a dirty working tree), distinct from the `3dfafe52` checkout
base used for these experiments. The final survey candidate was built at
`2026-11-06T00:13:10Z` from `d5e2afebc7` and copied into the integration preview.
No production deployment or push was performed.

### Survey-supported decks at Kongresová

The additional survey records address a specific omission. The existing inferred
bridge carried one 5. května carriageway. A second carriageway and its connected
slip road belonged to the same surveyed bridge footprint but still followed the
cutting below. The opt-in `--survey-companion-decks` build adds 39.2 m of the main
carriageway and 43.7 m of the slip road, using same-level road polygons and measured
road-edge vertices to check the approaches. Kongresová remains underneath.

The first city build exposed unrelated pedestrian-height changes caused by inserting
new structures into the existing solve and level assignment. The accepted version
solves the original network first, uses a separate synthetic-ID range and independent
approach-to-approach profiles for the additions, and preserves existing masks outside
the affected tiles. It refuses an addition if its numeric level would contradict the
vertical order of existing decks. This matters because the runtime uses level order
to find the lowest bridge and overhead cover.

| Checked road segment | Largest absolute bump | Largest absolute cross-slope | Largest change in cross-slope over 4 m |
|---|---:|---:|---:|
| Second 5. května carriageway | 1.05 → 0.01 m | 31.7 → 3.9% | 31.0 → 3.0 percentage points |
| Connected slip road | 1.01 → 0.06 m | 41.6 → 4.7% | 38.7 → 3.7 percentage points |
| Lower Kongresová segment | 0.72 → 0.70 m | 29.5 → 29.5% | 32.2 → 27.6 percentage points |

The lower road was essentially unchanged and still has a surface problem. The
added decks are roughly 5.6–5.8 m above it at the checked centreline crossings.

Of 36,988 tile files, exactly three changed, all for tile `59_53`: `59_53.json`,
`59_53.height.bin.gz` and `59_53.levels.bin.gz`. All other tile files were
byte-identical, with none added or removed. Five of 57,188 checked car-network
rows changed, all at this crossing, with no new threshold failures. All 4,135 bridge
rows matched the baseline. The step-edge report also matched when both maps were
checked with the identical checker revision. There were no
additional stale cover or young-wood entries. The local assembly retained the copied
IPR building layer with a dependency warning; this was not a strict release build.

### Traffic and actual driving

Geometry alone was insufficient. The inferred spans carry `level` or `levels`
metadata but retain their original OSM bridge/tunnel flags. Traffic used those flags
for placement and could start below the visible carriageway. The runtime now resolves
the current lane station's named level against its own mask and finite height. It
sets vehicle height and level together and falls back to ground when that named
surface is absent. Raw centreline stations remain unchanged for rendering; offset
lane stations are prepared separately. Traffic, routed buses and the developer road
reset use this information, and taking over a vehicle releases its route's level
intent while preserving its resolved position.

On the final map, traffic spawned on both new upper spans and drove onto the ground
at their ends. Both directed Kongresová roads stayed on the lower surface. Player
car drives at a nominal 25 km/h also completed the main, slip and lower routes
without damage. Recorded upper-road transitions were ground → deck → ground; the
largest actual height changes per simulation step were 0.022 m and 0.016 m. The
lower drive remained at level zero, with a largest change of 0.058 m.

The existing `t.follow().jump` reports bare terrain, including the cutting underneath
a bridge. These checks recorded the vehicle's actual `gz` and `level` instead; the
bare-terrain diagnostic must not be presented as a vehicle falling through a deck.

### Italská profile and the rejected quay experiment

A separate opt-in `?roadprofiles` pilot fits 50 m of Italská from both surveyed
kerbs and uses the same surface for vehicle height and rendered ground. It preserves
a 4.7–6.8% downhill grade and approximately 2.07% cross-slope. The largest change
in cross-slope fell from 11.1 to 1.8 percentage points, while the adjacent junction
retained its sampled height. The maximum sampled mesh-to-vehicle difference in the
core fell from 0.761 m to 0.008 m. Withheld survey stations come from the same lines
as the fit, so their smaller residuals are not independent accuracy validation.

Three alternating static WebGPU timing pairs gave aggregate frame times of
4.2 → 4.3 ms, with individual pairs changing in both directions. Draw calls stayed
at 140; the rendered triangle count rose about 0.9%. This establishes no stable
performance gain or regression. Hill shading still uses the old terrain lattice.
The new bridge spans also retain generic bridge paving and edge styling; these
trials establish geometry and traversal, not a finished citywide surface style.
[Profile measurements and reproduction](road-profile-pilot.md),
[performance log](performance-log.md).

At Hořejší nábřeží, raw survey records confirmed a wall top around 193.89 m and its
foot around 190.50 m. A curved asymmetric trial respected the measured core and
improved smoothness, but its northern transition lay about 1.1 m below both the
measured wall top and a separate road kerb. It was rejected and never added to the
runtime. A longer blend would not solve the changing relationship between the road
and wall; that location needs separate road and wall surfaces with supported joins.
The observations and rejected constructions are preserved in local evidence.

### LiDAR source comparison

The numeric IPR raster was downloaded, checked against a pinned SHA-256, decoded
and integrated as an opt-in source with CityGML fallback outside its valid coverage.
The 1 m raster's embedded metadata describes a July 2025 export from a corrected
25 cm terrain model. The import pins its optional TIFF decoder packages; normal
terrain builds read a NumPy cache and need no new package downloads.
[Import and rebuild instructions](rebuilding-the-map.md).

Four Újezd builds separated source effects from survey corrections. Without the
corrections, hard-limit bumps fell from 7 to 0, cross-slope findings from 25 to 2,
and twist findings from 22 to 0. With normal corrections, the corresponding counts were 2, 4 and 2 with either
source, and one new ridge warning appeared near Divadelní/Národní after the swap.

| Prague road segments beyond the hard limit | Existing source | LiDAR source |
|---|---:|---:|
| Steps over 1 m | 36 | 35 |
| Bumps over 0.5 m | 563 | 403 |
| Cross-slope over 15% | 3,024 | 2,227 |
| Ridge/trough over 1 m | 150 | 141 |
| Cross-slope change over 4 m above 12 percentage points | 2,480 | 1,775 |

These gains do not justify switching the default source. Nine old hard steps
cleared the threshold but eight new ones appeared, including a 5.44 m wall step and
a 3.57 m step at Nad Výšinkou. Karlův most's worst join increased from 0.39 to
1.48 m, creating a fifth named bridge failure. Inferred cuttings also changed:
Národní and K Přehradám appeared, Wilsonova and Pražská disappeared, and the
Kongresová span narrowed from 38 to 22 m. The road graph's edge IDs were unchanged;
277 edge annotation records changed, including 75 tunnel flags and 202 level-only
changes. Changed level annotations alone do not establish a change in physical connectivity.

The terrain-only build omitted stale cover and young woods. Asphalt-cover masks
were present in 8 tiles instead of 1,017. A separate checker-only copy with the old
asphalt masks restored produced the same hard-limit counts for steps, bumps, cross-slope, ridges, twist
and off-carriageway stretches; it was a
sensitivity check, not a validated game map. LiDAR remains opt-in, and the final
integration preview uses the existing terrain source with the surveyed deck fix.

### Driving frame-cost check

The final runtime was compared with the frozen baseline in three eight-second
Old Town driving pairs, followed by three pairs in the reverse order. The first
order averaged about 4.0 → 4.1 ms per frame; reversing the order also made the
second variant slower, even though that second variant was now the baseline.
Across all six samples per variant, means were 3.99 ms for baseline and 4.02 ms
for candidate. Scene draw counts varied slightly. This does not isolate a stable
cost of the tracking change, and phone performance remains unmeasured. The
Italská profile was disabled for this check. Exact conditions and per-pair results
are in the [performance log](performance-log.md).

### Validation and remaining limits

The integrated code passed 347 pipeline tests, 36 focused Node tests, TypeScript
checking and a production build. Two read-only Codex reviews reported no actionable
findings. Fixed top-down comparison screenshots have identical eye positions and
quaternions; screenshots covered the changed locations and the unchanged
Hořejší nábřeží and Újezd controls.

The broad game suite was not fully green: both candidate and frozen baseline had
five failures among 48 scenes. Four matched: passenger-door theft, regular-customer
mission, step edges and tunnel mouth. Dustcart failed only in the candidate's full
run, while police-fair failed only in the baseline. Dustcart then passed two focused
reruns on each. The tile-lifecycle check also has a baseline-reproduced fixture
failure (`turns.shift`). These results are recorded rather than counted as passes.

The next model work should use the raw wall and road-edge elevations to reconstruct
connected, curved carriageways and junctions without blending through real steps.
LiDAR is a useful additional terrain measurement, but the trial shows that source
replacement alone does not resolve the road/structure interpretation problem.

Local logs, map snapshots, source observations, screenshots and rejected fits are
under `docs/evidence/road-reconstruction/` in the integration worktree. They are
ignored working records, not committed map data. The source implementations and
these findings are committed; pushing, merging into main and deployment remain
outside this overnight task.

## Wider screened surfaces

The subsequent Prague trial retained 74 fits after checking measured road
heights, approaches and collision edges. Its curves, junctions, wall trials and
citywide comparison are recorded in [the road surface pilot notes](road-profile-pilot.md).

## Lower ground beside elevated roads

At Husitská, the apparent wall and the steep roadside pavement have different
causes. The coarse IPR terrain, sampled before the road corrections, already
climbs across the pavement toward the elevated ground. The road corrections
lower the carriageway but leave much of that rise on the pavement. The
independent 1 m IPR LiDAR raster shows a level strip beside the lower road,
consistent with the surveyed kerbs. The rise occurs farther from the road.

The new generator scans ground roads on tiles that contain bridges. It looks
for a continuous strip where the LiDAR heights agree with the lower road
but the assembled terrain is at least 1.2 m higher. It can follow the lower
strip, or shelf, across a road node. The fit takes the measured lower
elevations throughout the shelf and tapers back at its edges. A first attempt
weighted each node by the difference between the two sources. That introduced
a new wave on the Husitská approach, so the current fit uses the difference
to identify the strip and then blends its heights continuously.

The mask keeps at least 1.4 m of clearance between its active grid vertices
and buildings, rail lines, water and labelled terraces, with a separate
taper near bridge approaches. The preview uses the existing height sampler
for the lower ground and separate height samples for the elevated levels.

The scan checked 13,711 ground roads on bridge tiles and flagged 183
stretches. The pilot tried 12 fits and retained six after local road, bridge
and collision checks. The combined file passed the checks on all 57,188 road
segments, 4,135 bridge paths and the citywide collision edges.

At a sampled section of Husitská, the rise between the road centre and
the pavement 7.5 m to the right fell from 5.5 m to 0.3 m. The low and
overhead views show the pavement and parking restored below the bank.
Farther toward the ramps, the protected outer edge still rises sharply.
In one 1.5 m cross-section there, the rise increased from 1.9 m to 2.3 m
as the lower part of the pavement dropped.
Fixed-camera spot checks also measured the fitted ground 2.7 m lower at
Pernerova and 3.1 m lower at Švehlova. At both sampled points the new height
was closer to the LiDAR measurement.

The beige wall visible farther ahead comes from an IPR building face
several metres outside the roadway. In the low view it draws through
foreground terrain. The experimental ground depth pass hid the face and
exposed distorted surfaces at the ramps. The preview uses the shelf fit
with the existing renderer. The remaining overlap involves the terrain
and deck geometry at the interchange.

Generate and check a preview in a private worktree with the matching map,
screened road sidecar and imported LiDAR cache.

```sh
e=docs/evidence/interchange-repair
map=public/data/praha_now
current="$map/road-corridors.json"
baseline=docs/evidence/prague-corridors/final-roads.json
mkdir -p "$e"
uv run --project pipeline python pipeline/road_shelves.py \
  --data "$map" --lidar pipeline/.cache/ipr_lidar/2023 --current "$current" \
  --priority-edge '1017997567>11293600574>0' \
  --out "$e/protected.json" --report "$e/protected-report.json"
node scripts/screen-road-shelves.mjs "$current" "$e/protected.json" \
  "$e/protected-report.json" "$e/protected-screened.json" "$e/protected-screen"
node scripts/check-road-flatness.mjs praha --roadsurfaces "$e/protected-screened.json" --save "$e/protected-roads.json"
node scripts/check-step-edges.mjs praha --roadsurfaces "$e/protected-screened.json" --save "$e/protected-steps.json"
node scripts/verify-road-corridors.mjs "$current" "$e/protected-screened.json" \
  "$baseline" "$e/protected-roads.json" "$e/protected-steps.json"
node scripts/check-bridge-decks.mjs praha --roadsurfaces "$current" --save "$e/bridges-before.json"
node scripts/check-bridge-decks.mjs praha --roadsurfaces "$e/protected-screened.json" \
  --against "$e/bridges-before.json" --strict-regressions --save "$e/protected-bridges.json"
```

The baseline deck command writes its report even if existing bridges
exceed its limits. The final comparison checks for increases against that
baseline. After the checks pass, copy the screened file to
`public/data/praha_now/road-shelves.json` and add `&roadshelves` to the
local comparison link. The evidence directory contains the matched
captures, source samples and screening decisions.
