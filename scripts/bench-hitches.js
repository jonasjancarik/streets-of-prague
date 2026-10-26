// Hitch attribution for scripts/bench.mjs --hitches: evaluated in the page as soon as
// the loading screen is gone, before the player gets into the car, so first-use work on
// the drive is recorded rather than warmed away. One record per frame (the outermost
// render of the game's scene), kept apart by kind of work:
//   node graph builds (TSL → WGSL on the main thread; `re` = a cache key built before
//     and since evicted), three.js pipeline and shader-program creation and release,
//     time inside the device's createRenderPipeline / createShaderModule calls,
//   queue submits and writeBuffer (time in the calls: the GPU process falling behind
//     shows here), new and destroyed buffers and textures,
//   the world's updates (traffic, crowd, trams, lamps, tiles),
//   tile work: built (make), drawn (assemble, whose `meshes` lap is main-thread
//     insertion), undressed and dropped.
// Long animation frames (PerformanceObserver 'long-animation-frame') add the scripts
// that ran between the game's frames: worker replies and promise continuations.
// Tile arrival: when each tile was first wanted drawn and when it was. window.__hitches
// holds it all; bench.mjs dumps it with --raw and scripts/hitch-report.mjs reads that.
(() => {
  const d = window.__drive, w = d.world, r = d.renderer, dev = r.backend?.device ?? null, b = window.__bench;
  const now = () => performance.now();
  const blank = () => ({
    builds: 0, buildMs: 0, rebuilds: 0, kinds: null, evicted: 0,
    asyncBuilds: 0, asyncBuildsDone: 0, asyncPipes: 0, asyncPipesDone: 0, pipeKinds: null,
    pipes: 0, pipeRe: 0, pipeFree: 0, progs: 0, progFree: 0, pipeCallMs: 0, shaderCallMs: 0, modules: 0,
    submits: 0, submitMs: 0, wb: 0, wbN: 0, wbMs: 0, wbMax: 0, bufs: 0, bufBytes: 0, bufFree: 0, tex: 0, texFree: 0,
    traffic: 0, crowd: 0, trams: 0, lamps: 0, world: 0,
    made: null, drawn: null, undress: 0, undressN: 0, drop: 0, dropN: 0,
  });
  const H = { t0: now(), frames: [], loaf: [], marks: [], tiles: {}, acc: blank(), loafSupported: false };
  H.mark = (name) => H.marks.push({ name, t: now() });

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) H.loaf.push({
        s: e.startTime, d: e.duration, block: e.blockingDuration, render: e.renderStart, style: e.styleAndLayoutStart,
        scripts: (e.scripts || []).map((s) => ({ inv: s.invokerType, by: s.invoker, fn: s.sourceFunctionName, url: (s.sourceURL || '').split('/').pop().split('?')[0], s: s.startTime, d: s.duration, exec: s.executionStart })),
      });
    }).observe({ type: 'long-animation-frame', buffered: false });
    H.loafSupported = true;
  } catch {}

  const per = (obj, key, field) => {
    const f = obj?.[key];
    if (typeof f !== 'function') return;
    obj[key] = function (...a) {
      const t = now();
      try { return f.apply(this, a); } finally { H.acc[field] += now() - t; }
    };
  };
  per(d.traffic, 'update', 'traffic');
  per(d.crowd, 'update', 'crowd');
  per(d.trams, 'update', 'trams');
  per(d.lamps, 'update', 'lamps');

  // Tiles: when each was first wanted drawn, built and drawn (arrival latency).
  const tile = (k) => (H.tiles[k] ||= { wanted: null, made: null, drawn: [], undressed: [], dropped: [] });
  const update = w.update;
  w.update = function (...a) {
    const t = now();
    try { return update.apply(this, a); } finally {
      const e = now();
      H.acc.world += e - t;
      for (const k of this.shown) { const x = tile(k); if (x.wanted === null && !this.loaded.get(k)?.drawn) x.wanted = e; }
    }
  };
  const make = w.make;
  w.make = async function (k, ...rest) {
    const s = now();
    const out = await make.call(this, k, ...rest);
    const e = now();
    tile(k).made = { s, e, ms: out.ms };
    (H.acc.made ||= []).push({ k, ms: out.ms });
    return out;
  };
  const assemble = w.assemble;
  w.assemble = async function (t, ...rest) {
    const s = now();
    await assemble.call(this, t, ...rest);
    const e = now();
    if (t.drawn) {
      tile(t.k).drawn.push({ s, e, wanted: tile(t.k).wanted, ms: t.drawMs });
      (H.acc.drawn ||= []).push({ k: t.k, ms: t.drawMs, visit: tile(t.k).drawn.length });
    }
  };
  const undress = w.undress;
  w.undress = function (t) {
    const had = !!t.drawn, s = now();
    try { return undress.call(this, t); } finally {
      if (had) { H.acc.undress += now() - s; H.acc.undressN++; tile(t.k).undressed.push(now()); }
      tile(t.k).wanted = null;
    }
  };
  const drop = w.drop;
  w.drop = function (k) {
    const had = this.loaded.has(k), s = now();
    try { return drop.call(this, k); } finally {
      if (had) { H.acc.drop += now() - s; H.acc.dropN++; tile(k).dropped.push(now()); }
    }
  };

  // Node graph builds: a new entry in three.js's node-builder cache. three.js drops an
  // entry once no render object uses it, so a key seen before is a rebuild.
  const nodes = r._nodes, cache = nodes?.nodeBuilderCache, seenKeys = new Set(), evictedKeys = new Set();
  if (cache) {
    const get = nodes.getForRender.bind(nodes);
    nodes.getForRender = (ro, useAsync) => {
      const before = cache.size, t = now();
      const out = get(ro, useAsync);
      // (compileAsync's builds yield between steps and finish later: counted apart.)
      if (out && typeof out.then === 'function') {
        H.acc.asyncBuilds++;
        out.then(() => { H.acc.asyncBuildsDone++; }, () => {});
      } else if (cache.size > before) {
        const dt = now() - t, o = ro.object, key = nodes.getForRenderCacheKey(ro), a = H.acc;
        const re = seenKeys.has(key) || evictedKeys.has(key);
        seenKeys.add(key);
        a.builds++; a.buildMs += dt; if (re) a.rebuilds++;
        const kind = `${ro.material.type}${ro.material.userData?.flatten ? ' ground' : ''}${o.isInstancedMesh ? ' instanced' : ''}${o.name ? ` ${o.name}` : ''} [${Object.keys(ro.geometry.attributes).join(',')}]${ro.context?.depth && !ro.context.textures?.length ? ' depth-only' : ''}`;
        (a.kinds ||= []).push({ kind, ms: Math.round(dt * 10) / 10, re });
      }
      return out;
    };
    const del = cache.delete.bind(cache);
    cache.delete = (k) => { H.acc.evicted++; evictedKeys.add(k); return del(k); };
  }
  const pipes = r._pipelines;
  if (pipes) {
    const seenPipes = new Set();
    const set = pipes.caches.set.bind(pipes.caches);
    pipes.caches.set = (k, v) => { H.acc.pipes++; if (seenPipes.has(k)) H.acc.pipeRe++; seenPipes.add(k); return set(k, v); };
    const getPipe = pipes.getForRender.bind(pipes);
    pipes.getForRender = (ro, promises) => {
      const before = pipes.caches.size;
      const out = getPipe(ro, promises);
      if (pipes.caches.size > before) (H.acc.pipeKinds ||= []).push(`${ro.material.type}${ro.object.isInstancedMesh ? ' instanced' : ''}${ro.object.name ? ` ${ro.object.name}` : ''}${ro.context?.depth && !ro.context.textures?.length ? ' depth-only' : ''}${promises ? ' (compileAsync)' : ''}`);
      return out;
    };
    const rel = pipes._releasePipeline.bind(pipes);
    pipes._releasePipeline = (p) => { H.acc.pipeFree++; return rel(p); };
    const relProg = pipes._releaseProgram.bind(pipes);
    pipes._releaseProgram = (p) => { H.acc.progFree++; return relProg(p); };
    for (const stage of ['vertex', 'fragment']) {
      const m = pipes.programs[stage], s = m.set.bind(m);
      m.set = (k, v) => { H.acc.progs++; return s(k, v); };
    }
  }
  if (dev) {
    const timedCall = (obj, key, field, count) => {
      const f = obj[key]?.bind(obj);
      if (!f) return;
      obj[key] = (...a) => { const t = now(); try { return f(...a); } finally { H.acc[field] += now() - t; if (count) H.acc[count]++; } };
    };
    timedCall(dev, 'createRenderPipeline', 'pipeCallMs');
    const cra = dev.createRenderPipelineAsync?.bind(dev);
    if (cra) dev.createRenderPipelineAsync = (desc) => {
      const t = now();
      H.acc.asyncPipes++;
      const p = cra(desc);
      H.acc.pipeCallMs += now() - t;
      p.then(() => { H.acc.asyncPipesDone++; }, () => {});
      return p;
    };
    timedCall(dev, 'createShaderModule', 'shaderCallMs', 'modules');
    const q = dev.queue;
    timedCall(q, 'submit', 'submitMs', 'submits');
    const wb = q.writeBuffer.bind(q);
    q.writeBuffer = (buf, o, data, off, size) => {
      const t = now();
      try { return wb(buf, o, data, off, size); } finally {
        const dt = now() - t, a = H.acc;
        a.wbN++; a.wbMs += dt; if (dt > a.wbMax) a.wbMax = dt;
        a.wb += size !== undefined ? size * (data.BYTES_PER_ELEMENT || 1) : data.byteLength - (off ?? 0) * (data.BYTES_PER_ELEMENT || 1);
      }
    };
    const cb = dev.createBuffer.bind(dev);
    dev.createBuffer = (desc) => { H.acc.bufs++; H.acc.bufBytes += desc.size; return cb(desc); };
    const ct = dev.createTexture.bind(dev);
    dev.createTexture = (desc) => { H.acc.tex++; return ct(desc); };
    const bd = GPUBuffer.prototype.destroy;
    GPUBuffer.prototype.destroy = function () { H.acc.bufFree++; return bd.call(this); };
    const td = GPUTexture.prototype.destroy;
    GPUTexture.prototype.destroy = function () { H.acc.texFree++; return td.call(this); };
  }

  // A frame ends with the outermost render of the game's scene (three.js renders the
  // shadow maps, and the lamps their light map, from inside or beside it).
  const render = r.render.bind(r);
  let depth = 0, renderMs = 0, renderStart = null;
  r.render = (s, c) => {
    if (depth) return render(s, c);
    depth++;
    const t = now();
    renderStart ??= t;
    try { return render(s, c); } finally {
      depth--;
      const e = now();
      renderMs += e - t;
      if (s === d.scene) {
        const car = d.car, cb = b?.cb;
        const f = H.acc;
        f.t = cb?.t ?? null; f.start = cb?.t0 ?? null; f.end = e; f.render = renderMs; f.pre = cb ? renderStart - cb.t0 : null;
        f.x = car ? Math.round(car.x) : null; f.y = car ? Math.round(car.y) : null; f.kmh = car ? Math.round(car.speed * 3.6) : null;
        f.drawnHere = car ? !!w.tileAt(car.x, car.y)?.drawn : null;
        H.frames.push(f);
        H.acc = blank();
        renderMs = 0; renderStart = null;
      }
    }
  };

  H.dump = () => ({ t0: H.t0, frames: H.frames, loaf: H.loaf, marks: H.marks, tiles: H.tiles, loafSupported: H.loafSupported,
    trees: w.trees?.stats?.() ?? null, cacheSize: cache?.size ?? null, pipelines: pipes?.caches.size ?? null });
  window.__hitches = H;
})();
