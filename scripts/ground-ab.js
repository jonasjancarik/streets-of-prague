// What the ground's layers cost the GPU, part by part: an --ab switch for bench.mjs that swaps
// the materials of every drawn tile's ground layers (src/surface.ts, the WebGPU node materials
// of src/webgpu.ts) for a cheaper variant. MODE is the variant while on; OFF (default
// 'original', the game's own) the one while off. Set them before the file:
//
//   node scripts/bench.mjs ... --ab "const MODE = 'flat'; $(cat scripts/ground-ab.js)"
//   node scripts/bench.mjs ... --ab "const MODE = 'merged', OFF = 'basic'; $(cat scripts/ground-ab.js)"
//
// MODE: hide (no ground layers at all), basic (an unlit flat colour: what drawing the layers
// costs before any shading), flat (lit, but no pattern, lamp light, mirror, normal or sky
// darkening), noemissive (no lamp light or wet mirror), nonormal (no surface normals), noshadow
// (no sun's shadow on the ground), noao (no darkening where less of the sky is seen), nocolor
// (the plain layer colour: no pattern, hill shading, weathering or wet), nopattern
// (userData.flatten(): the pattern alone).
// To tell the number of draws from the pixels they cover: collapse (basic, but every vertex
// moved to one point: the same draws and vertices, no pixels), merged (the layers of every
// tile as one unlit mesh: the same pixels, one draw, no stencil).
// The ground's depth-only meshes and the soft shading stay as they are.
// (Standing still: tiles that arrive during the run keep their own materials.)
window.__ab = async (on) => {
  const D = __drive;
  const off = typeof OFF === 'undefined' ? 'original' : OFF;
  const url = (re) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => re.test(n));
  if (!window.__groundAb) {
    const W = await import(url(/deps\/three_webgpu\.js\?/));
    const TSL = await import(url(/deps\/three_tsl\.js\?/));
    window.__groundAb = { W, TSL, kept: new Map(), merged: null };
  }
  const G = window.__groundAb, { W, TSL, kept } = G;
  const layers = [];
  for (const tile of D.world.loaded.values()) {
    const g = tile.drawn?.surfaces?.group;
    if (!g) continue;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const m = kept.has(o) ? kept.get(o).original : o.material;
      if (m?.userData?.flatten) layers.push(o);
    });
  }
  const basic = (m) => {
    const b = new W.MeshBasicNodeMaterial({ color: m.color });
    for (const k of ['side', 'depthWrite', 'depthTest', 'transparent', 'opacity', 'blending', 'stencilWrite', 'stencilRef', 'stencilFunc', 'stencilZPass', 'stencilWriteMask', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits']) b[k] = m[k];
    return b;
  };
  const variant = (m, mode) => {
    if (mode === 'nopattern') return m.userData.flatten();
    if (mode === 'basic') return basic(m);
    if (mode === 'collapse') { const b = basic(m); b.positionNode = TSL.vec3(0, 0, 0); return b; }
    // clone() leaves out the tile textures the graph reads from the material (src/webgpu.ts).
    const f = m.clone();
    for (const k of ['raster', 'relief', 'sky', 'mask', 'photo']) { f[k + 'Map'] = m[k + 'Map']; f[k + 'Box'] = m[k + 'Box']; }
    if (mode === 'flat') Object.assign(f, { colorNode: TSL.vec4(TSL.materialColor, 1), emissiveNode: null, normalNode: null, aoNode: null });
    if (mode === 'noemissive') f.emissiveNode = null;
    if (mode === 'nonormal') f.normalNode = null;
    if (mode === 'noao') f.aoNode = null;
    if (mode === 'nocolor') f.colorNode = TSL.vec4(TSL.materialColor, 1);
    return f;
  };
  // Every layer's triangles in world space, in one mesh drawn before the rest of the ground.
  const merge = () => {
    let nv = 0, ni = 0;
    for (const o of layers) { nv += o.geometry.attributes.position.count; ni += o.geometry.index.count; }
    const pos = new Float32Array(nv * 3), idx = new Uint32Array(ni), v = new W.Vector3();
    let pv = 0, pi = 0;
    for (const o of layers) {
      o.updateWorldMatrix(true, false);
      const p = o.geometry.attributes.position, ix = o.geometry.index.array;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pos[(pv + i) * 3] = v.x; pos[(pv + i) * 3 + 1] = v.y; pos[(pv + i) * 3 + 2] = v.z; }
      for (let i = 0; i < ix.length; i++) idx[pi + i] = ix[i] + pv;
      pv += p.count; pi += ix.length;
    }
    const g = new W.BufferGeometry();
    g.setAttribute('position', new W.BufferAttribute(pos, 3));
    g.setIndex(new W.BufferAttribute(idx, 1));
    const mesh = new W.Mesh(g, new W.MeshBasicNodeMaterial({ color: 0x8a8378, side: W.DoubleSide, depthWrite: false }));
    mesh.renderOrder = -2000;
    mesh.frustumCulled = false;
    D.scene.add(mesh);
    return mesh;
  };
  const mode = on ? MODE : off;
  if (mode === 'merged' && !G.merged) G.merged = merge();
  if (G.merged) G.merged.visible = mode === 'merged';
  for (const o of layers) {
    let k = kept.get(o);
    if (!k) kept.set(o, (k = { original: o.material, shadow: o.receiveShadow, variants: new Map() }));
    o.visible = mode !== 'hide' && mode !== 'merged';
    o.receiveShadow = mode === 'noshadow' ? false : k.shadow;
    if (mode === 'original' || mode === 'hide' || mode === 'merged' || mode === 'noshadow') { o.material = k.original; continue; }
    if (!k.variants.has(mode)) k.variants.set(mode, variant(k.original, mode));
    o.material = k.variants.get(mode);
  }
  return layers.length;
};
