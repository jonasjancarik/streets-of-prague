import { defineConfig } from 'vite';

// The dev server listens on every interface (package.json); these are the names it
// may be reached by besides localhost and IP addresses: the machine's .local name on
// the LAN and its Tailscale name.
const allowedHosts = ['.local', '.ts.net'];

export default defineConfig({
  server: { allowedHosts },
  preview: { allowedHosts },
});
