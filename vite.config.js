import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { runningBench } from './scripts/game-lock.mjs';

// The dev server listens on every interface (package.json); these are the names it
// may be reached by besides localhost and IP addresses: the machine's .local name on
// the LAN and its Tailscale name.
const allowedHosts = ['.local', '.ts.net'];

// The libraries in the build (three.js, proj4, Leaflet…) want their licence text kept
// with every copy, and minifying strips it. This writes licenses.txt into dist with
// the full licence of every package the bundles use, found from the modules' paths.
// The tile worker is bundled separately, before the main bundle is written, so both
// builds add to the same set and the main one writes the file.
const bundled = new Set();
function licences(emit) {
  return {
    name: 'licences',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules)) {
          const m = id.replace(/\\/g, '/').match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
          if (m) bundled.add(m[1]);
        }
      }
      if (!emit) return;
      const parts = [...bundled].sort().map((name) => {
        const dir = join('node_modules', name);
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        // A package that ships no licence file (pmtiles) has its text in licences/<name>.txt.
        const own = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        const kept = join('licences', `${name.replace('/', '__')}.txt`);
        const path = own ? join(dir, own) : existsSync(kept) ? kept : null;
        if (!path) this.error(`No licence file found for ${name}: add its text as ${kept}`);
        const home = (pkg.homepage ?? pkg.repository?.url ?? pkg.repository ?? '')
          .replace(/^(git\+)?(git|https?):\/\//, 'https://').replace(/\.git$/, '');
        return `${name} ${pkg.version} (${pkg.license})${home ? `\n${home}` : ''}\n\n${readFileSync(path, 'utf8').trim()}`;
      });
      const rule = `\n\n${'-'.repeat(72)}\n\n`;
      this.emitFile({
        type: 'asset',
        fileName: 'licenses.txt',
        source: `Streets of Prague uses these open-source libraries. Their licences follow.${rule}${parts.join(rule)}\n`,
      });
    },
  };
}

// The dev server tells its pages when a benchmark is running anywhere on this machine,
// and the game stands still meanwhile (src/benchpause.ts, scripts/game-lock.mjs).
function benchWatch() {
  let answer = '{"bench":null}', asked = 0;
  return {
    name: 'bench-watch',
    apply: 'serve',
    configureServer(server) {
      // A world centred far from Prague (?at=, src/countrysideTiles.ts) has no data
      // files of its own: say so, rather than answer with the game's page.
      server.middlewares.use('/data/anywhere_now/', (_req, res) => { res.statusCode = 404; res.end(); });
      server.middlewares.use('/__bench', (_req, res) => {
        if (Date.now() - asked > 1000) {
          asked = Date.now();
          const bench = runningBench();
          answer = JSON.stringify({ bench: bench ? bench.where : null });
        }
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(answer);
      });
    },
  };
}

// What the settings panel shows as the build: the release tag (v1.2.0, or v1.2.0-5-gabc1234
// when commits came after it) and the date. Outside a git checkout it falls back to "dev".
const git = (args) => { try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const version = git('describe --tags --always --dirty') || 'dev';
// The Cloudflare build reads its map from a versioned R2 prefix, and its deploy script
// passes that version's name. Elsewhere the panel shows the day the map was built.
const data = process.env.VITE_DATA_VERSION ?? '';
const built = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILT__: JSON.stringify(built), __DATA_VERSION__: JSON.stringify(data) },
  server: {
    allowedHosts,
    // Protomaps' daily planet build for ?countryside=live (src/data.ts): their server
    // lets only a few origins read it, so the dev server fetches it for the game.
    proxy: {
      '/protomaps-build': { target: 'https://build.protomaps.com', changeOrigin: true, rewrite: (p) => p.replace(/^\/protomaps-build/, '') },
      '/protomaps-meta': { target: 'https://build-metadata.protomaps.dev', changeOrigin: true, rewrite: (p) => p.replace(/^\/protomaps-meta/, '') },
    },
  },
  preview: { allowedHosts },
  plugins: [licences(true), benchWatch()],
  worker: { plugins: () => [licences(false)] },
});
