---
read_when: Working on how the city looks through the year (tree leaves, blossom, autumn colours, grass, fields), on the game's date, or on anything in src/weather.ts, src/sky.ts or src/map/vegetation.ts that depends on the month.
---

# Plan 022: Seasons

The city looks like high summer all year, except that broadleaf trees are bare from
December to February and snow can fall. This plan gives the game a date and lets the
trees, the grass, the fields, the light and the weather follow it, so that April,
July, October and January each look like themselves.

## Status and starting point

- Status: PLANNED. Two decisions to confirm first (below); the first is decided.
- Effort: four to five days for phases 1–4. Risk: medium for the trees (two renderers,
  the shadow pass, and the costliest shader in a wood); low for the rest.
- Planned at: `c2c76265e35c795e07a2b0b33f63ebb3f3db5afa`, 2 October 2026, from reading
  the code only. Nothing was run or measured while planning.

Before editing run `git status --short` and:

```sh
git diff --stat c2c76265e35c795e07a2b0b33f63ebb3f3db5afa..HEAD -- src/weather.ts src/sky.ts src/shading.ts src/map/vegetation.ts src/webgpu/trees.ts src/webgpu.ts src/clock.ts
```

## Current state

- `src/weather.ts`: `season(month)` sorts the real month into four seasons. It is
  used for two things only: which weather is likely to come next (`CHANCES`), and
  `WINTER`, which sets `BARE` to 1 from December to February. `BARE` also follows the
  snow cover, so `?weather=snow` in July strips the trees.
- `src/sky.ts`: `sunAt(sec, new Date())` already takes the sun's height and summer
  time from the real date. So the light is seasonal today; nothing else is.
- `src/clock.ts`: a day of the week and a time, wrapping after a week. No date.
- `src/map/vegetation.ts`, `treeInstances`: each tree's colour is picked in the tile
  worker from five fixed summer palettes and stored per instance. One of the fruit
  tree colours is blossom (`#c9c7a0`, "blossom in May"), shown all year. The only
  per-instance attribute besides the colour is `evergreen` (0 or 1).
- `BARE_GLSL` (and its TSL twin in `src/webgpu/trees.ts`) drops the leaves cell by
  cell as `uBare` rises, for every tree at the same moment. The shadow material uses
  the same mask.
- Ground: `COLORS.park`, `garden`, `wood`, `orchard`, `pitch`, `field` in
  `src/ground.ts` are fixed, and `pGrass`, `pWood` in `src/shading.ts` (and their
  ports in `src/webgpu.ts`) add fixed dry patches. Hedges use one green canvas
  texture (`src/map/fences.ts`).
- Birds sing in quiet places unless it rains or snows (`src/audio.ts`), whatever the
  month.

## Decisions to confirm

1. **Which season the game starts in.** Decided (2 October 2026): the start screen
   has a row of the four seasons (Spring, Summer, Autumn, Winter) with the current
   one picked already; no separate "Now". The current season's button means today's
   date in Prague, the other three a typical date each (decision 3). `?date=MM-DD`
   and `?season=` for links and tests.
2. **Whether the date moves.** Recommended: no. The date is set when a game starts,
   kept in the save, and stays. The clock keeps wrapping after a week. A year that
   passes while you play would need the trees to change under you and a calendar in
   the HUD, for little gain.
3. **Four seasons or a date.** Recommended: a day of the year inside, so that early
   October (green going yellow) and mid-November (nearly bare) differ, and the four
   start-screen choices stand for a typical date each (20 April, 15 July,
   20 October, 15 January).

## Design

One new module, `src/season.ts`, owns the date and turns it into a few numbers from
0 to 1 that everything else reads. They are smooth curves over the day of the year,
not four boxes:

| Value | Meaning | Roughly |
| --- | --- | --- |
| `leaf` | how far the leaves are out | 0 until late March, 1 by mid-May, falling again from mid-October to late November |
| `turn` | how far the leaves have turned | 0 until mid-September, 1 by early November |
| `blossom` | fruit trees in flower | a hump over the second half of April and early May |
| `fresh` | the light green of new leaves and spring grass | high in April and May, gone by July |
| `dry` | parched grass | rising through July and August, gone by October |
| `cold` | winter's dull grass, no birds | December to February, fading at both ends |

They are shared the way the weather's are (`WET`, `SNOW`, `BARE` in
`src/shading.ts`): one `SEASON` uniform (a vec4) for the trees and one for the
ground, set once when the date is set. Nothing is rebuilt when the season changes,
so the developer panel can have a slider for the day of the year and a screenshot
script can step through the year in one session.

### Trees

The seasonal colour moves from the tile worker into the shader, so tiles don't
depend on the date.

- The `evergreen` attribute becomes `kind`: broadleaf, evergreen, fruit tree, plus a
  random number per tree (its own timing and its own autumn colour). The palettes
  in `treeInstances` stay as the summer colours; the blossom colour leaves the fruit
  palette.
- **Autumn.** Each tree turns at its own time: `turn` shifted by the tree's random
  number, so in mid-October a street has green, yellow and half-bare trees side by
  side. The colour goes from the tree's green to yellow, ochre, rust or (rarely) red,
  chosen by the same number, with a little variation leaf cell by leaf cell. Leaves
  then fall with the existing `bareTwig` mask, per tree instead of all at once.
- **Spring.** The same mask in reverse: twigs, then small pale yellow-green leaves,
  then full crowns. Fruit trees go white or pale pink while `blossom` is up, before
  their leaves.
- **Winter** is what exists now. Snow still bares the trees whatever the date.
- Conifers and evergreen shrubs change nothing. Hedges get a tint on their material.
- The shadow material takes the same per-tree bareness, or shadows won't match.
- Both renderers: `leafy` in `src/map/vegetation.ts` and `src/webgpu/trees.ts`
  (see the `webgpu-port` skill and `scripts/check-material-sharing.mjs`).

### Ground

- `pGrass` gets a tint and a dryness from `SEASON`: brighter in spring, more yellow
  patches in late summer, dull olive in winter. `pWood` (the floor of a wood) goes
  brown with leaf litter from November to March.
- Fields (`field`): green in spring, straw in July and August, brown earth from
  October. Worth doing with plan 021's countryside, where fields fill the view.
- Each is a multiply or a mix on colours the shader already computes. Still, it runs
  on every ground pixel: measure it (the `performance` skill).

### Light, weather and sound

- `sunAt` takes the game's date instead of `new Date()`.
- `CHANCES` are blended between neighbouring seasons by the date, so late November
  isn't the same as early September. `WINTER` goes; `BARE` comes from `leaf`.
- The start screen's "Now: {weather}" button (the real weather in Prague) only shows
  while the current season is picked: real snow doesn't belong in a picked July.
- Lit windows follow the sun as well as the hour, so a January afternoon at five has
  them lit.
- Birds: most in spring mornings, fewer in late summer, nearly none in winter.

## Steps

1. **The date.** `src/season.ts` with the curves; `?date`, `?season`; the developer
   panel's slider; `window.__test.season()`; the save. Wire up what exists: the sun,
   the weather's chances, `BARE`. The game looks the same as before on today's date.
   Half a day.
2. **Trees.** The `kind` attribute, autumn colours and per-tree leaf fall, spring
   leaf-out, blossom, hedges; WebGL and WebGPU; the shadow pass. Two to three days.
   Stop and measure after the autumn colours: `scripts/bench.mjs --ab` in a wood
   (scenario `woods`) and on a tree-lined street. If the tree shader costs more than
   about 3% of the frame there, move the colour mix to the vertex shader (per tuft
   instead of per pixel).
3. **Ground.** Grass, the floor of the woods, fields. One day, with a bench of the
   ground at 2×.
4. **Start screen and words.** The season row and the poster's look for each
   (`index.html`), Czech strings (`src/cs.ts`), README, `site/index.html`, a note in
   `todo.md`. Half a day.

Each step ends with screenshots from `scripts/scene.mjs` of the same three places
(a park, a wood, a street with trees) on eight dates through the year, in both
renderers, shown side by side.

## Later, if wanted

- Fallen leaves on the ground under trees in autumn. The ground shader doesn't know
  where trees stand; it would need a mask over the view like the lamps' light map.
- Hoarfrost on grass and roofs on clear winter mornings (a thin use of the snow
  cover).
- The city's own calendar: no pleasure boats on the river in winter, fewer people
  out in the cold, Christmas markets on the squares, chestnuts in flower in May.
- Seasons for landmarks baked from the photo mesh: their trees are summer 2023 and
  stay green.
