// The best occlusion culling could do in one view: builds the hidden set with
// scripts/hidden-draws.js and defines window.__ab(on), which leaves those draws out of
// the main pass (on) or puts them back (off), for `bench.mjs --ab`. They stay in the
// sun's shadow pass, as with real culling: they go to the layer only the shadow camera
// sees (CAST_LAYER in src/figures.ts). Written out with ARGS by cull-ab.sh:
//
//   node scripts/bench.mjs --android <serial> --scenes stand --view first \
//     --eval "$(scripts/cull-ab.sh '{ scale: 0.5 }')" --ab "0"
//
// The set is the one hidden when timing begins; things that come into view later (a
// tile that loads, people walking out of the way) aren't followed.
const set = window.__hiddenDraws;
const masks = new Map(set.map((o) => [o, o.layers.mask]));
window.__ab = (on) => { for (const o of set) o.layers.mask = on ? 1 << 5 : masks.get(o); };
