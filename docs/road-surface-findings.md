---
read_when:
  - A street looks broken, tilted, bumpy or sunk in the game
  - Changing pipeline/dtm_heights.py's street heights, structures.py's bridges and tunnels, or src/stepEdges.ts
  - Thinking of another source for street or ground heights
---

# Road surfaces: why they broke, and what was done

Work of 5 November 2026 on branch `flat-roads` (worktree with cloned data). The
user's complaint: street surfaces "not flat, broken up a lot", then a wall across
5. května and a dip at náměstí Hrdinů, then a broken patch on 5. května by
Kongresové centrum (50.06130, 14.43124).

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
   The survey merges the street on top and the one below into one surface, so the
   kerbs don't help either.
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
     link at 49.98, 14.48, and Hartenberská under Pražský okruh. At all but Wilsonova
     (no change) the place looks better than before. Pražský okruh keeps one step
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

Fixes 1–3 are in main since 34c361d, with the map rebuilt. Fix 5 changes these
counts by a street or two either way (steps over 1 m 35 → 36: the Pražský okruh deck
end).

## Checking a place

- `node scripts/check-road-flatness.mjs praha --near lat,lon,120` lists what's
  wrong with the streets round a place; `--save`/`--against` compare two builds.
- `uv run --project pipeline python .agents/skills/terrain-steps/terrain_at.py praha lat lon`
  prints the lattice there, with labels and level heights.
- A height map with the tunnels, bridges and streets drawn over it shows a trench
  or a hump at a glance. That's how the cutting at Kongresová showed up.
- From above and from a low oblique angle, before and after:
  `node scripts/scene.mjs eval --url … "await t.camera({at:[lat,lon], height:25, tilt:55, heading:330, level:true}); await t.shot('x')"`.
  A first-person view shows the same breaks much more harshly.

## Other sources

- **Mosaic REALMAP** (realmap.mosaic51.com) is street-level photography, not a
  3D model: 1.2 million geo-referenced images, about one every metre, 4.6 TB. The
  licence is CC BY-NC-SA, signed for with a form. Not for the game's data
  (non-commercial, share-alike, and the camera looks down), but a few reels could
  show what is really at a broken place.
- IPR's photorealistic mesh (CC BY) has the decks the terrain model leaves out, and
  could say where a short underpass is covered.
