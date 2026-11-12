# Contributing to Streets of Prague

Thanks for wanting to help. Bug reports, ideas and code are all welcome.

## Reporting a problem

Open an issue on GitHub, or use the **Feedback** button in the corner of the screen
while you play. Say where in Prague it happened and what you expected. In the
developer panel (press <kbd>`</kbd> or add `?dev`), **Copy this situation** copies
the place, time, weather and car, which makes a problem much easier to reproduce.

## Running the game

You need Node.js 20.19 or newer.

```bash
npm install
VITE_DATA_URL=https://data.streetsofprague.com/$(cat deploy/data-version)/ npm run dev
```

This borrows the public game's map, so you can change how the game plays, looks or
sounds without building a map. `node scripts/download-map.mjs centrum` keeps a copy of
an area in `public/data` instead, for offline work and for the checks that read the map
from disk; then run plain `npm run dev` and open `http://localhost:5191/?area=centrum`.
To change how the map is made, build your own with `pipeline/build_map.sh ujezd --quick`
and open `?area=ujezd` the same way
([Your first build](docs/handbook.md#your-first-build) has the details).

## Finding your way round

- [docs/handbook.md](docs/handbook.md) covers how each part of the game works, the URL
  options, the tests and the map pipeline. Longer topics have their own pages in
  [docs/](docs/), and larger changes were planned in [plans/](plans/).
- `src/` is the game (TypeScript, three.js), `pipeline/` makes the map (Python, run
  with [uv](https://docs.astral.sh/uv/)), `scenarios/` holds scripted gameplay tests.
- The camera is always straight down, so judge a visual change by how it looks from
  above.

## Checking a change

```bash
npm run build   # type check and production build
npm test        # the pipeline's tests (needs uv)
```

GitHub runs both on every push and pull request. For gameplay, the scenarios drive
the real game in headless Chrome and need a map, either built or borrowed:
`node scripts/scene.mjs run <name>` (see "Testing" in the handbook). For visual
changes, add a screenshot from before and after to your pull request.

## Sending a change

- Keep a pull request to one change, and say what a player will notice.
- Commit titles follow the project's style: the part of the game, then what changed,
  such as `Trams: leave a moving tram at once`. The body can say why.
- Anything you add from outside (a sound, a texture, a model) must allow commercial
  use (CC0 and CC BY are fine; nothing non-commercial). Record where it came from,
  its author and its licence in `public/audio/SOURCES.md` or `assets/SOURCES.md`.
- The map is made from open data (OpenStreetMap and IPR Praha). Prefer what the data
  says to hand-placed scenery, and say in the pull request where something is a
  guess.

By sending a contribution you agree that it is released under the project's licence,
the [GNU AGPL v3.0](LICENSE).
