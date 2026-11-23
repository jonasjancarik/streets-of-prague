// What mipmaps on the ground's tile textures would save, for bench.mjs --ab: while on, the
// textures the ground's layers read per tile (WHICH, default all four: 'sky', 'relief',
// 'raster', 'mask'; src/webgpu.ts tileTexture) get mipmaps and trilinear filtering; while
// off, the game's own single level with linear filtering. Each switch uploads the textures
// again, so give it --window 5 --warmup 10. Tiles that arrive during the run keep the game's.
//
//   node scripts/bench.mjs ... --window 5 --warmup 10 --ab "const WHICH = ['sky']; $(cat scripts/mip-ab.js)"
window.__ab = (on) => {
  const D = __drive, which = typeof WHICH === 'undefined' ? ['sky', 'relief', 'raster', 'mask'] : WHICH;
  const textures = new Set();
  for (const tile of D.world.loaded.values()) {
    tile.drawn?.surfaces?.group?.traverse((o) => {
      const m = o.material;
      if (!o.isMesh || !m) return;
      for (const k of which) if (m[k + 'Map']?.isDataTexture) textures.add(m[k + 'Map']);
    });
  }
  // (LinearFilter 1006, LinearMipmapLinearFilter 1008.)
  for (const t of textures) {
    t.userData.mipAb ??= { min: t.minFilter, gen: t.generateMipmaps };
    const want = on ? 1008 : t.userData.mipAb.min, gen = on ? true : t.userData.mipAb.gen;
    if (t.minFilter === want && t.generateMipmaps === gen) continue;
    t.minFilter = want;
    t.generateMipmaps = gen;
    t.needsUpdate = true;
  }
  return textures.size;
};
