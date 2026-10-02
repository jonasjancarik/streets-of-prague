# Plan 020: iOS and Android apps

> An implementation plan for another agent. Planned at `c0a603a` on `main`, 2 October 2026,
> from reading the code. Nothing was installed, built or run while writing it. The working
> tree then had someone else's uncommitted changes in `index.html` and
> `.claude/launch.json`. Check `git status` and `git diff` before you start, don't revert
> changes you didn't make, and commit only your own hunks.

## Status

- State: PLANNED
- Priority: P2
- Effort: about 10–14 working days across eight phases, plus store review time
- Risk: medium. The web game stays the only codebase and almost all new code sits in
  one new module and two generated native projects. The uncertain parts are named in
  each phase with a check to run first: whether the app's page origin gets WebGPU and
  module workers, whether iOS allows more than 60 frames a second without a private
  setting, and whether the wrapper helps the 2017 iPad's sound at all.
- Depends on: nothing. The iPad sound work on branch `ipad-audio` is separate; phase 2
  says how the two meet.
- Category: distribution

## Goal and scope

Ship the game as an app for iPhone (including the folding one), iPad and Android, built
from the same `vite build` as the website, to get three things the browser can't give:

1. **Sound that works on iOS**: not muted by the silent switch, no tap needed to start
   it, and back on after a call or a trip to the home screen.
2. **Frame rate above 60** on screens that can show it.
3. **Playing without a connection**, for players who choose to download the map. Everyone
   else gets the map streamed as in the browser.

New versions of the game and of the map reach the app by themselves, the way they reach
the website, without a store release. A store release is needed only when the native
part changes.

Out of scope: a rewrite of the mixer in native code, a desktop app, in-app purchases,
push notifications, accounts, and any change to how the website is built or deployed.

## Decisions to confirm with the user before starting

Each has a default the plan assumes. Ask once, at the start.

| Question | Default |
| --- | --- |
| App identifier | `com.streetsofprague.app` (can't be changed after the first store upload) |
| Map on the device | Streamed as in the browser. "Download for offline play" is an option in the settings and on the start screen (decided by the user, 2 October 2026) |
| Updates | The game and the map update themselves, without a store release (decided by the user, 2 October 2026) |
| Updating a downloaded map | Automatic on Wi-Fi; on mobile data the app asks first, since a map is about 650 MB |
| Should the game silence the player's own music | Yes (`.playback`, not mixed). The game has its own radio |
| Radio stations in a store app | Keep them, as on the web; the streams are the stations' public ones. Flag it in the review notes |
| Newsletter signup in the app | A button that opens the website's form in the system browser (Turnstile is tied to the site's hostname) |
| Developer accounts | The user's own Apple Developer and Google Play accounts; the user does the signing and the uploads |

## Approach

[Capacitor](https://capacitorjs.com) wraps the built site in a native project for each
platform (`ios/`, `android/`), both committed. The page is served from inside the app at
`capacitor://localhost` on iOS and `https://localhost` on Android, so `fetch`, the tile
workers and the audio files keep their relative URLs.

Do the usual health check on Capacitor and every plugin before adding it (current major
version, recent releases), and use the newest stable major.

Everything the game does differently in the app goes through one new file,
`src/native.ts`, which exports `isApp` (`Capacitor.isNativePlatform()`) and the few
functions below. Other modules ask it; they don't import Capacitor themselves. On the
website every one of those functions does nothing, and the web bundle must not grow by
more than Capacitor's small core.

A separate build keeps the web output untouched:

- `npm run build:app` runs `vite build --mode app --outDir dist-app`, with `.env.app`
  setting `VITE_SUBSCRIBE_URL` and `VITE_FEEDBACK_URL` to the full
  `https://streetsofprague.com/api/…` addresses.
- `VITE_DATA_URL` is the same versioned R2 address the Cloudflare build uses
  (`scripts/deploy-cloudflare.sh`), so the app streams the map exactly as the website
  does and no map data goes into the app. Each build of the game therefore names the map
  it goes with, as `docs/versioning.md` already describes.
- R2 must answer requests from the app's two origins (`capacitor://localhost` and
  `https://localhost`). Add them to the bucket's CORS rules; that is a production
  change and needs the user's go-ahead.
- `capacitor.config.ts` points `webDir` at `dist-app`. `npx cap sync` copies it across.

## Phase 1: the shell on iOS (about a day)

1. Add Capacitor, create `capacitor.config.ts`, `src/native.ts`, the `build:app` script
   and the `ios/` project. Add build outputs (`dist-app`, `ios/App/Pods`,
   `ios/App/build`, `android/app/build`, `android/.gradle`) to `.gitignore`.
2. Confirm the map streams from R2 in the app as it does on the website. With no
   connection and no downloaded map, the start screen says so plainly instead of
   failing on the first fetch.
3. Run it in the iPhone and iPad simulators and on a real device, and check these before
   going further. Each one decides something later in the plan:
   - `isSecureContext` is true and `navigator.gpu` exists, so
     [src/renderer.ts](../src/renderer.ts) picks WebGPU as it does in Safari. If not,
     try serving the page under an `https` scheme name on iOS (`server.iosScheme`).
   - The module worker in [src/tileWorkers.ts:40](../src/tileWorkers.ts) starts and
     tiles load, including the `.gz` files.
   - The console is free of errors that the website doesn't have.
4. Hide the status bar and the home indicator, keep the screen awake while playing, and
   open outside links (credits, licences) in the system browser.

**Stop if** WebGPU or the workers can't be made to run from the app's origin. Report what
was tried; the fallback (loading the live site in the web view) loses offline play and
needs the user's decision.

## Phase 2: sound on iOS (one to two days)

1. In the iOS project, set the audio session to `.playback` and activate it when the app
   becomes active. Confirm the web view is configured so media needs no tap
   (`mediaTypesRequiringUserActionForPlayback = []`; Capacitor is believed to set this
   already, so check before adding it).
2. In [src/audio.ts](../src/audio.ts), `start()` currently waits for the first key or
   touch (lines 175–179). In the app, call it as soon as the game loads.
3. Coming back: listen for the app returning to the foreground (Capacitor's App plugin)
   and for the audio session's interruption-ended notification, and resume the context
   in both cases. WebKit also has a context state of `interrupted`; treat it like
   `suspended`. The existing `visibilitychange` handler stays.
4. The radio ([src/radio.ts](../src/radio.ts)) is an `<audio>` element fed through Web
   Audio. Check it starts without a tap too, and goes quiet without an error when there
   is no connection.
5. Test on real devices, since the simulator doesn't reproduce the faults: silent switch
   on, a phone call or Siri mid-game, home screen and back, headphones plugged and
   unplugged, Bluetooth.
6. Try the 2017 iPad (iOS 16). The fault there is a running context whose clock never
   moves, and the app uses the same engine, so it may be unchanged. Record the result in
   this plan either way. If it is unchanged, the work stays on branch `ipad-audio`; a
   native mixer is a separate plan and not part of this one.

The same session setting exists on the web as `navigator.audioSession.type = 'playback'`
(Safari 16.4 and later). Adding it to the website is a one-line follow-up worth doing
whether or not the app ships.

## Phase 3: one layout for phone, fold and tablet (about a day)

The HUD already keeps clear of notches with `env(safe-area-inset-*)` in `index.html`.
What's new is the window changing size while the game runs.

1. iOS: one universal target, every orientation allowed, resizable on iPad (no
   "requires full screen"). A folding phone opening is a resize like any other.
2. Check the renderer, the camera's aspect and the touch controls follow a `resize`
   that arrives mid-game, with no reload and no stretched picture. Fix in the game, for
   the web too.
3. Check the layout at phone portrait, phone landscape, a near-square opened fold, iPad
   full screen, and iPad split view at one third. Take a screenshot of each for the
   Result section. The touch stick and buttons must stay reachable by thumbs on the
   wide layouts, not drift to the middle.
4. Hide what makes no sense in an app: any "add to home screen" hint and the beta
   signup note, per the decision above.

## Phase 4: downloading the map for offline play (two to three days)

Streaming stays the default. A player who wants to play without a connection chooses
"Download the map for offline play". `praha_now` is 655 MB in about 37 000 files;
fetching them one by one is too slow and too fragile, so the download is one pack.

1. **Make the pack when the map is uploaded.** Extend `scripts/upload-data.sh` to also
   write `praha.zip` (stored, not compressed again: the big files are already gzipped)
   and its checksum and size beside each map version in R2. Update `docs/versioning.md`
   and the deploy skill in the same commit.
2. **A small native plugin of our own, `MapStore`,** in both projects: download a pack
   to a temporary file with progress, able to resume after the app is closed; verify the
   checksum; unpack it into a folder named after the map version in the app's support
   directory; mark that folder as not backed up to iCloud; report free space; delete old
   versions. On Android `java.util.zip` is enough; on iOS use ZIPFoundation (health-check
   it first).
3. **Point the game at it.** `base` in [src/data.ts](../src/data.ts) is fixed when the
   bundle is built. Make it settable once before the first fetch. `native.ts` sets it to
   the unpacked folder's address (Capacitor's `convertFileSrc`, which stays on the page's
   own origin) when the map version this build wants is on the device, and leaves it at
   the R2 address otherwise. Make sure the tile workers get the same base.
4. **The screen for it.** In the settings and on the start screen: "Download the map for
   offline play (650 MB)", with a progress bar, pause and resume, a warning on mobile
   data, a clear message when there isn't room, and "Remove the downloaded map" once it
   is there. The game stays playable (streamed) while it downloads. Write the copy from
   the player's point of view, in both languages (`src/cs.ts`).
5. **Without a connection:** live weather ([src/liveweather.ts](../src/liveweather.ts))
   falls back to the built-in weather, the radio is off, feedback says it needs a
   connection and keeps the text, and telemetry drops its reports quietly. Test with
   the device in aeroplane mode from a cold start.

Considered and left out: Apple's On-Demand Resources and Google's Play Asset Delivery
(two mechanisms to build and a store release for every map change), and a service
worker cache (the system may evict it, and it isn't needed inside an app).

## Phase 5: updates without a store release (two days)

The app carries the game's build that was current when it went to the store, and
replaces it with newer ones from the game's own server. Both stores allow this for
JavaScript run by the web view, as long as the app stays the same kind of app.

1. **Publishing.** `scripts/deploy-cloudflare.sh` (production) also builds the app's
   bundle, zips `dist-app`, and uploads it with a small file at a fixed address (the `version.json`
   that step 2 already publishes at the site root, with the app's address, checksum and
   shell number added to it):
   the newest build's version, its address and checksum, the map version it goes with,
   the oldest map version it can still play with (step 2), and the lowest **shell
   number** it can run on. The shell number is a whole number in
   `src/native.ts` and in both native projects, raised whenever the native side changes
   in a way the game's code relies on (a new `MapStore` method, for instance).
2. **Recording which builds need a newer map.** *Done in a5a6764 (with `version.json`,
   `deploy/data-history`, `deploy/data-oldest` and `scripts/check-data-versions.mjs`;
   the check that `data-oldest` rose with the format number was left out: the check
   against R2 catches a map in the wrong format).* Today a commit records one thing about
   the map: `deploy/data-version`, the map it goes with. Add `deploy/data-oldest`, the
   oldest map version this code still plays correctly with, committed the same way so
   every tag carries it. Most game updates leave it alone. Raise it in the same commit
   as any code that can't do without newer map files: always when `FORMAT` and
   `DATA_FORMAT` rise, and also when code starts relying on a file or field that older
   maps lack and has no fallback for. Then:
   - `scripts/deploy-cloudflare.sh` and `scripts/release.sh` refuse to go on if
     `data-oldest` is newer than `data-version`, or if `DATA_FORMAT` changed since the
     previous tag and `data-oldest` didn't.
   - `scripts/release.sh` puts one line into the release notes: "Needs map X or newer"
     when `data-oldest` rose since the previous tag, "Works with maps from X" otherwise.
     That makes the list of GitHub releases the record of which updates needed a new map.
   - Comparing two versions needs their names to sort in upload order. Check that the
     names `scripts/upload-data.sh` gives do (a second upload on one day included), and
     fix the naming if not.
   - Describe all of this in `docs/versioning.md` beside the existing three numbers.
3. **Fetching and switching.** Use `@capgo/capacitor-updater` in its self-hosted, manual
   mode, so nothing goes through a third party's service (health-check it first; if it
   doesn't hold up, Capacitor's own `setServerBasePath` and `MapStore`'s download and
   unpack do the same job). On launch with a connection: read `version.json`; if there is a
   newer build that this shell can run, download it in the background and switch to it
   at the next start, never in the middle of a game.
4. **Falling back.** A new build must tell the app it started properly (the plugin's
   `notifyAppReady`, called once the start screen is up). If it doesn't, the app goes
   back to the build that last worked and doesn't try that version again.
5. **Too old a shell.** When the newest build needs a higher shell number, the app keeps
   its current build and says, once, that a newer version is in the App Store or on
   Google Play.
6. **The map for players who stream it** needs nothing more: a new build names its map
   version and streams that one.
7. **The map for players who downloaded it.** Two cases, told apart by step 2's record:
   - *The downloaded map is still new enough for the new build.* Switch to the build at
     the next start and keep playing on the map already on the device. The newer map
     is fetched in the background (straight away on Wi-Fi; on mobile data the settings
     show "A newer map is available (650 MB)") and takes over at a later start.
   - *The new build needs a newer map.* Download the pack as well (straight away on
     Wi-Fi, after asking on mobile data) and switch build and map together at the next
     start once both are complete. Until then the app keeps the old build with the old
     map, so offline play never breaks.

   Delete the old map only after the new one has been used successfully.
8. **Keep old builds reachable.** An app that hasn't been opened for months must still
   find its map: don't delete a map version from R2 while any published store release
   ships a build that names it. Write this into `docs/versioning.md`.
9. Test the whole path with two real builds: update, restart, see the new version in the
   settings panel; a deliberately broken build falls back; a build needing a higher
   shell number is refused; both cases of step 7, the second with aeroplane mode switched
   on halfway through the download.

A map change means a second 650 MB download for players with the offline map, though
only a build that needs the newer map makes them wait for it. The map changes rarely,
so this plan accepts that; packs holding only the changed tiles are a
possible follow-up.

## Phase 6: Android (one to two days)

1. Add the `android/` project. Confirm the web view lets sound start without a tap, and
   that folding, unfolding and rotating don't restart the activity (the manifest's
   `configChanges` must cover screen size and layout).
2. Full-screen immersive mode, and drawing into the camera cut-out area so the safe-area
   insets apply.
3. Android's web view is the system's Chrome engine, so WebGPU depends on the device.
   Check the Pixel 5 and at least one cheaper phone; the WebGL fallback in
   [src/renderer.ts](../src/renderer.ts) must take over cleanly where WebGPU is missing.
4. Implement `MapStore` for Android and repeat phase 4's offline test and phase 5's
   update test.
5. Test in the resizable and folding emulators at the same sizes as phase 3.
6. With no phone attached, copy the built APK to the Google Drive `projects` folder for
   the user to install.

## Phase 7: frame rate (half a day to a day)

Measure first. Add the measured `requestAnimationFrame` rate to the settings panel's
build line (or the existing telemetry) so it can be read on a device.

1. **Android:** the web view should already follow the screen (90 Hz on the Pixel 5).
   If it reports 60, ask for the highest display mode in `MainActivity`.
2. **iOS:** add `CADisableMinimumFrameDurationOnPhone` to `Info.plist` and measure on a
   120 Hz iPhone and iPad. WebKit holds pages to 60 by its own preference, and this key
   may not lift that.
3. **Stop if** the only way to pass 60 on iOS is a non-public web view setting. That can
   get an app rejected, so report the measurement and let the user decide. Don't ship it
   on your own.
4. If a higher rate is reached, check the simulation is unchanged at 120 (car handling,
   pedestrian speed, chase timing) with a scenario from `scenarios/`, and add a 60/120
   choice to the settings, since double the frames costs battery and heat. Use the
   performance skill for anything about frame cost.

## Phase 8: store release (one to two days of work, then waiting)

Signing, uploads and store listings are done by the user or with their explicit go-ahead
each time. Prepare, don't publish.

1. Icons and launch screens from the existing `public/icon-*.png` artwork; app version
   taken from the git tag as `vite.config.js` already does.
2. `scripts/release-app.sh`: build, sync, and produce the iOS archive and the Android
   bundle. Document it in `docs/versioning.md` and the deploy skill: a store release is
   needed only when the shell number rises or the native projects change; everything
   else goes out with the normal production deploy.
3. Credits reachable inside the app: IPR Praha (CC BY), OpenStreetMap, the sound
   recordings, and `licenses.txt`.
4. Store paperwork to draft for the user: privacy answers (telemetry, the email address
   in feedback and newsletter), age rating (cars hitting people, police chases), review
   notes (the map download, the game updating itself, the radio streams), screenshots from phase 3.
5. First to TestFlight and a Play internal test. A new personal Play account must run a
   closed test with 12 testers for 14 days before it can publish, so start that early.
6. The Worker's `/api/feedback` must accept requests from `capacitor://localhost` and
   `https://localhost` (see the player-forms skill). Deploying that change needs the
   user's go-ahead like any production deploy.

## Order

Phases 1 and 2 answer the two biggest unknowns in two to three days, on iOS only; show
the user the result before continuing. Then 3, then 4 before 5 (the updates reuse the
download and unpack code), then 6. Phase 7 can be done any time after 1 and is
independent of the rest. Phase 8 comes last, but open the Play closed test as soon as
phase 6 produces an installable build.

## Checks that apply to every phase

- `npm run build` still passes and `dist` has no Capacitor plugin code beyond the core.
  Load the website build once and confirm the start screen, sound and a short drive.
- `npm run typecheck`.
- One scenario from `scenarios/` through `scripts/scene.mjs` after any change to
  `src/audio.ts`, `src/data.ts` or `src/main.ts`.
- Screenshots of the app in the simulator for anything visible, shown to the user.

## Result

Not started.
