# Plan 003: Deploy to Cloudflare, with the map data in R2, alongside mbxp

> An implementation plan for another agent. Planned at `2561583` on `main`, 2026-09-29.
> The working tree then had someone else's uncommitted work (`src/lamps.ts`,
> `src/webgpu/lamps.ts`). Check `git status` and `git diff` before you start, don't
> revert changes you didn't make, and commit only your own hunks.

## Status

- Priority: P2
- Effort: M (about a day, most of it the first upload and checking the caching)
- Risk: low while Cloudflare runs on a new hostname next to mbxp; medium for the
  optional hostname swap at the end (DNS and the tunnel's ingress rules)
- Depends on: none
- Category: deployment

## Goal and scope

Serve the game from Cloudflare as well as from mbxp. Both deployments must keep
working, each deployable on its own:

- **mbxp** (today's `scripts/deploy-mbxp.sh`, busybox httpd behind the `urad-ai-poc`
  tunnel) stays as it is and keeps loading the map data from its own `data/`,
  relative to the page.
- **Cloudflare** gets the app (HTML, JS, audio, models) as a Worker with static assets
  and nothing else. The map data goes to an R2 bucket on its own hostname, and the app
  built for Cloudflare loads the data from there.

Out of scope: changing the pipeline or the data format, packing the tiles into fewer
files, and moving `?cover`/`?ortho` data (not in `praha_now` today).

Expected changed files: a new `src/data.ts`, the `fetch`/loader call sites listed
below, `index.html` (a preconnect), new `wrangler.jsonc`, new
`scripts/deploy-cloudflare.sh` and `scripts/upload-data.sh`, a new committed
`deploy/data-version`, `README.md` (Deploying), `plans/README.md`.
`scripts/deploy-mbxp.sh` should need no change. If it does, keep its behaviour
identical.

## Why this layout

Measured on 2026-09-29: `public/data/praha_now` has 37,289 files and 519 MB. There are
14,595 tiles, each with a `.json`, a `height.bin.gz` and sometimes `ipr` and `levels`.
The median file size is 2.8 kB and the largest file 215 kB. `centrum_now` has 836 files
and `ujezd_now` 92. Everything else in `public/` is about 8 MB and 56 tracked files.

Cloudflare's limits (docs checked 2026-09-29):

- **Pages and Workers static assets:** 20,000 files on the free plan and 100,000 on paid
  plans. No single file may exceed 25 MiB. Requests to Workers static assets are free.
- **R2:** 10 GB-month, 1M Class A and 10M Class B operations a month are free. After
  that, Class A costs $4.50 and Class B $0.36 per million. Egress is free.

The data doesn't fit the free static-assets limit, but the app alone does, and R2 has
no file-count limit. The bucket is served straight from a custom domain through
Cloudflare's cache, with no Worker in front of it, so cache hits cost nothing. A Worker
with an R2 binding would bill every request: a session loads roughly 1,000–1,500 files
(an estimate, not measured), so the free 100k Worker requests a day would last about
70–100 sessions. The whole setup should stay within the free tiers.

## Current state and contracts

- Every map-data URL is built as `data/${area}_now/...` relative to the page:
  - `src/main.ts:101,108,112,116`
  - `src/tiles.ts:323` (landmarks.json), `:570` (tile base, including `.bin.gz`
    through `fetchBinary`), `:577` (cover), `:590` (ortho, `THREE.TextureLoader`),
    `:758` (landmark GLB through `landmarkModel`)
  - `src/districts.ts:56`, `src/bikeshare.ts:55`, `src/footfall.ts:29,31`,
    `src/lamps.ts:277`, `src/signals.ts:97`, `src/dev.ts:33`
  - Line numbers are from `2561583`, so grep for `data/` rather than trusting them.
- `fetchBinary` (`src/terrain.ts`) unpacks `.gz` only if the bytes still start with
  the gzip header, so it works whether or not a server has already decoded them.
- `scripts/deploy-mbxp.sh` builds with `publicDir: false`, so the 519 MB of
  `public/data` don't get copied into `dist`. It then rsyncs the tracked files of
  `public/` next to the build and syncs `public/data/` to `shared/data`.
  `scripts/httpd.conf` gives JSON a Content-Type so Cloudflare compresses it.
- `jonasjancarik.cz` is on Cloudflare (nameservers `arvind`/`ashley`), and
  `streets.jonasjancarik.cz` goes through the tunnel to mbxp.
- `tsconfig.json` already has `vite/client` types, so `import.meta.env` is typed.
- `rclone` and `cf` are installed. `wrangler` isn't installed globally.

## Design

### Data base URL

Add `src/data.ts`:

```ts
// Where the map data is: data/ next to the page (dev, mbxp), or the R2 bucket for the
// Cloudflare build, e.g. https://streets-data.jonasjancarik.cz/2026-09-29/.
export const DATA = import.meta.env.VITE_DATA_URL ?? 'data/';
export const dataUrl = (area: string, path: string) => `${DATA}${area}_now/${path}`;
```

Replace each `data/${area}_now/...` with `dataUrl(area, '...')`. Behaviour without
`VITE_DATA_URL` must stay byte-for-byte the same, which is what keeps dev and mbxp
working.

`VITE_DATA_URL` is set **only** in the environment of `scripts/deploy-cloudflare.sh`.
Don't put it in `.env`, `.env.production` or `vite.config.js`, because the mbxp build
would pick it up and load its data from R2 instead of its own.

In `index.html`, add `<link rel="preconnect" href="%VITE_DATA_ORIGIN%" crossorigin>`
only if Vite leaves nothing behind when the variable is unset. Otherwise add it from
`vite.config.js` when `VITE_DATA_URL` is set. This part is optional.

### Data in R2, one prefix per data version

- Bucket `streets-of-prague-data` holds `<version>/praha_now/...`, `<version>/centrum_now/...`
  and `<version>/ujezd_now/...`.
- `deploy/data-version` (committed) holds the version the Cloudflare build points at,
  e.g. `2026-09-29`. A code commit therefore always names the data it was built for,
  and a new pipeline run never changes what a deployed build loads.
- `scripts/upload-data.sh <version>`:
  - uploads `public/data/` with `rclone copy --transfers 32 --checkers 32`;
  - sets `--header-upload "Cache-Control: public, max-age=31536000, immutable"` (safe,
    because a prefix is never rewritten);
  - refuses if the prefix already exists (`rclone lsf`);
  - writes `deploy/data-version` at the end.
- Leave Content-Type to rclone's detection by extension. Check that `.json` comes out
  as `application/json` (so Cloudflare compresses it) and `.bin.gz` as
  `application/gzip`, without `Content-Encoding`.
- A full upload is about 38k Class A operations, so a few dozen uploads a month stay
  free. Keep the current and previous versions and delete older prefixes by hand.
- rclone needs an R2 API token (S3 access key and secret) in an rclone remote, e.g.
  `r2:`. Keep it in the rclone config and out of the repo.

### Data hostname

- Connect the bucket to the custom domain `streets-data.jonasjancarik.cz`. Don't use
  `data.streets.jonasjancarik.cz`: Universal SSL covers only one level below the zone.
  Don't use `r2.dev` either, because it's rate-limited and not meant for production.
- Add a Cache Rule for that hostname: eligible for cache, and the edge TTL respects the
  origin's `Cache-Control`. Cloudflare doesn't cache `.json` by extension by default.
- CORS: the game fetches from another origin with plain GETs and no custom headers, so
  there's no preflight. Textures and GLBs load with `crossOrigin = 'anonymous'`, which
  also needs the header. The data is public, so give the bucket a CORS policy with
  `AllowedOrigins: ["*"]` and `AllowedMethods: ["GET", "HEAD"]`.
- Then check that a cached response still carries `Access-Control-Allow-Origin`. R2
  adds it only when the request had an `Origin`, and the first request to fill the
  cache might not. If it's missing, add the header with a Response Header Transform
  Rule on the hostname (`Access-Control-Allow-Origin: *`), which works regardless of
  what's cached.

### App as a Worker with static assets

- `wrangler.jsonc`: name `streets-of-prague` and `assets: { directory: "./dist-cf" }`,
  with no `main`. An assets-only Worker costs nothing to serve. Use a build directory
  of its own so the mbxp build's `dist` is never mixed up with it.
- `scripts/deploy-cloudflare.sh`:
  1. Refuse to run with uncommitted changes, like the mbxp script.
  2. Read `deploy/data-version` and check that
     `https://streets-data.jonasjancarik.cz/<version>/praha_now/index.json` answers 200.
  3. Build with `VITE_DATA_URL=https://streets-data.jonasjancarik.cz/<version>/`,
     `publicDir: false` and `outDir: 'dist-cf'`.
  4. Copy the tracked files of `public/` into `dist-cf` (`git ls-files`, as the mbxp
     script does).
  5. Write `dist-cf/_headers` with `/assets/*` set to
     `Cache-Control: public, max-age=31536000, immutable`, since those names are hashed.
  6. Deploy. Per AGENTS.md, try `cf` first (see the `cloudflare-build-output-deploy`
     skill for `cf deploy --prebuilt`), and fall back to `npx wrangler deploy`
     (wrangler ≥ 4.34).
- Add `dist-cf/` to `.gitignore`.

### Hostnames: both deployments live side by side

- Phase 1, the default: mbxp stays on `streets.jonasjancarik.cz` untouched, and the
  Worker gets its own custom domain, e.g. `streets-cf.jonasjancarik.cz` (and its
  `*.workers.dev` URL). No DNS record or tunnel rule of mbxp changes.
- Phase 2, optional and only after the user decides: Cloudflare takes
  `streets.jonasjancarik.cz` and mbxp moves to e.g. `streets-mbxp.jonasjancarik.cz`.
  The steps are:
  - Add the new mbxp hostname to the tunnel first. The ingress update replaces the
    whole configuration, so read it, keep every rule with the catch-all last, dry-run,
    and re-read the version.
  - Then detach the old hostname from the tunnel and attach it to the Worker.
  - The `mbxp-server-management` skill covers the tunnel side.
  - Rollback is the same steps in reverse. mbxp never stops serving during them.
- Each target keeps its own data. mbxp gets `public/data` by rsync, Cloudflare gets
  the version in `deploy/data-version`. The two can differ for a while, which is
  fine, but each deploy script should print which data it's serving.

## Steps

1. Add `src/data.ts` and switch the call sites. Typecheck. Check that `npm run dev`
   still loads `praha` and `centrum` from `data/`.
2. Create the bucket, its custom domain, the Cache Rule and CORS. Add
   `scripts/upload-data.sh` and upload the current `public/data` as the first version.
3. Add `wrangler.jsonc`, `scripts/deploy-cloudflare.sh`, `_headers` and the
   `.gitignore` entry. Deploy to `*.workers.dev`, then attach `streets-cf.jonasjancarik.cz`.
4. Run `scripts/deploy-mbxp.sh` unchanged and check that mbxp still serves its own
   `data/` (step 1 of Verification).
5. Update README "Deploying" with both targets, how to upload a new data version and
   which script to run for which target. Update the plans table.
6. Phase 2 hostname swap only if the user asks for it.

## Verification

1. **mbxp unchanged:** after `scripts/deploy-mbxp.sh`, the page on
   `streets.jonasjancarik.cz` makes no requests to `streets-data.*` (DevTools Network),
   and `grep -r streets-data dist/` finds nothing.
2. **Cloudflare:** on `streets-cf.jonasjancarik.cz`, walk and drive across several
   districts. Tiles, IPR buildings, terrain, landmarks (Mánes), lamps, signals, bikes
   and footfall should all load, with no CORS errors in the console.
3. **Headers:**
   - Run `curl -sI -H 'Origin: https://streets-cf.jonasjancarik.cz'` on a tile `.json`
     and `.bin.gz` twice. The second time should show `cf-cache-status: HIT`, the
     `Access-Control-Allow-Origin` header and the long `Cache-Control`.
   - The `.json` should be `application/json` and arrive compressed with
     `Accept-Encoding: br`.
   - Also run it once without `Origin` first on a fresh file, then with `Origin`, to
     test the cached-CORS case.
4. **Speed:** compare the time to the first rendered frame with mbxp. The data is now
   on another origin, which costs one more TLS connection. Use `scripts/bench.mjs` in
   real Chrome if it's close.
5. `npm run build` (typecheck plus build) passes.

## Open questions for the user

- Which deployment should own `streets.jonasjancarik.cz` in the end? The plan keeps
  mbxp there and adds `streets-cf.` until the user decides.
- The dev panel (`src/dev.ts`) ships to production and calls Nominatim and OSM's tile
  server. Their usage policies don't welcome public traffic, so should the panel be
  hidden outside dev? This is a separate change, not part of this plan.
