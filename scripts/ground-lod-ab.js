// A coarser ground, for bench.mjs --ab: every drawn tile's ground layers built again by the
// tile workers with longer triangle edges (STREET_QUALITY.groundFine: 2 m at Medium and up,
// 4 m on Low and Lowest) and drawn instead of the tile's own while on. Set FINE (the coarser
// edge in metres), or SET (the STREET_QUALITY values to build with, as { groundFlat: 8 }),
// and optionally FAR (only tiles whose box is at least FAR metres from the eye; default 0,
// every tile) before the file. Building takes a while: --warmup 40.
//
//   node scripts/bench.mjs ... --warmup 40 --ab "const FINE = 8; $(cat scripts/ground-lod-ab.js)"
//
// window.__lodInfo: the triangles in the tiles' ground, theirs against the coarse ones.
// (Standing still: tiles that arrive later keep their own ground.)
window.__ab = (on) => {
  const D = __drive, W = D.world, far = typeof FAR === 'undefined' ? 0 : FAR;
  window.__lodOn = on;
  const url = (re) => performance.getEntriesByType('resource').map((e) => e.name).find((n) => re.test(n));
  const apply = (built) => {
    const p = D.camera.getWorldPosition(new built.THREE.Vector3()), x = p.x, y = -p.z;
    for (const { tile, coarse } of built.tiles) {
      const own = tile.drawn?.surfaces?.group;
      if (!own) continue;
      const [x0, y0, x1, y1] = tile.box;
      const use = window.__lodOn && Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)) >= far;
      for (const o of own.children) if (o !== coarse.group) o.visible = !use;
      coarse.group.visible = use;
    }
  };
  if (!window.__lod) {
    window.__lod = (async () => {
      const THREE = await import(url(/deps\/three_webgpu\.js\?/));
      const { Surfaces } = await import(url(/\/src\/surface\.ts/));
      const { STREET_QUALITY } = await import(url(/\/src\/streetQuality\.ts/));
      const { SKY_STEP } = await import(url(/\/src\/map\/skyView\.ts/));
      const tiles = [...W.loaded.values()].filter((t) => t.drawn?.surfaces);
      const set = typeof SET === 'undefined' ? { groundFine: FINE } : SET, keep = { ...STREET_QUALITY };
      Object.assign(STREET_QUALITY, set);
      let results;
      try { results = await Promise.all(tiles.map((t) => W.meshJobs(t.k, t.source))); } finally { Object.assign(STREET_QUALITY, keep); }
      const info = { tiles: tiles.length, theirs: 0, coarse: 0 };
      const built = { THREE, tiles: [] };
      tiles.forEach((tile, n) => {
        const [{ layers, triangles }] = results[n];
        const t = tile.source.t, [x0, y0, x1, y1] = t.box, side = Math.ceil(Math.max(x1 - x0, y1 - y0) / SKY_STEP) * SKY_STEP;
        const sky = W.sky.get(t.i * 65536 + t.j)?.texture ?? null, shade = tile.relief;
        // As Tiles.assemble does (RES there: 2 cells a metre).
        const masks = new Map();
        for (const m of tile.source.masks) {
          const texture = new THREE.DataTexture(m.cells, m.w, m.h, THREE.RedFormat, THREE.UnsignedByteType);
          texture.unpackAlignment = 1;
          texture.magFilter = texture.minFilter = THREE.LinearFilter;
          texture.needsUpdate = true;
          masks.set(m.level, { texture, box: [x0, y1, x0 + m.w / 2, y1 - m.h / 2] });
        }
        const coarse = new Surfaces(layers, { time: W.time, relief: shade ? { texture: shade.texture, box: shade.box, sky: sky ? { texture: sky, box: [x0, y0, x0 + side, y0 + side] } : null } : null, masks, photo: null });
        const own = tile.drawn.surfaces.group;
        own.add(coarse.group);
        coarse.group.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
        coarse.group.updateMatrixWorld(true);
        coarse.group.visible = false;
        info.theirs += tile.groundTriangles?.ground ?? 0;
        info.coarse += triangles?.ground ?? 0;
        built.tiles.push({ tile, coarse });
      });
      window.__lodInfo = info;
      return built;
    })();
  }
  window.__lod.then(apply);
};
