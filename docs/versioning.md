# Versions of the game and the map

read_when: cutting a release; uploading or rebuilding map data; changing the files the
pipeline writes or how the game reads them; changing a deploy script; rolling back.

Which script to run in which situation, step by step: `.agents/skills/deploy/SKILL.md`.

## The three numbers

**The game's version** is a git tag on `main` (`v1.2.3`), published as a GitHub release.
`vite.config.js` reads `git describe`, so a build made from the tag is `v1.2.3` and one
made five commits later is `v1.2.3-5-gabc1234`.

**The map data version** is the name of a folder in the R2 bucket
`streets-of-prague-data`, such as `2026-10-01-b2` (the date, then a letter and number if
there was more than one that day). It is chosen when the map is uploaded.
`deploy/data-version` holds the name of the version in use and is committed, so every
commit, and so every tag, names the map it goes with. There is no separate number
covering both: the tag is that number.

**The map format** is a whole number saying how the map's files are laid out. `FORMAT`
in `pipeline/layers.py` writes it into each area's `index.json`, and `DATA_FORMAT` in
`src/data.ts` is the one the game reads. The game checks it before reading anything else
and stops with a message if the two differ. A map with no number was built before the
number existed and counts as 1.

The game changes many times a day and the map rarely, which is why they are versioned
apart: a release that changes only code keeps pointing at the map already uploaded.

## Which maps a commit can use

Two more files, committed with `deploy/data-version`, say which maps a commit works with:

- `deploy/data-history` lists every map version, oldest first, one per line. It is
  append-only: `scripts/upload-data.sh` adds the new version once the upload is
  verified. Version names don't sort in a way the scripts rely on (a second upload on
  one day is `-b2`), so this order is what "older" and "newer" mean.
- `deploy/data-oldest` is the oldest map version this code still plays correctly with.
  The commit works with every map from there to `deploy/data-version`.

Most commits leave `data-oldest` alone. Raise it, to the first map that works, in the
same commit as any code that can't do without newer map files: always when the format
number rises, and also when code starts relying on a map file or field that older maps
lack and has no fallback for.

`node scripts/check-data-versions.mjs` fails unless both names are in the history,
`data-oldest` is not later than `data-version`, and the map at `data-oldest` on R2 is in
the format the code reads (`--offline` skips that last check). With `--accepted` it
prints the versions from `data-oldest` to `data-version`, one per line. Both
`scripts/release.sh` and `scripts/deploy-cloudflare.sh` run it.

## What index.json records

Besides the map itself, each `<area>_now/index.json` has:

- `format`: the map format, above.
- `built`: when the pipeline last assembled the area (UTC).
- `pipeline`: the commit the pipeline was run from, with `-dirty` if files differed
  from it.

## version.json

Both deploy scripts write `version.json` at the site root with
`scripts/write-version-json.mjs`:

    { "game": "v1.2.3", "built": "2026-10-01", "map": "2026-10-01-b2", "mapFormat": 1,
      "mapsAccepted": ["2026-10-01-b2"] }

`game` is what `git describe` gave the build (as in the settings panel), `map` the map
it goes with and `mapsAccepted` the range from the check above. On mbxp the map is the
fingerprint id, and that is the only one accepted. Cloudflare serves it with
`Cache-Control: no-store` (the generated `_headers`); busybox httpd on mbxp can't send
headers, so the game asks for it with `cache: 'no-store'` instead.

An open tab reads it (`src/update.ts`) on load and when it becomes visible again, at
most every 15 minutes. If `game` differs from the tab's own version, the settings panel
and the start screen show "A newer version of the game is available" with a Reload
button. Failures are ignored; the game never reloads itself. The mobile app will read
the same file.

Caching on the web, checked 2026-10-02: `index.html` is `max-age=0, must-revalidate`,
files under `/assets/` are `max-age=31536000, immutable` (their names carry a hash), and
map files are `max-age=31536000, immutable`.

## When to raise the format

Raise `FORMAT` and `DATA_FORMAT` together, in one commit, whenever code from before the
change could not read the new files, or the new code could not read the old ones: a
changed binary layout, a renamed or removed field the game needs, a different tile grid
scheme. Adding a file or field that older code ignores and newer code treats as optional
does not need it.

After raising it, raise `deploy/data-oldest` too once the new map is uploaded (it is
the first map in the new format), then rebuild the map, upload it under a new version name and commit
`deploy/data-version` before deploying. The deploy scripts refuse to go on until the
map and the code agree.

`node scripts/check-data-format.mjs <folder or URL>` does that comparison by hand, for
`public/data` or for `https://data.streetsofprague.com/<version>/`. It also fails
if the two constants differ from each other.

## Uploading a map

    scripts/upload-data.sh 2026-10-05

It checks the local map's format, uploads `public/data` to R2 under that name, compares
checksums of every file, and writes the name to `deploy/data-version`. Commit that file.

A version is uploaded once and never changed. The script refuses a name that is already
on R2; `--resume` finishes an upload of the same files that was interrupted, and fails
if a file already there differs. The files are served with a one-year `immutable` cache
header, so a file that changed under the same name would reach some players and not
others: a corrected map always gets a new name.

## Releasing

    scripts/release.sh patch

`patch`, `minor` and `major` count up from the latest release (after `v0.2.3`:
`v0.2.4`, `v0.3.0`, `v1.0.0`); a number such as `v1.2.3` can be given instead. With
`main` committed and pushed, it typechecks, checks that the map named in
`deploy/data-version` is on R2 in the format the code reads, and only then tags the
commit, publishes the GitHub release (the notes start with the map data version) and
runs `scripts/deploy-cloudflare.sh`. `--no-deploy` stops after the release.

The release notes say which maps it works with: "Needs map X or newer" when
`deploy/data-oldest` differs from the previous release's (a release from before the file
existed counts as different only if the map format changed), otherwise "Works with maps
from X". The list of releases is thereby the record of which updates needed a new map.

Production only runs released versions. `scripts/deploy-cloudflare.sh` refuses a commit
that isn't a release tag, so what is live always has a version number, a GitHub release
with notes and a named map, and the previous state to go back to is always the previous
tag. A fix that can't wait is a `patch` release. Code that isn't ready for a version
goes to the beta. For an emergency, `scripts/deploy-cloudflare.sh --untagged` deploys
the current commit anyway; the settings panel then shows something like
`v1.2.3-2-gabc1234`, and the next release puts things right.

## The two sites

**Cloudflare** (<https://streetsofprague.com>) is built by
`scripts/deploy-cloudflare.sh` with the address of the map version baked into the code.
An open tab, a cached page and an earlier deployment each keep loading the map they were
built for.

**mbxp** (<https://beta.streetsofprague.com>) is built by `scripts/deploy-mbxp.sh`
from the local `public/data`, with no upload to R2 and no entry in
`deploy/data-version`. Each map is kept on the server in `data/<id>` and served at
`data/<id>/`, where the id is a fingerprint of the files' paths, sizes and modification
times. A changed map therefore gets a new folder and a new address: the game that is
running keeps its map until the new one is whole, and browsers never mix files of two
maps. Files that are unchanged are hard links to the previous map's, so only the
differences are sent and stored. On the server, `current` and `current-data` name the
live commit and map, and `releases/<commit>/data-id` the map each release went out with.
Old folders in `data/` are not removed automatically.

## What the settings panel shows

`Version v1.2.3 · 2026-10-01 · map data 2026-10-01-b2`: the game's version, the day it
was built, and the map. On Cloudflare the map is the data version. On mbxp and in local
runs it is the day the map was built (`built` in `index.json`), or `local` for a map
built before that was recorded.

## Rolling back

- **A bad release on Cloudflare.** Check out the previous tag and run
  `scripts/deploy-cloudflare.sh`. The tag brings its own `deploy/data-version`, and that
  map is still on R2.
- **A bad map on Cloudflare.** Revert the commit that changed `deploy/data-version` and
  release that as a patch. Nothing is uploaded or deleted.
- **mbxp.** Check out the earlier commit and run
  `DATA_ID=<id> scripts/deploy-mbxp.sh`, with the id from that release's `data-id` file,
  to deploy it with the map it had. Without `DATA_ID` it takes the local map.

## Where the map is served

The bucket answers at two addresses:

- `https://data.streetsofprague.com/<version>/`, which the deploy and release scripts
  use.
- `https://streets-data.jonasjancarik.cz/<version>/`, the earlier address. Releases up
  to v0.1.0 have it built into their code, so it stays connected to the bucket for as
  long as any of them might be deployed again.

Each address has a Cache Rule in its own Cloudflare zone: files are eligible for cache
and kept as long as their `Cache-Control` header says. Without the rule Cloudflare
caches the `.bin.gz` files but fetches every `.json` from R2 on each request. A new
address for the bucket needs its own rule. The `cf` login used for deploys can connect
a domain to the bucket but is not allowed to read or change Cache Rules; those are made
in the dashboard (the zone → Caching → Cache Rules) or with a token that has that
permission.

To check that an address caches, download a file twice and read `cf-cache-status` on
the second response; it should be `HIT`:

    curl -s -o /dev/null -D - https://data.streetsofprague.com/<version>/praha_now/index.json | grep -i cf-cache-status

Use a full download as above, not `curl -I`: a header-only request reports `DYNAMIC`
here even for a file that is cached.

## Keeping old maps

Every tag depends on its map version staying on R2 unchanged, so versions are not
deleted or overwritten. Each one is about 0.7 GB.

R2 enforces this: the bucket has a lock rule, `keep-every-map-version`, that refuses to
overwrite or delete any object, indefinitely. New versions upload as usual. To remove a
version after all (a failed upload, or to free space), the rule has to be taken off
first; `cf r2 buckets locks get streets-of-prague-data` shows it.
