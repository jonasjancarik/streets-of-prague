import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

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
        const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
        if (!file) this.error(`No licence file found for ${name}`);
        const home = (pkg.homepage ?? pkg.repository?.url ?? pkg.repository ?? '')
          .replace(/^(git\+)?(git|https?):\/\//, 'https://').replace(/\.git$/, '');
        return `${name} ${pkg.version} (${pkg.license})${home ? `\n${home}` : ''}\n\n${readFileSync(join(dir, file), 'utf8').trim()}`;
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

// What the settings panel shows as the build: the release tag (v1.2.0, or v1.2.0-5-gabc1234
// when commits came after it) and the date. Outside a git checkout it falls back to "dev".
const git = (args) => { try { return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
const version = git('describe --tags --always --dirty') || 'dev';
// Only the Cloudflare build reads its map from the versioned R2 prefix (VITE_DATA_URL);
// mbxp and local runs use whatever is in public/data.
const data = process.env.VITE_DATA_URL ? readFileSync('deploy/data-version', 'utf8').trim() : 'local';
const built = new Date().toISOString().slice(0, 10);

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILT__: JSON.stringify(built), __DATA_VERSION__: JSON.stringify(data) },
  server: { allowedHosts },
  preview: { allowedHosts },
  plugins: [licences(true)],
  worker: { plugins: () => [licences(false)] },
});
