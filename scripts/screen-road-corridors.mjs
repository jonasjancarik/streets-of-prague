// Screen one batch of survey fits against paired measurements from the game.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [manifestPath, currentPath, trialPath, beforePath, afterPath, outputPath, reportPath, mode] = process.argv.slice(2);
if (!reportPath || (mode && mode !== '--recheck'))
  throw new Error('Usage: screen-road-corridors.mjs manifest.json current.json trial.json before.json after.json accepted.json report.json [--recheck]');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readProbe = (path) => {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{')));
};
const manifest = read(manifestPath), current = read(currentPath), trial = read(trialPath);
const before = readProbe(beforePath), after = readProbe(afterPath);
if ([current, trial, before, after].some(r => r.built !== manifest.built)
    || before.digest !== digest(currentPath) || before.digest !== manifest.baselineDigest || after.digest !== digest(trialPath)) {
  throw new Error('Map or sidecar digest differs between the paired probes');
}
const trialIds = new Set(trial.patches.map(p => p.id));
const scope = mode ? manifest.cases.filter(c => trialIds.has(c.id)) : manifest.cases;
const cases = new Map(scope.map(c => [c.edge, c]));
const byEdge = (probe, filter = false) => {
  const map = new Map(probe.results.map(r => [r.edge, r]));
  if (map.size !== probe.results.length || (!filter && map.size !== cases.size) || [...cases.keys()].some(id => !map.has(id))) {
    throw new Error('Measurement batch does not match the candidate manifest');
  }
  return map;
};
const old = byEdge(before, mode === '--recheck'), next = byEdge(after);

// Both directions of height variation matter. Inspect the 1 m grade and
// 6 m wave at every matched sample, plus the rise across each adjacent road.
function guardRegression(a, b) {
  if (a.length !== b.length || a.some((g, i) => g.id !== b[i].id || g.profile.length !== b[i].profile.length)) {
    return 'adjoining-road sample coverage differs';
  }
  for (let k = 0; k < a.length; k++) {
    const prior = a[k].profile, fitted = b[k].profile;
    if ([...prior, ...fitted].some(row => row.some(x => !Number.isFinite(x)))) return 'adjoining-road heights unavailable';
    for (let i = 0; i < prior.length; i++) {
      if (Math.abs(fitted[i][1] - fitted[i][2]) > Math.abs(prior[i][1] - prior[i][2]) + .03)
        return 'adjoining-road crossfall increased';
      for (let lane = 0; lane < 3; lane++) {
        if (i && Math.abs(fitted[i][lane] - fitted[i-1][lane]) > Math.abs(prior[i][lane] - prior[i-1][lane]) + .02)
          return 'adjoining-road grade increased';
        if (i >= 3 && i + 3 < prior.length) {
          const wave = p => Math.abs(p[i][lane] - (p[i-3][lane] + p[i+3][lane]) / 2);
          if (wave(fitted) > wave(prior) + .03) return 'adjoining-road wave increased';
        }
      }
    }
  }
  return null;
}

function screen(a, b) {
  if (a.error || b.error) return { reason: 'rendered measurement unavailable', errors: [a.error, b.error] };
  if (a.active || !b.active) return { reason: 'expected corridor was not isolated' };
  if (a.asphalt.join() !== 'raster' || b.asphalt.join() !== 'raster') return { reason: 'raster asphalt unavailable' };
  if (a.stations !== b.stations || a.coveredStations / a.stations < .95
      || a.coveredStations !== b.coveredStations || a.samples !== b.samples || a.coverageHash !== b.coverageHash)
    return { reason: 'asphalt sample coverage differs or is incomplete' };
  const waves = [];
  for (let i = 0; i < a.waves.length; i++) {
    const x = a.waves[i], y = b.waves[i];
    if (!x.acrossAsphalt || !y.acrossAsphalt || x.span !== y.span) return { reason: 'wave samples unavailable' };
    waves.push({ span: x.span, before: Math.abs(x.acrossAsphalt.mesh), after: Math.abs(y.acrossAsphalt.mesh),
      drivingBefore: x.acrossDriving, drivingAfter: y.acrossDriving });
  }
  if (waves.some(w => w.after > w.before + .01 || w.drivingAfter > w.drivingBefore + .01))
    return { reason: 'a measured wave grew', waves };
  const peak = Math.max(...waves.map(w => w.before)), peakAfter = Math.max(...waves.map(w => w.after));
  if (peak - peakAfter < .03 || peakAfter > .8 * peak) return { reason: 'largest wave did not fall by 3 cm and 20%', waves };
  for (let i = 0; i < 2; i++) {
    for (const key of ['meshStep', 'drivingStep', 'meshWave', 'drivingWave']) {
      const tolerance = key.endsWith('Step') ? .02 : .03;
      if (b.joins[i][key] > a.joins[i][key] + tolerance) {
        return { reason: 'corridor join got rougher', end: i, metric: key,
          before: a.joins[i][key], after: b.joins[i][key], waves };
      }
    }
  }
  const reason = guardRegression(a.guards, b.guards);
  return { reason, waves };
}

const screened = scope.map(c => ({ id: c.id, edge: c.edge, name: c.name, at: c.at,
  ...screen(old.get(c.edge), next.get(c.edge)) }));
const byId = new Map(screened.map(r => [r.id, r]));
const retained = trial.patches.filter(p => byId.has(p.id) && !byId.get(p.id).reason);
if (trial.patches.filter(p => byId.has(p.id)).length !== byId.size) throw new Error('Trial patches differ from the candidate manifest');
writeFileSync(outputPath, JSON.stringify({ ...current, patches: [...retained, ...current.patches] }) + '\n');
writeFileSync(reportPath, JSON.stringify(screened, null, 2) + '\n');
console.log(`Retained ${retained.length} of ${screened.length} measured corridors`);
