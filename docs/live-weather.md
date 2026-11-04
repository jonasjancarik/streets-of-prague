# Live weather

Read when changing `src/liveweather.ts`, the weather's following in `src/weather.ts`,
or `worker/weather.js`, or when deciding where the real weather comes from.

## What the game does

The start screen offers "Live: …", the weather in Prague at the moment, for today's
date, right after Clear, which is picked by default. A game begun with it keeps following the real weather: it asks again every ten
minutes (`LIVE_EVERY`), and the game's weather moves to each report over a few minutes
(`LIVE_CHANGE`, a sixth of the usual pace, so clouds gather before the rain as they do
otherwise). While reports keep coming the game doesn't roll its own weather. After 45
minutes without one (`LIVE_LASTS`: no network, the tab asleep) it changes by itself
again until the next report. Picking a weather by hand (the settings, <kbd>P</kbd>,
the developer panel, `?weather=`) ends the following for that game. A continued save
does not follow: its weather is the save's own.

Reports expire by wall-clock time, including time paused in the settings or with the
tab asleep. A manual choice made while a request is pending stays selected when the
response arrives. Unrecognised or malformed weather codes count as unavailable.

`node scripts/check-live-weather.mjs` checks all of it without a browser or network.
`node scripts/check-live-weather-requests.mjs` also checks source failures, fallbacks,
retries and delayed responses with request fixtures.

## Sources

**Open-Meteo** (`api.open-meteo.com`, no key) is what the game asks unless told
otherwise. Its free API is for non-commercial use only.

**ČHMÚ's open data** (the Czech Hydrometeorological Institute,
<https://opendata.chmi.cz>, CC BY 4.0: any use with the source named), looked at on
5 October 2026:

- `/meteorology/climate/now/data/` holds, for each of about 470 stations and each of
  the last few days, a `10m-<WSI>-<YYYYMMDD>.json` and a `1h-<WSI>-<YYYYMMDD>.json`
  (days in UTC), rows of station, element, time, value, flag, quality. The hourly file
  gets its newest hour about twelve minutes past it. Station names are in
  `/meteorology/climate/now/metadata/meta1-<date>.json`.
- The 10-minute files have temperature, humidity, pressure, wind, precipitation
  (`SRA10M`) and sunshine: no cloud and no weather code, so they can tell rain from
  dry and nothing more.
- The hourly files of the professional stations add what is needed: the present
  weather code `ww` (WMO table 4677 from an observer; 4680 plus 100 from an automatic
  sensor; 508 when there is nothing to report), the cloud cover `N` in eighths, the
  visibility `VV` in km and the hour's precipitation `SRA1H`.
- In Prague: Ruzyně (`0-20000-0-11518`, the airport) reports all of these round the
  clock. Libuš (`0-20000-0-11520`) reports the code and visibility, its cloud cover
  only by day. Karlov (`0-20000-0-11519`, the nearest to the centre) has no code,
  cloud cover or visibility at all, and Klementinum none of the hourly elements.
- The files carry no CORS header and are 60–70 kB a station a day, so the game can't
  read them itself.
- There is no forecast or "current conditions" product for a place in the open data;
  radar and satellite are there as images.

So ČHMÚ can give Prague's current conditions, hourly, from Ruzyně, through a small
proxy. That is `worker/weather.js`: `GET /api/weather` answers
`{ kind, at, station, source }`, reading Ruzyně's hourly file (Libuš's if that fails),
kept at Cloudflare's edge for ten minutes.

Differences from Open-Meteo to expect: it is one station at the city's western edge,
11 km from the centre and 170 m higher (fog and snow there are not always fog and snow
by the river), and it is an hour's observation, not a model's blend.

## Turning the ČHMÚ source on

It is written and not deployed. Both of these are needed:

1. The Worker's setting `WEATHER_SOURCE=chmi` (a var in `wrangler.jsonc` or the
   dashboard). Without it `/api/weather` answers 404.
2. The game built with `VITE_WEATHER_API=/api/weather` (for the beta, which has no
   Worker of its own, the full address on the production domain: the route allows any
   origin).

The game then asks its own address first and Open-Meteo when that fails. The credits
must name ČHMÚ as the source once it is on (CC BY 4.0), and the privacy note's list of
services asked during play changes with it.

Not done yet: the route has only been run through its functions in Node
(`check-live-weather.mjs`), not in the Workers runtime (`caches.default`) or against
the live files for more than two days of observations.
