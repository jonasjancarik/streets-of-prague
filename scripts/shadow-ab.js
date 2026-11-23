// What the sun's shadow filter costs, for bench.mjs --ab: while on, the sun's shadow is read
// with FILTER instead of three.js's PCF (5 reads a pixel, src/graphics.ts sets it):
// 'basic' (one hardware-filtered read). Every lit material is built again on each switch,
// as Graphics.apply does when the filter changes, so give it --window 5 --warmup 10.
//
//   node scripts/bench.mjs ... --window 5 --warmup 10 --ab "const FILTER = 'basic'; $(cat scripts/shadow-ab.js)"
window.__ab = (on) => {
  const D = __drive, shadow = D.sky.sun.shadow;
  // three.js's filter from the game's own copy of three (src/softshadow.ts holds it), so the
  // nodes it builds belong to the same three.js as the materials.
  if (!window.__shadowAb) {
    window.__shadowAb = { own: shadow.filterNode ?? null, pending: import('/src/softshadow.ts').then((M) => { window.__shadowAb.filters = { basic: M.CHEAP_SHADOW_FILTER.value }; }) };
  }
  const S = window.__shadowAb;
  const apply = () => {
    const filter = on ? S.filters[FILTER] : S.own;
    if ((shadow.filterNode ?? null) === filter) return;
    shadow.filterNode = filter;
    const materials = new Set();
    D.sky.sun.parent?.traverse((o) => {
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => materials.add(x)); else if (m) materials.add(m);
    });
    for (const m of materials) m.dispose();
  };
  if (S.filters) apply(); else S.pending.then(apply);
};
