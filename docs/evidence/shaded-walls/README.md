# Walls seen only in shade: does the ground's light give their colour back?

7 October 2026, plan 005. No. A wall's colour guessed from its shaded side, with or
without the ground's light as a calibration, is no closer to the wall's real colour
than another building's colour is, and much further than a neighbour's.

## The idea

In the photographs of the photo mesh the sun is low in the east-south-east, so more
than half of the city's buildings show their street walls only in shade (41 % of this
sample are measured in the sun, the same as the city's 42 %). Shade isn't equally dark
everywhere: a deep courtyard gets far less light than a wide street. Streets and yards
are much the same greys everywhere, so how dark the shaded ground beside a building is,
against the sunlit ground of the same tile, should say how much light its shaded walls
get. `ground_light` in `pipeline/mesh_colours.py` (as it was at commit `d1c063f`)
measured that: the mesh from above where no IPR roof is and nothing stands (within 0.8 m
of the lowest thing 12 m around), split into sun and shade by the same shadow test the
walls use, as medians of linear RGB over the tile and within 8 m of each building.

## The sample

`shade_sample.py` (run from `pipeline/`): 40 tiles of `praha`, every third tile of a
6 × 3.5 km piece from Břevnov to Žižkov and from Holešovice to Nusle, from the cached
mesh; 14 minutes. 2,237 buildings with wall samples; 916 with walls sure in the sun,
517 sure only in the shade, and **604 seen both ways**: the test set. 602 of them have
shaded ground beside them and sunlit ground to compare.

## The test

`shade_fit.py shade.pkl`: for each of the 602, the wall's colour in the sun is guessed
from its shaded side and compared with the colour measured in the sun (ΔE in CIELAB;
median, quartiles). Fitted numbers come from the other tiles (five folds by tile).

| guess | ΔE median | quartiles |
|---|---|---|
| A. the citywide rule there already (`from_shade`: brightness by rank, the sky's tint out) | 15.7 | 10.0-23.7 |
| B. shade × sunlit ground / shaded ground × a fitted factor, per channel | 32.7 | 19.7-53.3 |
| C. brightness fitted on the wall's own darkness and the ground's ratio, hue from the shade | 14.0 | 9.1-21.4 |
| D. the same fit without the ground | 14.2 | 9.1-21.9 |
| another building's colour | 14.1 | 8.1-22.9 |
| the sample's median wall colour | 8.5 | 5.2-14.5 |

On the 431 of them that have a measured neighbour sharing a wall:

| guess | ΔE median |
|---|---|
| the neighbour's colour (what the map does now) | 8.2 |
| C | 13.9 |
| another building's colour | 13.1 |

Lightness and colour apart (median |ΔL*| and median distance in a*, b*): C 6.7 and 9.2,
the neighbour 5.7 and 3.8.

## Why

- The ground's ratio hardly says anything about the wall's: the two correlate at 0.12,
  and the fit gives it a weight of 0.035. Ground isn't one grey (asphalt, setts, lawns,
  cars' shadows), and what lights a shaded wall is mostly the houses opposite, not the
  sky the ground sees.
- The shaded side holds little of the wall's colour to begin with. Shadows in these
  photographs are nearly black (a twentieth of the brightness in the sun), and what is
  left after the photographs' compression is mostly the sky's blue: the hue guessed
  from it is off by 9 in a*, b*, where a neighbour's is off by 4.
- Plaster in Prague varies less than the guess errs: the plain median wall (8.5) beats
  every guess from the shade.

## What follows

- Shaded walls aren't corrected; `ground_light` is taken out of `mesh_colours.py`
  again (it cost time in every tile and nothing used it). No citywide run for this.
- A wall not measured in the sun takes a measured neighbour's colour where it shares a
  wall with one (ΔE 8.2 here, 7.2 in `centrum`), as the map does since 6 October.
- Left open: buildings with neither (28 % in `centrum`) still take the game's palette.
  The area's median wall colour would be closer on average (8.5 against about 14), but
  it would paint whole districts one colour; not done.
