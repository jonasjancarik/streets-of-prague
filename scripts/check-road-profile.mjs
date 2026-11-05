#!/usr/bin/env node
// Compare a road pilot with its baseline and with held-out DTM kerbs. Use the
// vehicle height function and production ground mesh buffers, including Float32.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { COLORS, groundLayers } from '../src/ground.ts';
import { decodeHeights, flatTerraces, heightSampler, pointLabels, terraceAt } from '../src/terrain.ts';
import { readRoadProfile, withRoadProfile } from '../src/roadProfiles.ts';

const [data, observations] = process.argv.slice(2);
if (!data || !observations) throw new Error('Usage: node scripts/check-road-profile.mjs <praha_now> <held-out observations.json>');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const index = json(join(data, 'index.json'));
const pilot = readRoadProfile(json(join(data, 'road-profile.json')), index.area, index.built);
if (!pilot) throw new Error('No road profile for this map build');
const { terrain } = index, ref = index.iprRef ?? 180;
const { from: [x0, y0], to: [x1, y1], taper, half, shoulder } = pilot.profile;
const length = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / length, uy = (y1 - y0) / length;
const project = (x, y) => [(x - x0) * ux + (y - y0) * uy, (y - y0) * ux - (x - x0) * uy];
const xy = (s, t = 0) => [x0 + s * ux - t * uy, y0 + s * uy + t * ux];
const onCore = (s, t) => s >= taper && s <= length - taper && Math.abs(t) <= half;
const onPatch = (s, t) => s >= 0 && s <= length && Math.abs(t) <= half + shoulder;
const maps = pilot.tiles.map((key) => {
  const t = json(join(data, 'tiles', `${key}.json`));
  const path = join(data, 'tiles', `${key}.height.bin`);
  const raw = existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`));
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const labels = pointLabels(bytes, terrain.n);
  const base = heightSampler(decodeHeights(bytes, terrain.n, ref), t.box, terrain.n, terrain.step,
    labels, terraceAt(t.terraces), flatTerraces(t.terraces, ref));
  return { t, steps: labels ? t.terraces ?? [] : null, base, candidate: withRoadProfile(base, pilot.profile, ref) };
});
function height(mode, x, y) {
  const m = maps.find(({ t: { box: [x0, y0, x1, y1] } }) => x >= x0 && y >= y0 && x <= x1 && y <= y1);
  if (!m) throw new Error(`Sample outside pilot tiles at ${x},${y}`);
  return m[mode](x, y) + ref;
}

const stats = (values) => ({
  count: values.length,
  meanAbs: values.reduce((sum, d) => sum + Math.abs(d), 0) / values.length,
  maxAbs: values.reduce((max, d) => Math.max(max, Math.abs(d)), 0),
});
const { heldOutPairs: pairs, sourceElevations } = json(observations);
if (pairs.length < 5) throw new Error('Too few held-out survey observations');
const [a, b, c, d] = pilot.profile.elevation;
const grades = [0, 1, -c / (3 * d)].filter((u) => u >= 0 && u <= 1).map((u) => (b + 2 * c * u + 3 * d * u * u) / length);
const report = { sourceElevations, fit: { length, centreElevations: [a, a + b + c + d],
  gradeRange: [Math.min(...grades), Math.max(...grades)], cross: pilot.profile.cross } };
for (const mode of ['base', 'candidate']) {
  const kerbs = pairs.flatMap(({ points }) => points.map(([x, y, z]) => height(mode, x, y) - z));
  const core = [], taperAndShoulder = [];
  let triangles = 0;
  for (const { t, steps, [mode]: h } of maps) {
    const layers = groundLayers(t, { box: t.box, height: h, steps, ...(mode === 'candidate' ? { roadProfile: pilot.profile } : {}) }).layers;
    for (const layer of layers) {
      if (layer.color !== COLORS.asphalt && layer.color !== COLORS.sett) continue;
      const { position: p, index: idx } = layer.geometry;
      triangles += idx.length / 3;
      for (let k = 0; k < idx.length; k += 3) {
        const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
        // Centroid and samples towards each corner expose interpolation error
        // within faces, where equality at the sampler's vertices proves little.
        for (const [wa, wb, wc] of [[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]]) {
          const x = wa * p[a] + wb * p[b] + wc * p[c], y = -wa * p[a + 2] - wb * p[b + 2] - wc * p[c + 2];
          const [s, t] = project(x, y);
          if (!onPatch(s, t)) continue;
          const error = wa * p[a + 1] + wb * p[b + 1] + wc * p[c + 1] - h(x, y);
          (onCore(s, t) ? core : taperAndShoulder).push(error);
        }
      }
    }
  }
  const coreDrop = height(mode, ...xy(taper)) - height(mode, ...xy(length - taper));
  report[mode] = { kerbs: stats(kerbs), coreDrop, triangles, meshCore: stats(core), meshTransition: stats(taperAndShoulder) };
}
// Compare on identical support points, independently of how either mesh is tessellated.
const changes = [];
for (let s = 0; s <= length; s += 0.1) for (let t = -half - shoulder; t <= half + shoulder; t += 0.1) {
  const p = xy(s, t);
  changes.push(height('candidate', ...p) - height('base', ...p));
}
report.heightChanges = stats(changes);
console.log(JSON.stringify(report, null, 2));
if (!report.candidate.meshCore.count || !report.candidate.meshTransition.count || report.candidate.meshCore.maxAbs > 0.01 || report.candidate.meshTransition.maxAbs > 0.03
  || report.candidate.kerbs.meanAbs >= report.base.kerbs.meanAbs) process.exitCode = 1;
