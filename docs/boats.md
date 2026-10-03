# Boat lights and bank access

Read when changing boat models, mooring, boarding, or river travel.

Cruise boats have warm cabin windows and red, green and white navigation lamps.
Pedal and swan boats carry a small white lamp. Their geometry is merged into each
boat's body and the existing `glow` attribute uses the street lamps' night switch
on WebGPU and WebGL. These lamps add no light objects, shadow maps or draw calls.
They make the lamps themselves visible; they do not illuminate the river around them.

A player can board within 4.5 metres of a boat's centre from dry walkable ground
within 0.8 metres of its deck, 0.4 metres above the sampled water. A path sampled
every 0.25 metres must reach the bank without crossing a wall, railing, unloaded
ground or a second stretch of water. Each dry route sample checks the walker's
0.3 m footprint and bank height, preventing access through a narrow corridor.
Only the first 0.3 m of that dry route may overlap water while stepping across
the shoreline; dry parts still need clearance. The player must fit on the bank, and the
player's current height is checked to prevent boarding from a bridge above.

Moored boats spawn only beside such a bank with a metre of clear ground on its
four sides, leaving room to stand and turn. Passing boats cannot displace them.
Placement attempts take turns, so a boat waiting for a suitable bank cannot block
the rest of the fleet. Exiting searches for the same safe landing, then puts the
walker on the ground level. A high quay without low access remains inaccessible.

Run `node scripts/check-boat-access.mjs` for CPU regressions covering low banks,
high quays and decks, walls, railings, water, unloaded ground, unchanged reach,
stable moorings and placement fairness. With the scene server running, run
`node scripts/scene.mjs run boat-boarding --port <scene-port>` to board and exit
all three moored boats through the ordinary game interaction.

The local WebGPU check on 3 October 2026 used source based on `b3c22d5` and a
private APFS copy of centrum data built `2026-10-02T20:16:12Z`, pipeline
`934283de3e`. Day/night views confirmed pedal and cruise lamps. A controlled
northbound pedal route at longitude 14.411 passed beneath Legion Bridge: sampled
water height 5.53–5.80 m, boat roof 7.64–7.94 m and bridge deck 15.58–15.64 m
above the world's reference height. This verifies that route, not every bridge.
Water-height variation in the existing map remains a terrain limitation. No
phone, frame-time benchmark, citywide rebuild or ferry implementation was included.
