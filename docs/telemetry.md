---
read_when: changing what the game reports about itself, the Worker in deploy/worker.js, the statistics switch in the settings, or the statistics dashboard
---

# Anonymous statistics

The Cloudflare build of the game reports how well it runs, what goes wrong and what
gets played. Local development, the mbxp site and test runs (`?go`) report nothing:
only a build with `VITE_TELEMETRY_URL` set does, and `scripts/deploy-cloudflare.sh`
sets it to `/t`.

## What is sent

`src/telemetry.ts` sends five kinds of report. `SCHEMA` in `deploy/worker.js` lists
every field of each and is the only place the format is defined.

| Report | When | What it holds |
|---|---|---|
| `start` | the game begins after the start screen | renderer (WebGPU, WebGL 2, or the legacy WebGL renderer), graphics card name, graphics setting and level, language, keyboard or touch, new or continued game, browser and its major version, operating system, the site the visitor came from, loading time, screen size, pixel ratio, memory and processor cores as the browser reports them |
| `frames` | the tab is hidden or closed | time played, frames drawn, middle and 95th-percentile frame time, frames over 100 ms and over 250 ms, how often Auto changed the graphics level, map tiles that failed to load |
| `play` | with `frames` | seconds on foot, driving, on a tram, in a taxi and on anything else; metres travelled; cars wrecked, people knocked over, arrests, deaths; money; the most stars reached; tickets bought; games saved by hand |
| `setting` | a setting is changed in the panel, or with G or P | which one and the new value |
| `error` | an uncaught error, a failed start, WebGPU falling back to WebGL, the graphics device being lost | the message and the first lines of the stack; five a session at most, each distinct error once |

`frames` and `play` hold totals since the start of the session and may be sent several
times (each time the tab is hidden); `seq` counts them and the last one is the session.

Every report also carries the game's version, a random session number made when the
page loads and forgotten when it closes, and the visitor's country as Cloudflare
derives it. There is no cookie and no stored identifier, the IP address is not kept,
and where the player is on the map is never sent.

Players can turn it off under **Anonymous statistics** in the settings; the choice is
remembered in the browser (`localStorage` key `telemetry`).

## Where it goes

`deploy/worker.js` is the Worker in front of the static files. It answers `POST /t`
only from the game's own pages, drops anything that isn't a known report, and writes
one row to the Analytics Engine dataset `streets_telemetry`: the report's name,
version, session and country in `blob1` to `blob4`, then the report's text fields from
`blob5` and its numbers from `double1`, in the order `SCHEMA` lists them. Add new
fields at the end of a list so rows already stored keep their meaning. Analytics
Engine keeps rows for three months.

## The dashboard

```bash
node scripts/telemetry-dashboard.mjs             # the last 14 days
node scripts/telemetry-dashboard.mjs --days 30
node scripts/telemetry-dashboard.mjs --sample    # made-up numbers, to see the page
```

It reads the rows with `cf analytics_engine sql query`, adds them up and writes
`.telemetry/dashboard.html` (not committed), then opens it. The page is a file on
your machine; nothing is published. Reading needs a Cloudflare login that may query
analytics: if the `cf` login is refused, create an API token with the **Account
Analytics: Read** permission and run the script with `CLOUDFLARE_API_TOKEN` set to it.

## Visits (Cloudflare Web Analytics)

Optional. Add the site in the Cloudflare dashboard under Web Analytics, choose the
manual JavaScript setup, and put the site token in `deploy/web-analytics-token`
(the token is public: it ends up in the page). The next deploy then loads
Cloudflare's cookie-free beacon, behind the same switch in the settings. Its numbers
are in the Cloudflare dashboard, not in the page above.
