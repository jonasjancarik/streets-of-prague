---
read_when:
  - Changing Net.spread component selection or tunnel cover
  - Checking Mrázovka after the bridge harmonic propagation change
---

# Preserve supported tunnels with an unknown portal

The first combined harmonic map lost Mrázovka's tunnel level. Its source component
has six ways: three bridges and three tunnels. The southern portal at local
(-1364.87,-1792.61) lies outside the built centrum terrain, whose southern grid
starts at -1501.18 m. Its ground anchor is therefore NaN. The harmonic implementation
treated a component with any non-finite anchor as entirely unsupported, retaining
only two finite fixed heights. Tunnel cover could not operate on NaN interiors, and
`drop_shallow` removed all three tunnel ways. At 80% along the captured driving edge,
the actor followed ground at about 226.87 m ASL instead of the prior 199.4 m tunnel.
The adjoining bridge sampler at 95% also became NaN.

## Component selection

Harmonic propagation is now limited to components whose source ways are all bridges
and whose provided anchors are finite. Components containing a tunnel, or any
non-finite anchor, use the original two-nearest-anchor propagation for the whole
component. This preserves one model at shared bridge/tunnel nodes and keeps supported
interiors where the two nearer anchors are known. Unknown heights remain unknown.

Selection records every non-bridge way's membership when constructing `Net`, including
a short tunnel between existing bridge nodes with no exclusive intermediate node.
It does not depend on `node.kind`, which retains the first way's assignment. Selection
is local to each connected component; disconnected complete bridge components still
use the harmonic solve. Anchor validity is checked on each pass, without stale heights.

This changes no contact/grade rules, IPR face windows, cover depths, portal offsets,
shallow-tunnel threshold, crossing rules, smoothing, or level-group assignment. Sparse
harmonic validation still raises on invalid solves; it is not bypassed after failure.
No invalid portal height is discarded, invented or converted to a finite pin.

## Clean source reproduction

The initial diagnostic used finalized terrain and reproduced the lost tunnel. The
durable regression uses clean terrain instead. Cached bare IPR grids from the recorded
integration snapshot were read without modifying their cache; the `read_sheet`
implementation was verified identical. Survey correction was replayed over the
234-tile centrum lattice **before** structure solving, flat pads or bridge ground
pulls. Only six regional tiles, the six-way component and its actual IPR face cells
were retained in `pipeline/fixtures/mrazovka-clean-inputs.json` (159,075 bytes).
No map exports or integration files were written. Input hashes are recorded under
`docs/evidence/tunnel-propagation-compatibility`.

The old propagation, unconstrained harmonic propagation and correction were then
run on identical clean arrays and faces:

| Result | Old | Unconstrained harmonic | Corrected |
| --- | --- | --- | --- |
| Finite graph heights | 107 | 2 | 107 |
| Retained tunnel ways | 3 | 0 | 3 |
| Maximum supported depth | 36.885 m | 0 m | 36.885 m |
| Runtime-decoded tunnel at 80% | 199.3999996 m | Missing | 199.3999996 m |
| Runtime-decoded bridge at 95% | 204.0605848 m | NaN | 204.0605848 m |

Every corrected node height, including NaN positions, exactly matches the old model.
The two real-source regression tests fail under the unconstrained implementation and
pass with the correction. Python model/export tests and the actual TypeScript
`decodeLevels`/`heightSampler` confirm finite support at 80% and 95%. The supported
80% tunnel remains about 27.5 m below its clean ground height of 226.9 m ASL.

The 60% probe remains NaN in the old and corrected models. That is an existing partial
map/source limitation, not repaired by inventing a height. The 95% point is beyond the
tunnel source way and on its adjoining bridge; its profile must be tested through the
bridge payload rather than clamping the tunnel's final profile value. This local
model does not replace a rebuilt combined map or native actor replay. Those checks
remain required before restoring runtime acceptance.

## Bridge control and verification

The recorded Radotín control contains 26 bridge ways and 1,016 nodes. Both its
18-anchor and 692-anchor propagation passes retain bit-identical heights and nearest
distances compared with the accepted harmonic trace. The proven bridge continuity
gain is preserved. A separate synthetic check confirms that a disconnected tunnel
does not alter a complete bridge component.

Five new selection/unknown-anchor checks and two real-component/export regressions
join the existing structure tests: 32 focused checks pass. The short-tunnel check
explicitly asserts that all stored node kinds can be bridge while the source tunnel
still selects compatibility propagation. No full-city build or new GPU session was
run. The clean-input reconstruction used the shared heavy-job lock and released it
after completion.

```sh
PYTHONPATH="$PWD/pipeline" UV_CACHE_DIR=/tmp/streets-terrain-uv \
  uv run --project pipeline --offline --no-sync python -m unittest \
  test_structure_heights test_structure_contacts test_tunnel_regression -v
PYTHONPATH="$PWD/pipeline" UV_CACHE_DIR=/tmp/streets-terrain-uv \
  uv run --project pipeline --offline --no-sync python pipeline/test_tunnel_regression.py \
  --runtime-payload /tmp/mrazovka-runtime-payload.json
node scripts/check-tunnel-profile.mjs /tmp/mrazovka-runtime-payload.json
```
