---
name: deploy
description: How to put Streets of Prague online, on the mbxp beta (streets-beta.jonasjancarik.cz) and on production at Cloudflare (streets.jonasjancarik.cz), which script to run in which situation, in what order, and what to check afterwards. Use when the user asks to deploy, ship, publish, release, cut a version, update the beta or production, upload new map data, or roll back a bad deploy or a bad map.
---

# Deploying Streets of Prague

Two sites, four scripts. Production only runs released versions; everything else goes
to the beta. The background (the release tag, the map data version, the
map format and why they are separate) is in `docs/versioning.md`; read it before
changing a script or when something below doesn't fit the situation.

| Site | Address | Script | Map it serves |
|---|---|---|---|
| Beta | <https://streets-beta.jonasjancarik.cz> (mbxp) | `scripts/deploy-mbxp.sh` | the local `public/data` |
| Production | <https://streets.jonasjancarik.cz> (Cloudflare) | `scripts/release.sh` (which runs `scripts/deploy-cloudflare.sh`) | the R2 version named in `deploy/data-version` |

Deploy only what the user asked for. "Deploy to beta" doesn't include production.
"Deploy to prod" always means a release, since production takes nothing else: if the
user didn't say which kind, ask whether it is a patch (fixes), minor (new things) or
major one.

## Before any deploy

1. `git status`: every script refuses uncommitted changes. Commit first (small logical
   commits; see the user's git rules).
2. Did the change touch what the pipeline writes or how the game reads it? Then see
   "The map changed" below before deploying.
3. Production deploys need main pushed for a release (`release.sh` checks it), and a
   working `cf` login (`cf auth whoami`; the token expires).

## Which script

**Beta only** (the usual quick check of new code):

    scripts/deploy-mbxp.sh

It builds the current commit and sends the local map, which only transfers files that
changed since the last map on the server. Off the home network it falls back to
`mbxp-remote` by itself.

**Beta, then production** (the usual order when both are wanted): deploy the beta, check
it (below), then release. The beta uses the local map and
production the uploaded one, so a beta that works says the code is fine, not that the
uploaded map is the same as the local one.

**Production:**

    scripts/release.sh patch

`patch`, `minor` or `major` counts up from the latest release (after `v0.2.3`: `v0.2.4`,
`v0.3.0`, `v1.0.0`); an exact number such as `v0.2.0` works too. Main must be pushed. It
typechecks and checks the map on R2 first, then tags, pushes the tag, publishes the
GitHub release and runs the Cloudflare deploy. `--no-deploy` stops after the release.
If the script fails before "git tag", nothing was published and it can simply be run
again after the fix. If it fails after the tag (the deploy itself), the release exists:
fix the cause and run `scripts/deploy-cloudflare.sh` on the same commit, don't release
again.

`scripts/deploy-cloudflare.sh` on its own refuses a commit that isn't a release tag. It
is for that retry and for rollbacks. `--untagged` makes it deploy any commit: only when
the user asks for exactly that, in an emergency.

## The map changed

Only needed when the map in `public/data` should reach production. The beta takes the
local map with every deploy, so it needs none of this.

1. Check the local map is whole and readable: `node scripts/check-data-format.mjs public/data`.
2. Upload it under a new name, the date plus a suffix if needed:
   `scripts/upload-data.sh 2026-10-05`. It needs the rclone remote `streets:` (README,
   "After rebuilding map data"). It takes a while: about 0.7 GB in tens of thousands of
   files. Interrupted? Run it again with `--resume`.
3. Commit `deploy/data-version`, which the script updated, push, and release.

Never reuse or try to fix up a version name. The bucket has a lock rule and refuses to
overwrite or delete anything; a corrected map gets a new name.

If the change altered the files' layout so that older code can't read the new map (or
the new code the old map), raise `FORMAT` in `pipeline/layers.py` and `DATA_FORMAT` in
`src/data.ts` together in one commit, rebuild, then do the three steps above. Until the
new map is uploaded the production deploy refuses to run, which is the point.

`public/data` is shared by parallel sessions (and worktrees), so before uploading make
sure nobody is rebuilding it: a map uploaded mid-rebuild is a mix that can't be fixed
under the same name.

## What to check afterwards

Both scripts print the HTTP status of the page and of the map index on mbxp, or the
deployment from `cf` on Cloudflare. Then:

- Open the site and wait for the map to load. A format mismatch or a missing map shows
  as "Something went wrong: …" on the loading screen.
- Open the settings panel and read the last line: `Version … · date · map data …`. It
  should name the commit or tag just deployed. On production the map is the version in
  `deploy/data-version`; on the beta it is the day the map was built.
- For anything about how the game plays, use the scene-testing skill before deploying,
  not the live site.

Tell the user what was deployed where (commit or tag, and the map), and what was
checked.

## Rolling back

- **Production, bad code:** check out the previous tag and run
  `scripts/deploy-cloudflare.sh`. The tag carries its own `deploy/data-version` and that
  map is still on R2. Checking out a tag changes the branch state, so ask the user
  first, and go back to main afterwards.
- **Production, bad map:** revert the commit that changed `deploy/data-version`, push,
  and release that as a patch. Nothing is uploaded or deleted.
- **Beta:** each release's map id is on the server in
  `/home/jonas/deployments/streets-of-prague/releases/<commit>/data-id`, and the live
  one in `current-data`. From the earlier commit, run
  `DATA_ID=<id> scripts/deploy-mbxp.sh` to deploy it with the map it had.

## Things that go wrong

- **"This commit is not a release."** Production was asked to take an untagged commit:
  release it instead, or deploy it to the beta.
- **"Commit your changes first."** The tree is dirty, often `deploy/data-version` after
  an upload.
- **The format check fails on production.** The code reads a format the uploaded map
  doesn't have: upload the map (above), don't lower the number.
- **`cf deploy` fails on authentication.** `cf auth whoami`, then let the user log in
  again; the account id is set in the script.
- **mbxp is unreachable.** The script tries `mbxp-remote`; if that fails too, see the
  mbxp-server-management skill.
- **Old maps pile up on mbxp** in `data/`. They share unchanged files, so they cost
  little; removing them is the user's decision.
