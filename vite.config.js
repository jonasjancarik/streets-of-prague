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

export default defineConfig({
  server: { allowedHosts },
  preview: { allowedHosts },
  plugins: [licences(true)],
  worker: { plugins: () => [licences(false)] },
});
