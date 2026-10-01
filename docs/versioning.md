# Versions of the game and the map

read_when: cutting a release; uploading or rebuilding map data; changing the files the
pipeline writes or how the game reads them; changing a deploy script; rolling back.

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

## What index.json records

Besides the map itself, each `<area>_now/index.json` has:

- `format`: the map format, above.
- `built`: when the pipeline last assembled the area (UTC).
- `pipeline`: the commit the pipeline was run from, with `-dirty` if files differed
  from it.

## When to raise the format

Raise `FORMAT` and `DATA_FORMAT` together, in one commit, whenever code from before the
change could not read the new files, or the new code could not read the old ones: a
changed binary layout, a renamed or removed field the game needs, a different tile grid
scheme. Adding a file or field that older code ignores and newer code treats as optional
does not need it.

After raising it, rebuild the map, upload it under a new version name and commit
`deploy/data-version` before deploying. The deploy scripts refuse to go on until the
map and the code agree.

`node scripts/check-data-format.mjs <folder or URL>` does that comparison by hand, for
`public/data` or for `https://streets-data.jonasjancarik.cz/<version>/`. It also fails
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

    scripts/release.sh v1.2.3

With `main` committed and pushed, it typechecks, checks that the map named in
`deploy/data-version` is on R2 in the format the code reads, and only then tags the
commit, publishes the GitHub release (the notes start with the map data version) and
runs `scripts/deploy-cloudflare.sh`. `--no-deploy` stops after the release.

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
  deploy. Nothing is uploaded or deleted.
- **mbxp.** Check out the earlier commit and run
  `DATA_ID=<id> scripts/deploy-mbxp.sh`, with the id from that release's `data-id` file,
  to deploy it with the map it had. Without `DATA_ID` it takes the local map.

## Keeping old maps

Every tag depends on its map version staying on R2 unchanged, so versions are not
deleted or overwritten. Each one is about 0.7 GB.

R2 enforces this: the bucket has a lock rule, `keep-every-map-version`, that refuses to
overwrite or delete any object, indefinitely. New versions upload as usual. To remove a
version after all (a failed upload, or to free space), the rule has to be taken off
first; `cf r2 buckets locks get streets-of-prague-data` shows it.
