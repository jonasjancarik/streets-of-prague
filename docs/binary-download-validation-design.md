# Required tile binary validation

read_when: extending ae1a49f's required-download checks or reviewing successful-but-corrupt tile fetches.

The approved follow-up is implemented in `src/tileBinary.ts`, called by
`TileWorld.fetchTile` before its files promise fulfills. It extends the missing-file
checks from `ae1a49f` without changing optional `fetchBinary` consumers or decoder
formats. The original diagnosis below was based on `376a71d` and the reader/writer
contracts: `ae1a49f` rejected missing buffers but accepted an empty `ArrayBuffer`
because it is truthy.

## Reproduction and cache effect

Mocking `fetch` as `new Response(null, { status: 204 })`, then calling the real
`fetchBinary('mock-levels.bin.gz', true)` and `decodeLevels(buffer, 2, 1, 180)`, returned:

```json
{"status":204,"decodedBytes":0,"levels":1,"samples":4,"allNaN":true}
```

`fetchBinary` checks HTTP success and the three-byte gzip prefix, then returns the
body. A 204 response has no prefix and returns its zero-byte body. `decodeLevels`
constructs an empty `Uint16Array`; every out-of-range read is undefined, so its
truthiness test writes NaN. Even-length short files similarly hide missing grids or
samples, and surplus samples are ignored. This is different from height decoding,
whose explicit `n*n` typed-array view rejects a buffer shorter than the height grid.

Without validation, the successful `files` promise remains in `pending`, and tile
construction can publish invisible/missing level geometry. The new failure must
reject **before that promise fulfills**, so the existing identity-guarded failure
handler evicts only that active fetch and schedules its normal retry.

## Exact decoded layouts

Let `G = n*n`, where `n` comes from `index.terrain.n`; let `C` be the tile JSON's
`structures.length`. Validate `n` as an integer at least 2 and all derived sizes as
safe integers before allocating typed arrays. Do not infer the lattice from tile
width or step: the supported older 4 m grids stop short of a tile edge.

| Kind | Supported decoded layout | Proposed length/header check |
| --- | --- | --- |
| Height | `G` little-endian uint16 heights, decimetres above 100 m; current data appends `G` uint8 labels | Exactly `2*G` for the unlabelled layout or `3*G` for the labelled layout; no partial or extra label plane |
| Bare | Legacy `G` little-endian uint16 decimetre heights, used only for hill shading | Exactly `2*G`; this writer variant has no label plane or header |
| Levels | `C` consecutive grids of `G` little-endian uint16 centimetre heights; zero means off the level | Exactly `2*G*C`; a requested levels file needs an actual, nonempty structures array (`C > 0`) |
| IPR | 8-byte little-endian uint32 header: triangle count `T`, building count `B`; then `9*T` int16 coordinates, alignment padding, `3*T` RGB bytes, optionally `T` material bytes | Require at least 8 bytes before reading the header. Set `colAt = 4*Math.ceil((8 + 18*T)/4)`. Accept exactly `colAt + 3*T` or `colAt + 4*T`. Compare `T`/`B` with tile JSON triangle/building counts when those counts are supplied |

The IPR positions are **int16 centimetres**, not float32. Padding is before the RGB
plane, not at the end: one triangle has legacy/current lengths 31/32 bytes, two
triangles 50/52 bytes. These odd/even fixtures catch a common incorrect padding rule.
No terrain or IPR payload has a magic/version header of its own. A zero-triangle
IPR payload can be represented by the 8-byte header; do not forbid it universally,
but reject it when supplied metadata promises a positive triangle count.

The height proposal preserves `pointLabels`' explicit unlabelled compatibility.
Canonical format-2 output is `3*G`, but requiring labels for every accepted height
container would be an additional compatibility-policy change. A complete label
plane lost down to exactly `2*G` is indistinguishable from that unlabelled layout
without a per-file version expectation. The pre-format-2 water-high-bit encoding is
not a labelled variant and must not be reinterpreted as format 2; the existing
`main.ts` map-version gate already refuses actual format-1 maps.

Do not reject correctly sized all-zero heights/levels or demand finite decoded
level samples. Zero is a specified off-level sentinel. Length validation fixes the
204 reproduction without adding a new semantic policy about empty coverage.

## Required versus optional

Keep the existing advertisement rules rather than requiring every kind for every tile:

- Height only when the index announces terrain.
- Bare only when terrain's `bare` set lists the tile. New terrain writers remove
  these files; their ordinary absence remains valid.
- Levels only for an announced structures tile. An announcement with zero/missing
  JSON structures is inconsistent metadata, not permission to accept a zero-byte file.
- IPR only when the index flag, or the older index's JSON declaration, announces it;
  `osmBuildings` and an explicit false IPR index flag still suppress that fetch.
  Legacy JSON declarations without numerical counts can use the header and lengths
  alone. RGB-only IPR remains valid: material bytes are optional in the current reader.
- Metadata-absent files remain null and unrequested. The optional lamp download also
  uses `fetchBinary`; do not turn it into a required tile download accidentally.

The gzip prefix is `1f 8b 08`. Keep support for actual gzip **and** bodies already
decompressed by HTTP. Validate decoded bytes, not HTTP Content-Length or compressed
size. Existing decompression errors continue to reject truncated/bad gzip. HTTP 204,
empty 200 and partial/raw HTML successes fail the shape checks when their decoded
length/header is invalid. These checks do not prove integrity of a same-length
plausible binary; the build-time payload hashes are not currently in the runtime index.

## Implementation

The pure shape validator runs after the parallel JSON/binary downloads resolve and
before the `files` promise is returned as fulfilled. It receives kind, buffer and
the required metadata; it throws a diagnostic containing tile key, kind, expected
decoded length(s), actual length and URL. This leaves download concurrency, optional
`fetchBinary` consumers, worker ownership, retry counts and streaming policy unchanged.

Prefer that single validation point over changing `decodeLevels` to hide missing
bytes with defaults or adding a blanket all-NaN rejection. Existing guarded
`files.catch` behavior should handle malformed payloads exactly as it handles a
missing required download. Keep obsolete-request isolation and the normal startup
three-attempt limit intact. No map rebuild, GPU test or schema/version bump is needed.

## Focused regressions

`scripts/check-tile-fetch.mjs` extends the existing CPU harness with valid per-kind
payloads instead of reusing the same 8-byte recovery buffer for every kind:

1. Declare one structure at `n=2`. HTTP 204 and empty 200 levels responses must reject
   before the stub `make` runs, clear the active pending entry and schedule retry.
   A following valid 8-byte level grid must succeed. Also cover an even-length short
   grid, an odd-length body and an extra grid.
2. Height: accept valid 8-byte unlabelled and 12-byte labelled grids; reject a short
   prefix, partial label plane and surplus bytes. Bare: accept its valid 8-byte
   legacy grid and reject malformed advertised data.
3. IPR: accept the one- and two-triangle RGB-only/material variants listed above;
   reject a short header, mismatched JSON counts, truncated positions/RGB and a
   partial material tail. Preserve a zero-triangle fixture when metadata permits it.
4. Run valid and malformed decoded payloads as raw, genuine gzip and HTTP-decoded
   bodies at the `.gz` URL. A gzip stream that decompresses successfully into the
   wrong-sized payload must still reject.
5. Retain metadata-absent no-request/null behavior, optional lamp fallback,
   obsolete-request isolation, bounded startup retries and successful later recovery.
   The parking fetch refactor additionally requires `jsons: new Map()` in the
   prototype fixture, since `fetchJSON` is now shared with the parking halo.

Suggested valid `n=2` fixtures: 12-byte labelled height, 8-byte bare, one 8-byte
levels grid with some zero samples, and an IPR header `(T=1,B=1)` with 18 position
bytes, two padding bytes, three RGB bytes and optionally one material byte.

## Source evidence and sample audit

Readers: `src/terrain.ts` (`decodeHeights`, `pointLabels`, `decodeLevels`,
`fetchBinary`), `src/tileWorker.ts` (`ipr`), `src/tiles.ts` (`fetchTile`) and the
optional consumer in `src/lamps.ts`. Writers: `pipeline/ipr_terrain.py` encoding,
`pipeline/ipr_buildings.py` binary assembly and `pipeline/layers.py` metadata assembly.

History confirms the legacy boundaries: `41aefe8^` writes bare grids as `2*G` bytes;
`aaa3703^` writes RGB-only IPR and `aaa3703` adds the optional material bytes;
`e1d8d5b` changes the old top-bit water representation to the label plane and raises
the global map format to 2.

A read-only scan of the private `centrum` snapshot built `2026-10-02T20:16:12Z`
(`format=2`, `n=63`, `G=3969`) found 234 height files, all 11907 bytes; 89 levels
files, all exactly `7938*C` bytes; and 228 IPR files, all matching the material-bearing
length and both advertised header counts. No file-level all-zero levels payload or
zero-triangle IPR appeared in that sample. The implemented validator also passed
over those same 234/89/228 decoded files. This covers that snapshot, not all legacy
data. The focused fetch suite covers 21 corrupt successful response/recovery cases,
both HTTP failure and HTTP 204 startup retries, and stale corrupt-body isolation.
