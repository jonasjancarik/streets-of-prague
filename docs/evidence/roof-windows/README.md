# Roof windows found on the photo mesh: how many are false

7 October 2026, plan 005. `detect_windows` in `pipeline/mesh_colours.py` looks for roof
windows as bright or dark patches in pitched roofs on the photo mesh from above. This is
a count, by eye, of how many of its finds are windows.

## How

`eval_windows.py` (run from `pipeline/`, with `keep_key.py` beside it) takes six tiles
of `praha` and, in each, the first seven buildings with at least one find, in an order
fixed by a hash of the building's id: Smíchov (Plaská), Vinohrady (Mánesova), Staré
Město (Celetná), Bubeneč, Krč and Břevnov. For each it draws the roof from the mesh's
finest level (5 cm a pixel) with the finds outlined, plain beside marked. 42 roofs
came out; 29 of them were judged find by find, before and after the change, and are
the table below (the other 13 were looked at only as small pictures: not counted).

A find counts as a window when the outline sits on a roof window, a glazed hatch or
one pane of a group of them. Chimneys, their shadows, dormers' sides, solar panels,
vents and a second outline on a window already found count as false. A raised glass
lantern counts as false (it isn't a window in the roof's plane). Where I couldn't tell
(a dark square that might be a hatch or a stain: roofs 101262, 79859) it counts as false.

## Result

| | finds | windows | false | false share |
|---|---|---|---|---|
| before | 143 | 61 | 82 | 57 % |
| after | 78 | 53 | 25 | 32 % |

The change keeps 53 of the 61 windows (87 %) and drops 57 of the 82 false finds (70 %).

What the false finds were, before: shadows of chimneys and of roofs' own steps (about
half), chimney tops and sides, the bright lit sides of dormers, eaves and gutters, a
solar panel. What is left after: chimney tops whose height the mesh doesn't show (level
14's geometry is too coarse for a 60 cm chimney), a few shadows of things further than
2.5 m away, one solar panel. Lost windows: ones in the shadow of a neighbouring chimney
or dormer, and one pane of a pair now and then.

## What changed in the detector

For every patch, from the mesh's height over IPR's roof plane round it:

- the patch itself must lie within 1.2 m of the plane (`WINDOW_PLANE`);
- a dark patch with something standing more than 0.55 m above it within 2.5 m towards
  the sun is that thing's shadow (`WINDOW_SHADOW`, `WINDOW_SUNWARD`);
- a dark patch on a coloured roof (clay tiles) must be greyer than the roof: a shadow
  keeps the tiles' colour, glass doesn't (`WINDOW_GREYER`);
- a bright patch with something more than 0.9 m above it beside it or sunward is a
  chimney's or a dormer's lit side (`WINDOW_BESIDE`);
- the patch must fill 55 % of its rectangle, not 50 % (`WINDOW_FILL`).

The thresholds were picked on these same roofs, so the 32 % is a little flattering; a
fresh sample would say how much.

## Per roof

Roof: the tile and the end of the building's id. T: windows, F: false.

| roof | place | before T | before F | after T | after F |
|---|---|---|---|---|---|
| 49_70 …50770 | Bubeneč | 1 | 3 | 0 | 2 |
| 49_70 …51172 | Bubeneč | 4 | 3 | 4 | 0 |
| 52_60 …92719 | Smíchov | 4 | 0 | 4 | 0 |
| 52_60 …93380 | Smíchov | 9 | 2 | 9 | 0 |
| 52_60 …93890 | Smíchov | 0 | 5 | 0 | 1 |
| 52_60 …93967 | Smíchov | 6 | 5 | 5 | 0 |
| 52_60 …94283 | Smíchov | 7 | 0 | 7 | 0 |
| 52_60 …94478 | Smíchov | 2 | 4 | 1 | 3 |
| 52_60 …95457 | Smíchov | 0 | 5 | 0 | 0 |
| 57_64 …79318 | Staré Město | 0 | 2 | 0 | 1 |
| 57_64 …79859 | Staré Město | 0 | 6 | 0 | 1 |
| 57_64 …79961 | Staré Město | 0 | 4 | 0 | 2 |
| 57_64 …81035 | Staré Město | 1 | 5 | 1 | 0 |
| 57_64 …81364 | Staré Město | 0 | 8 | 0 | 2 |
| 57_64 …81431 | Staré Město | 1 | 1 | 0 | 0 |
| 57_64 …82309 | Staré Město | 0 | 6 | 0 | 2 |
| 62_60 …100271 | Vinohrady | 17 | 3 | 15 | 0 |
| 62_60 …100582 | Vinohrady | 1 | 2 | 0 | 1 |
| 62_60 …100792 | Vinohrady | 1 | 5 | 1 | 3 |
| 62_60 …99152 | Vinohrady | 5 | 0 | 4 | 0 |
| 62_60 …101262 | Vinohrady | 0 | 1 | 0 | 0 |
| 62_60 …99623 | Vinohrady | 0 | 3 | 0 | 1 |
| 73_45 …163907 | Krč | 0 | 2 | 0 | 1 |
| 73_45 …164110 | Krč | 0 | 2 | 0 | 1 |
| 73_45 …164541 | Krč | 1 | 1 | 1 | 1 |
| 73_45 …165366 | Krč | 1 | 1 | 1 | 0 |
| 73_45 …165566 | Krč | 0 | 1 | 0 | 1 |
| 73_45 …165695 | Krč | 0 | 1 | 0 | 1 |
| 73_45 …166462 | Krč | 0 | 1 | 0 | 1 |
| **all** | | **61** | **82** | **53** | **25** |

Pictures: `before-81364.jpg`, `before-93967.jpg`, `before-100792.jpg` (the old finds, in
red, on three roofs with many false ones); `after-1.jpg`, `after-2.jpg`, `after-5.jpg`,
`after-7.jpg` (the new finds, in magenta, four roofs to a sheet).

The map doesn't have the new finds yet: they come with the next run of
`mesh_colours.py praha` (a night's run).
