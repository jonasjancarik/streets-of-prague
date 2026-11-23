// What the ground's layers cost the GPU, part by part: an --ab switch for bench.mjs that swaps
// the materials of every drawn tile's ground layers (src/surface.ts, the WebGPU node materials
// of src/webgpu.ts) for a cheaper variant, with on = the variant. Set MODE before the file:
//
//   node scripts/bench.mjs ... --ab "const MODE = 'flat'; $(cat scripts/ground-ab.js)"
//
// MODE: hide (no ground layers at all), basic (an unlit flat colour: what drawing the layers
// costs before any shading), flat (lit, but no pattern, lamp light, mirror, normal or sky
// darkening), noemissive (no lamp light or wet mirror), nonormal (no surface normals), noshadow
// (no sun's shadow on the ground), nopattern (userData.flatten(): the pattern alone).
// The ground's depth-only meshes and the soft shading stay as they are.
// (Standing still: tiles that arrive during the run keep their own materials.)
window.__ab = async (on) => {
  const D = __drive;
  const url = (re) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => re.test(n));
  if (!window.__groundAb) {
    const W = await import(url(/deps\/three_webgpu\.js\?/));
    const TSL = await import(url(/deps\/three_tsl\.js\?/));
    window.__groundAb = { W, TSL, variants: new Map(), shadows: new Map() };
  }
  const { W, TSL, variants, shadows } = window.__groundAb;
  const layers = [];
  for (const tile of D.world.loaded.values()) {
    const g = tile.drawn?.surfaces?.group;
    if (!g) continue;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const m = variants.has(o) ? variants.get(o).original : o.material;
      if (m?.userData?.flatten) layers.push(o);
    });
  }
  const variant = (o, m) => {
    if (MODE === 'nopattern') return m.userData.flatten();
    if (MODE === 'basic') {
      const b = new W.MeshBasicNodeMaterial({ color: m.color });
      for (const k of ['side', 'depthWrite', 'depthTest', 'transparent', 'opacity', 'blending', 'stencilWrite', 'stencilRef', 'stencilFunc', 'stencilZPass', 'stencilWriteMask', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits']) b[k] = m[k];
      return b;
    }
    const f = m.clone();
    if (MODE === 'flat') Object.assign(f, { colorNode: TSL.vec4(TSL.materialColor, 1), emissiveNode: null, normalNode: null, aoNode: null });
    if (MODE === 'noemissive') f.emissiveNode = null;
    if (MODE === 'nonormal') f.normalNode = null;
    return f;
  };
  for (const o of layers) {
    if (MODE === 'hide') { o.visible = !on; continue; }
    if (MODE === 'noshadow') {
      if (!shadows.has(o)) shadows.set(o, o.receiveShadow);
      o.receiveShadow = on ? false : shadows.get(o);
      continue;
    }
    let v = variants.get(o);
    if (!v) variants.set(o, (v = { original: o.material, cheap: variant(o, o.material) }));
    o.material = on ? v.cheap : v.original;
  }
  return layers.length;
};
