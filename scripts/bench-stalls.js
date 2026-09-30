// Stall attribution for scripts/bench.mjs --stalls: evaluated in the page just before
// timing. Records long tasks (PerformanceObserver 'longtask') and, per frame, what could
// cause them: three.js material builds (TSL → WGSL on the main thread), WebGPU pipelines,
// shader modules, buffers and uploads, tile builds (with their laps), the street-graph
// merge and the per-frame updates of the world. window.__stalls.report() returns the
// lines the bench prints. See "Stalls while driving" in the performance skill.
(() => {
  const d = window.__drive, w = d.world, r = d.renderer, dev = r.backend?.device ?? null;
  const fresh = () => ({ t: performance.now(), wb: 0, wbN: 0, ua: 0, pipes: 0, shaders: 0, bufs: 0, bufBytes: 0, builds: 0, buildMs: 0, carBuilds: 0, carBuildMs: 0, render: 0, e: 0 });
  const S = { long: [], calls: [], frames: [], tiles: [], kinds: new Map(), acc: fresh(), treesAtStart: w.trees?.stats() ?? null };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) S.long.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask' });

  // Calls that take at least `min` ms, with when they ran.
  const timed = (obj, key, name, min = 1) => {
    const f = obj?.[key];
    if (typeof f !== 'function') return;
    obj[key] = function (...a) {
      const t0 = performance.now();
      const out = f.apply(this, a);
      const t1 = performance.now();
      if (t1 - t0 >= min) S.calls.push({ n: name, s: t0, d: t1 - t0 });
      return out;
    };
  };
  timed(w.drive, 'add', 'drive.add');
  timed(w.walk, 'add', 'walk.add');
  timed(w, 'onEdges', 'onEdges');
  timed(w, 'onCars', 'onCars');
  timed(w, 'drop', 'drop');
  timed(w, 'update', 'world.update', 3);
  timed(d.traffic, 'update', 'traffic.update', 2);
  const spawnCalls = { n: 0, ms: 0, prepareN: 0, prepareMs: 0 };
  for (const [key, count, elapsed] of [['spawn', 'n', 'ms'], ['prepareSpawn', 'prepareN', 'prepareMs']]) {
    const original = d.traffic[key];
    d.traffic[key] = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); }
      finally { spawnCalls[count]++; spawnCalls[elapsed] += performance.now() - start; }
    };
  }
  const peopleStart = d.spawnWork && { ...d.spawnWork };
  timed(d.crowd, 'update', 'crowd.update', 2);
  timed(d.trams, 'update', 'trams.update', 2);
  timed(d.lamps, 'update', 'lamps.update', 2);
  timed(d.lamps, 'fill', 'lamps.fill');
  timed(d.crowd, 'index', 'crowd.index');
  // Tile builds: noted when each finishes, with its laps (tile.ms).
  const make = w.make;
  w.make = async function (k, files) {
    const s = performance.now();
    const tile = await make.call(this, k, files);
    S.tiles.push({ k, s, e: performance.now(), ms: tile.ms });
    return tile;
  };

  if (dev) {
    const q = dev.queue, wb = q.writeBuffer.bind(q);
    q.writeBuffer = (b, o, data, off, size) => { S.acc.wbN++; S.acc.wb += size ?? (data.byteLength - (off ?? 0) * (data.BYTES_PER_ELEMENT || 1)); return wb(b, o, data, off, size); };
    for (const [key, n] of [['createRenderPipeline', 'pipes'], ['createRenderPipelineAsync', 'pipes'], ['createShaderModule', 'shaders']]) {
      const f = dev[key]?.bind(dev);
      if (f) dev[key] = (...a) => { S.acc[n]++; return f(...a); };
    }
    const cb = dev.createBuffer.bind(dev);
    dev.createBuffer = (desc) => { S.acc.bufs++; S.acc.bufBytes += desc.size; return cb(desc); };
    const ua = r.backend.updateAttribute.bind(r.backend);
    r.backend.updateAttribute = (attr) => { S.acc.ua += (attr.isInterleavedBufferAttribute ? attr.data : attr).array.byteLength; return ua(attr); };
  }
  // Material builds: a new entry in three.js's node-builder cache, by kind of object.
  const nodes = r._nodes, cache = nodes?.nodeBuilderCache;
  if (cache) {
    const get = nodes.getForRender.bind(nodes);
    nodes.getForRender = (ro, useAsync) => {
      const before = cache.size, t0 = performance.now();
      const out = get(ro, useAsync);
      if (cache.size > before) {
        const dt = performance.now() - t0, o = ro.object;
        S.acc.builds++; S.acc.buildMs += dt;
        if (o.isInstancedMesh && o.material?.customProgramCacheKey?.() === 'cars') {
          S.acc.carBuilds++; S.acc.carBuildMs += dt;
        }
        const kind = `${ro.material.type}${ro.material.userData?.flatten ? ' ground' : ''}${o.isInstancedMesh ? ` instanced(${o.instanceMatrix.count})` : ''}${o.name ? ` ${o.name}` : ''} [${Object.keys(ro.geometry.attributes).join(',')}]`;
        const k = S.kinds.get(kind) || [0, 0];
        S.kinds.set(kind, [k[0] + 1, k[1] + dt]);
        if (dt >= 1) S.calls.push({ n: `build ${ro.material.type}`, s: t0, d: dt });
      }
      return out;
    };
  }
  // A frame: up to the end of the main scene's render. Only outermost renders are timed:
  // three.js renders the shadow maps from inside the main render. (Other renders in a
  // frame, such as the lamps' light map, count towards the frame's render time.)
  const render = r.render.bind(r);
  let depth = 0;
  r.render = (s, c) => {
    if (depth) return render(s, c);
    depth++;
    const t0 = performance.now();
    let o;
    try { o = render(s, c); } finally { depth--; }
    const t1 = performance.now();
    S.acc.render += t1 - t0;
    if (s === d.scene) {
      S.acc.e = t1;
      S.frames.push(S.acc);
      S.acc = fresh();
    }
    return o;
  };

  S.report = () => {
    const f1 = (x) => Math.round(x * 10) / 10, mb = (x) => (x / 1e6).toFixed(2);
    const sum = (fs, k) => fs.reduce((a, f) => a + f[k], 0);
    const gaps = S.frames.slice(1).map((f, i) => f.e - S.frames[i].e).sort((a, b) => a - b);
    const at = (p) => f1(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] ?? NaN);
    const lines = [`frames ${S.frames.length}: median ${at(0.5)}, 99th percentile ${at(0.99)}, slowest ${at(1)} ms; long tasks ${S.long.length} (${Math.round(S.long.reduce((a, l) => a + l.d, 0))} ms); tiles built ${S.tiles.length}`];
    lines.push(`material builds ${sum(S.frames, 'builds')} (${Math.round(sum(S.frames, 'buildMs'))} ms), pipelines ${sum(S.frames, 'pipes')}, shader modules ${sum(S.frames, 'shaders')}`);
    lines.push(`car-body builds ${sum(S.frames, 'carBuilds')} (${Math.round(sum(S.frames, 'carBuildMs'))} ms)`);
    if (S.treesAtStart) lines.push(`tree pages ${JSON.stringify(S.treesAtStart)} → ${JSON.stringify(w.trees.stats())}`);
    lines.push(`traffic spawn ${spawnCalls.n} calls (${f1(spawnCalls.ms)} ms), prepare ${spawnCalls.prepareN} lists (${f1(spawnCalls.prepareMs)} ms)`);
    if (peopleStart) {
      const p = d.spawnWork;
      lines.push(`people prepare ${p.peoplePasses - peopleStart.peoplePasses} passes (${f1(p.peoplePrepareMs - peopleStart.peoplePrepareMs)} ms), ${p.peopleWeights - peopleStart.peopleWeights} weights, ${p.peoplePicks - peopleStart.peoplePicks} picks`);
    }
    for (const [kind, [n, ms]] of [...S.kinds].sort((a, b) => b[1][1] - a[1][1])) lines.push(`  build ${n}× ${Math.round(ms)} ms ${kind}`);
    for (const t of S.tiles) lines.push(`tile ${t.k} at ${f1(t.s)}–${f1(t.e)} ms ${JSON.stringify(t.ms)}`);
    const inLong = (f) => S.long.some((l) => f.e >= l.s && f.t <= l.s + l.d);
    for (const l of S.long) {
      const e = l.s + l.d;
      const fr = S.frames.filter((f) => f.e >= l.s && f.t <= e);
      const calls = S.calls.filter((c) => c.s < e && c.s + c.d > l.s).map((c) => `${c.n} ${f1(c.d)}`);
      const done = S.tiles.filter((t) => t.e >= l.s - 5 && t.e <= e + 5).map((t) => t.k);
      lines.push(`long ${f1(l.s)} ${f1(l.d)} ms | render ${f1(Math.max(0, ...fr.map((f) => f.render)))} ms builds ${sum(fr, 'builds')} (${f1(sum(fr, 'buildMs'))} ms) pipelines ${sum(fr, 'pipes')} writeBuffer ${mb(sum(fr, 'wb'))} MB/${sum(fr, 'wbN')} attributes ${mb(sum(fr, 'ua'))} MB new buffers ${sum(fr, 'bufs')}${done.length ? ` | tile done ${done.join(',')}` : ''} | ${calls.join(', ') || '-'}`);
    }
    const calm = S.frames.filter((f) => !inLong(f)), avg = (k) => sum(calm, k) / Math.max(1, calm.length);
    lines.push(`frames outside long tasks ${calm.length}: render ${f1(avg('render'))} ms, writeBuffer ${mb(avg('wb'))} MB/${f1(avg('wbN'))}, attributes ${mb(avg('ua'))} MB a frame`);
    return lines;
  };
  window.__stalls = S;
})();
