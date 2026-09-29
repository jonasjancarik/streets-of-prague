# Car radio stations

The car radio (`src/radio.ts`, key `N` while driving) plays live internet streams. It is on by default with the first station in `STATIONS`, and the settings panel (Car radio: On/Off) or `N` past the last station turns it off; the choice is kept in `localStorage` under `radio`. A
station is usable only if its stream is served over HTTPS and answers with an
`Access-Control-Allow-Origin` header; without it the browser plays the stream but won't
let Web Audio filter it. Every URL below was checked on 2026-09-29 with

    curl -s -m 5 -o /dev/null -D - -H "Origin: http://localhost:5173" <url>

and returned `200`, an audio content type and `Access-Control-Allow-Origin: *` (unless
noted). Only the header check was made, not a listen. Stations that change their address
or stop allowing other sites will just report "isn't playing right now" in the game.

To add one, put a line in `STATIONS` in `src/radio.ts` and check it the same way.

## In the game

Wave, Radio Beat, Hitrádio Osmdesátka, Hitrádio Devadesátka, Oldies Rádio, Kiss,
Evropa 2, Čas Rock, ČRo Vltava, Radio Paradise (see `STATIONS`).

## Checked, not in the game

| Station | URL | Note |
|---|---|---|
| ČRo Radiožurnál | `https://rozhlas.stream/radiozurnal_mp3_128.mp3` | news and talk |
| ČRo Radiožurnál (other host) | `https://icecast8.play.cz/cro1-128.mp3` | |
| ČRo Dvojka | `https://rozhlas.stream/dvojka_mp3_128.mp3` | Czech pop, programmes |
| ČRo Dvojka (other host) | `https://icecast6.play.cz/cro2-128.mp3` | |
| ČRo Plus | `https://rozhlas.stream/plus_mp3_128.mp3` | talk |
| ČRo Vltava (other host) | `https://rozhlas.stream/vltava_mp3_128.mp3` | in the game from `icecast5.play.cz` |
| Frekvence 1 | `https://ice.actve.net/fm-frekvence1-128` | commercial, adverts |
| Evropa 2 Flashback | `https://ice.actve.net/web-e2-flashback` | |
| Kiss Delta | `https://icecast1.play.cz/kissdelta128.mp3` | |
| Radio 1 | `https://icecast2.play.cz/radio1.mp3` | |
| Signál Rádio | `https://icecast1.play.cz/signal128.mp3` | |
| Rock Radio | `https://ice.abradio.cz/rockradio128.mp3` | |
| Fajn Rádio | `https://ice.abradio.cz/fajn128.mp3` | |
| Hit Rádio Orion | `https://ice.abradio.cz/orion128.mp3` | |
| Metalománie | `https://ice.abradio.cz/metalomanie128.mp3` | |
| Country Radio | `https://icecast2.play.cz/country128aac` | AAC, not every browser plays it |
| Český Impuls | `https://stream.sepia.sk/ceskyimpuls128.mp3` | CORS only for the origin that asked, so check it from the deployed site |

## Did not work

| Station | URL tried | Result |
|---|---|---|
| Radio Blaník | `https://playerservices.streamtheworld.com/api/livestream-redirect/RADIO_BLANIK.aac?gdpr=0` | redirect only, the stream behind it was not checked |
| Rock Radio (streamtheworld) | `https://playerservices.streamtheworld.com/api/livestream-redirect/ROCK_RADIO_128.mp3` | same |
| Radio Depeche Mode | `https://ice.abradio.cz/depeche128.mp3` | 404 |
| Radio Humor | `https://ice.abradio.cz/humor128.mp3` | 404 |
| SomaFM (Groove Salad, Space Station) | `https://ice1.somafm.com/groovesalad-128-mp3` | no answer from the machine that checked; try from a browser |

Station lists come from the community directory at radio-browser.info
(`/json/stations/search?countrycode=CZ`).
