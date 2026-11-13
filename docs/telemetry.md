---
read_when: changing what the game reports about itself, worker/stats.js or the Worker's /api/report, the statistics switch in the settings, or the statistics dashboard
---

# Anonymous statistics

The Cloudflare build of the game reports how well it runs, what goes wrong and what
gets played. Local development and test runs (`?go`) report nothing: only a build with
`VITE_TELEMETRY_URL` set does. `scripts/deploy-cloudflare.sh` sets it to `/api/report`,
and `scripts/deploy-mbxp.sh` to production's `/api/report` at the game's address (`deploy/address`), so the
beta reports too; its rows carry the beta's domain (from the request's `Origin`), and the
dashboard's Domain list separates them. Production's own rows carry
`play.streetsofprague.com` once the game has moved there, and `streetsofprague.com`
before that and from tabs left open since.

## What is sent

`src/telemetry.ts` sends six kinds of report. `SCHEMA` in `worker/stats.js` lists
every field of each and is the only place the format is defined.

| Report | When | What it holds |
|---|---|---|
| `start` | the game begins after the start screen | renderer (WebGPU, WebGL 2, or the legacy WebGL renderer), graphics card name, graphics setting and level, language, keyboard or touch, new or continued game, browser and its major version, operating system, the site the visitor came from, loading time, screen size, pixel ratio, memory and processor cores as the browser reports them |
| `frames` | the tab is hidden or closed | time played, frames drawn, middle and 95th-percentile frame time, frames over 100 ms and over 250 ms, how often Auto changed the graphics level, map tiles that failed to load, how many times Auto kept the level because slow frames were waiting rather than working (the browser or the screen holding the game at 30 frames a second; WebGPU only); the frames over 100 ms by what made them long (below) |
| `play` | with `frames` | seconds on foot, driving, on a tram, in a taxi and on anything else; metres travelled; cars wrecked, people knocked over, arrests, deaths; money; the most stars reached; tickets bought; games saved by hand |
| `activity` | with `frames`, one for each thing done or paid for | `did`: the name of something the player did, how many times, and how many seconds into the session the first time. `spent`: what money went on, how many payments, the first one's time and the amount in Kč |
| `setting` | a setting is changed in the panel, or with G or P | which one and the new value |
| `error` | an uncaught error, a failed start, WebGPU falling back to WebGL, the graphics device being lost | the message and the first lines of the stack; five a session at most, each distinct error once. For a WebGPU startup error that triggers fallback: which step was pending (adapter, renderer module or device), after how long, the animation frames drawn meanwhile, whether the tab was hidden or out of focus, and the graphics card's name; a device that arrives after the fallback is reported with how late it came, and cleanup failures are reported separately with their setup stage |

`frames`, `play` and `activity` hold totals since the start of the session and may be
sent several times (each time the tab is hidden); `seq` counts them and the last one is
the session. Activities that changed since the last time go out together in one request
(`rows`, 40 at most).

### What made a frame long

`src/hitches.ts` puts each frame over 100 ms (`hitches` and `stalls` together) down to
one cause, the part that took at least 40% of it and longer than the others:

| Field | The long part |
|---|---|
| `hitchShaders` | a shader being made: built while drawing the frame before, or three.js's own scripts between frames |
| `hitchTiles` | map tiles: the tiles' update in the frame before (parking, putting tiles in the scene), drawing a tile for the first time, or a worker's reply being put together between frames |
| `hitchDrawing` | drawing the frame without a new shader or tile: mostly uploads to the GPU, or waiting for the browser's GPU process to catch up |
| `hitchGame` | the rest of the game's frame: the simulation and the interface |
| `hitchScripts` | other scripts between frames |
| `hitchGpu` | the GPU's part of the frame before, when nothing on the main thread explains the frame (WebGPU only) |
| `hitchWaiting` | nothing the page ran: the browser, its GPU process, garbage collection or the system |
| `hitchUnknown` | nothing timed, in a browser that doesn't report scripts between frames (Safari, Firefox) |

Scripts between frames come from Chrome's long animation frames, which only Chromium
browsers have; elsewhere their time counts as `hitchUnknown`. Garbage collection inside a
script counts towards that script.

### Activities

An activity is a name and nothing more, so tracking a new one is one line where it
happens and no change to the Worker or the dashboard, which shows whatever names arrive:

- `telemetry.did('rode a tram')` for something that happens at a moment;
- `telemetry.doing('used lane assist', on)` once a frame for something that lasts, which
  counts each time it begins;
- money is counted by itself: `Wallet.take(amount, what)` names what it went on.

Names are lower-case English as a person would say it, with a group in front where there
are several of a kind. Renaming one splits its history in two. What is tracked now:

| Group | Names |
|---|---|
| Vehicles | `drove: car`, `drove: van`, `drove: taxi`, `drove: police car`, `drove: bicycle`, `drove: motorbike`, `drove: lorry`, `drove: articulated lorry`, `drove: bus`, `drove: minibus`, `drove: fire engine`; `rented a shared bike`; `thrown off a bike`; `flew a helicopter`; `took a pedal boat` |
| Public transport | `rode a tram`, `took over a tram`, `opened the tram doors`, `rode the funicular`, `went down into the metro`, `travelled by metro`, `called a taxi`, `rode in a taxi`, `sped up a ride or a wait`, `rode without a ticket`, `ticket inspection`, `ran from the inspector` |
| Driving | `honked`, `used lane assist`, `changed the radio station`, `sprayed the water cannon` |
| Trouble | `crime: knocked someone over`, `crime: took a car from its driver`, `crime: wrecked a car`, `crime: hit the police`, `crime: took a police car`, `crime: took a tram`, `crime: blew up a car`, `crime: blew up a police car`, `crime: ran from a ticket inspector` (each as the police count it, in `Police.crime`); `wanted: 1 star` to `wanted: 5 stars` (each time the level is reached); `arrested`, `killed`, `shot by the police`, `own car caught fire`, `a car blew up nearby` |
| On foot | `jumped` |
| Around the game | `opened the settings`, `saved the game by hand`, `loaded a saved game`, `started a new game from the settings`, `signed up for news`, `sent feedback` |
| Developer panel (`dev: …`) | `dev: opened the panel`, `dev: jumped to a place`, `dev: opened the map`, `dev: changed graphics`, `dev: changed weather`, `dev: changed time of day`, `dev: changed date`, `dev: changed countryside`, `dev: changed speed`, `dev: paused`, `dev: stepped a frame`, `dev: set money`, `dev: set stars`, `dev: healed`, `dev: toggled invincibility`, `dev: toggled the pistol`, `dev: spawned a vehicle`, `dev: set a car on fire`, `dev: left someone hurt`, `dev: back on the road`, `dev: parked a helicopter`, `dev: ran scenarios`. Sessions with any of these have cheated or teleported, so their play totals are not a player's |
| Money (`spent`) | `ticket`, `fine`, `taxi`, `shared bike`, `shared bike left outside a station` |

Every report also carries the game's version and the map data version (see
[versioning.md](versioning.md)), the domain the game was opened on, a random session
number made when the page loads and forgotten when it closes, and the visitor's country
as Cloudflare derives it. There is no cookie and no stored identifier, the IP address is not kept,
and where the player is on the map is never sent.

Players can turn it off under **Anonymous statistics** in the settings; the choice is
remembered in the browser (`localStorage` key `telemetry`). The privacy note at the end
of the credits (`privacy.stats` in `index.html` and `src/cs.ts`) tells players all this;
keep it true when what is sent changes.

## Where it goes

The Worker in front of the static files (`worker/index.js`, which also takes the
newsletter and feedback forms) hands `POST /api/report` to `worker/stats.js`. That
accepts reports only from the game's own pages, drops anything that isn't a known
report, and writes
one row to the Analytics Engine dataset `streets_telemetry`: the report's name,
game version, session, country, domain and map data version in `blob1` to `blob6`, then
the report's text fields from `blob7` and its numbers from `double1`, in the order `SCHEMA` lists them. Add new
fields at the end of a list so rows already stored keep their meaning. Analytics
Engine keeps rows for three months. It has to be enabled once for the account in the
Cloudflare dashboard (Workers, Analytics Engine) before a Worker with the binding will
deploy; the dataset itself appears with the first report. `node scripts/check-worker.mjs`, which every deploy
runs, checks what the endpoint takes and refuses.

## The dashboard

```bash
node scripts/telemetry-dashboard.mjs             # serve the page on http://127.0.0.1:5197 and open it
node scripts/telemetry-dashboard.mjs --static    # write .telemetry/dashboard.html instead (a snapshot)
node scripts/telemetry-dashboard.mjs --sample    # made-up numbers, to see the page
```

The script reads the rows with `cf analytics-engine sql query` and serves one page on this
machine, on `127.0.0.1` only unless you pass `--host`. It reads up to 90 days (`--days`), the
most Analytics Engine keeps. The page holds every report and adds them up itself: buttons for
Today, the last 7, 14 and 30 days and everything, or any two dates; and the three lists
(game version, domain, map data), which narrow everything on the page. A single day is shown
by the hour. A game counts on the day it started, with everything it reported later. Days are
in your time zone. The choice is kept in the page's address. Refresh reads the reports again,
and the page does so every five minutes while it is open and visible. A `--static` file never
refreshes; it is a copy of the moment it was written. Nothing is published.

Reading needs the **Account Analytics: Read**
permission. The `cf` login has it now (checked 2026-11-09; it didn't on 2026-10-01), and
the script uses it when no token is set. Otherwise, create an API token with just that permission for the account, at
<https://dash.cloudflare.com/profile/api-tokens>, and save it in
`~/.config/streets-of-prague/analytics-token`, or pass it as `CLOUDFLARE_API_TOKEN`.
The token can only read analytics; keep it out of the repository all the same.

## Visits (Cloudflare Web Analytics)

Optional. Add the game's domain in the Cloudflare dashboard under Web Analytics (the
`cf` login may not do this either), choose the manual JavaScript setup rather than the
automatic one, so that the switch in the settings governs it, and put the site token in `deploy/web-analytics-token`
(the token is public: it ends up in the page). The next deploy then loads
Cloudflare's cookie-free beacon, behind the same switch in the settings. Its numbers
are in the Cloudflare dashboard, not in the page above.
