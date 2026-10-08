# Plan 024: The game on play.streetsofprague.com, the homepage on streetsofprague.com

> An implementation plan for another agent. Planned at `c2c7626` on `main`, 2 October 2026,
> from reading the code and two live checks (below). Nothing was deployed or changed at
> Cloudflare while writing it. Check `git status` before you start and commit only your
> own changes.

> Decided differently on 7 October 2026: the root only redirects to `play.`, saved games
> are not carried over, and the homepage stays offline. The phases below are the
> original plan and were not built as written; see Result at the end.

## Status

- State: DONE on 8 October 2026, in the simpler shape decided on 7 October 2026 (Result,
  below): the game is at `play.streetsofprague.com` (release v0.5.5) and the root redirects
  to it. The go-live checklist was deleted once it was done
- Priority: P1 (the homepage in `site/` can't go online before this)
- Effort: about 2 working days, in four phases that can each be released on their own
- Risk: medium. The code changes are small. The risky part is the moment the root
  address changes hands, and what players lose if it is done carelessly: their saved
  games and settings, which the browser keeps per address.
- Depends on: the homepage in `site/` (commits `ef7af1d`, `c2c7626`)
- Category: distribution

## Goal and scope

Today <https://streetsofprague.com> is the game. Afterwards:

| Address | Serves |
| --- | --- |
| `streetsofprague.com` | the homepage (`site/`) |
| `play.streetsofprague.com` | the game, and its `/api/*` (newsletter, feedback, statistics) |
| `beta.streetsofprague.com` | the beta on mbxp, as now |
| `data.streetsofprague.com` | the map on R2, as now |

Nobody who has played at the old address should lose a saved game or a setting, and
links to the game that are already out there (`?start=…`, the newsletter's confirmation
link) should keep working.

Out of scope: a newsletter form on the homepage (phase 5 only prepares for it), any
change to the map bucket or the mail setup, and the mobile apps of plan 020 (their
`/api` addresses are updated here, nothing more).

## What was checked

- `play.streetsofprague.com` has no DNS record yet (`dig +short` returns nothing).
- The map bucket answers every origin: `curl -H 'Origin: https://play.streetsofprague.com'`
  on `https://data.streetsofprague.com/<version>/praha_now/index.json` returns
  `access-control-allow-origin: *`. The map needs no change.
- A saved game is one small JSON object per slot (`src/save.ts`), a few hundred bytes,
  so all of a player's saves and settings fit in a link.

## What is tied to the address today

| Thing | Where | What the move does to it |
| --- | --- | --- |
| Saved games (`save:auto`, `save:hand:*`) and settings (`lang`, `graphics`, `sound`, `mix`, `radio`, `difficulty`, `haptics`, `water`, `anc`, `help-folded`, `beta-note`, `telemetry`) | the browser's localStorage for `streetsofprague.com` | The game at `play.` starts with none of them. This includes `telemetry`: a player who switched the statistics off would be counted again. Phase 2 |
| The Worker's custom domains | `domains` in `scripts/deploy-cloudflare.sh`, `routes` in `wrangler.jsonc` | Edited in phases 1 and 4 |
| Which pages may call `/api/*` | `OTHER_ORIGINS` in `worker/stats.js`; the Worker's own address is always allowed | Nothing to do for the game itself, which calls its own address. The homepage is added in phase 5 |
| The beta's forms and statistics | `https://streetsofprague.com/api/…` three times in `scripts/deploy-mbxp.sh` | Must point at `play.` before phase 4, or the beta's signups, feedback and statistics stop |
| Turnstile (the check that a person is signing up) | the widget's list of hostnames in the Cloudflare dashboard | `play.streetsofprague.com` must be added, or signups there fail with "We couldn't confirm that a person is signing up" |
| The newsletter's confirmation link | `redirectionUrl: ${origin}/?subscribed` in `worker/index.js` | New signups get the right address by themselves. Emails already sent point at the root: phase 3's redirect |
| Links to places in the game | `?start=`, `?place=`, `?area=` and the other options in the README | Would open the homepage. Phase 3's redirect |
| The game installed on a home screen | `start_url` and `scope` in `public/manifest.webmanifest`, relative | An app installed from the root opens the homepage afterwards. Phase 3 sends it on to the game, though with the browser's bar showing until the player installs it again from `play.` |
| Tabs open during the switch | `fetch('version.json')` in `src/update.ts`, and files loaded late from `/assets/` | They stop hearing about new versions, and something loaded late can fail. A reload fixes it. Accepted; do the switch at a quiet hour |
| Statistics by domain | `host` in `worker/stats.js`, the Domain filter in `scripts/telemetry-dashboard.mjs` | The game shows up as `play.streetsofprague.com` from then on. Add a line to `docs/telemetry.md` |
| Cloudflare Web Analytics | `deploy/web-analytics-token` (optional) | A token belongs to one hostname. If it is in use, make one for `play.` and one for the homepage |
| `streets.jonasjancarik.cz` | a Redirect Rule on `jonasjancarik.cz` to `https://streetsofprague.com` | Point it at `https://play.streetsofprague.com` in phase 4 |
| `streets-cf.jonasjancarik.cz` | a custom domain of the Worker | Stays with the game |
| Mail (`MX`, SPF, DKIM, DMARC) | DNS records of the zone | Untouched; they live beside whichever Worker has the root |
| Checks and docs that name the address | `scripts/check-worker.mjs` (`SITE`), the README's Deploying section, `docs/versioning.md`, `docs/telemetry.md`, `.agents/skills/deploy/SKILL.md`, `.agents/skills/player-forms/SKILL.md`, `plans/020-ios-and-android-apps.md` | Updated in the phase that changes what they describe |

## Decisions to confirm with the user before starting

| Question | Default the plan assumes |
| --- | --- |
| Carry saved games and settings over to `play.` | Yes (phase 2). Without it every returning player starts from nothing |
| How the homepage is deployed | By its own script from any pushed commit on `main`, without a release tag. Releases stay what they are: versions of the game |
| Old links to the game at the root | Sent on to `play.` by the homepage (phase 3) |
| `streets-cf.jonasjancarik.cz` | Kept as a second address of the game |
| When to switch | At a quiet hour by the statistics dashboard, and not on the day of a newsletter |

## Approach

Two Workers instead of one. The existing `streets-of-prague` Worker keeps the game and
`/api/*` and moves to `play.`. A new Worker with static files only,
`streets-of-prague-site`, takes the root. A custom domain belongs to one Worker at a
time, which is why the order below matters: `play.` is added first and proven while the
root still serves the game, and the root changes hands last, in one short step that can
be undone by deploying the previous release.

The saved games travel in the link. The homepage runs at the old address, so it can
read what the game stored there. Its Play buttons then carry that along to the game,
which keeps whatever it doesn't already have. An iframe or a request between the two
addresses can't do this: browsers give a page inside another site's frame a separate,
empty storage. A link opened by the player has no such limit.

## Phase 1: the game answers at play.streetsofprague.com too

1. In the Cloudflare dashboard, add `play.streetsofprague.com` to the Turnstile widget's
   hostnames (the player-forms skill says where the widget is).
2. Add `play.streetsofprague.com` to `domains` in `scripts/deploy-cloudflare.sh` and to
   `routes` in `wrangler.jsonc`, keeping the three that are there.
3. In `scripts/deploy-mbxp.sh`, change the three `https://streetsofprague.com/api/…`
   addresses to `https://play.streetsofprague.com/api/…`. Don't deploy the beta until
   step 5 has passed.
4. `scripts/check-worker.mjs`: make `SITE` `https://play.streetsofprague.com` and run it.
5. Release (`scripts/release.sh patch`; production only takes releases), then check:
   - `curl https://play.streetsofprague.com/version.json` names the new release, and the
     game loads there with the map.
   - The two refusals from the deploy skill ("What to check afterwards") answer the same
     with `play.streetsofprague.com` as the address and as `Origin`.
   - A real signup from `play.` with `jonas@streetsofprague.com` goes through, and the
     confirmation link comes back to `https://play.streetsofprague.com/?subscribed`.
   - `https://streetsofprague.com` still works as before.
6. Deploy the beta and send a feedback message from it.

After this phase the game runs at both addresses and nothing has been taken away.

## Phase 2: saved games and settings follow the player

1. **The game takes them in** (new `src/handover.ts`, called from `src/main.ts` before
   anything reads a setting). When the address ends in `#handover=<data>`:
   - decode it (JSON of key and value pairs, base64url);
   - for each pair, write it only if that key isn't in localStorage yet, so a game
     already saved at `play.` is never replaced, and only if the key is one the game
     knows (`save:…` or one of the settings listed above), so a made-up link can't fill
     the storage with anything else;
   - cap the size it accepts (say 200 kB) and ignore anything it can't read;
   - remove the fragment with `history.replaceState`, so a reload or a shared link
     doesn't carry it.
2. **The homepage hands them over** (`site/index.html`). On load, collect every
   localStorage entry at its own address except the homepage's own. If there are any,
   add `#handover=<data>` to both Play buttons. Nothing is deleted at the root: the copy
   there is the fallback if the switch is undone. The homepage's own language choice
   moves to a key of its own (`site-lang`) so it can't be mistaken for the game's.
3. **A check** that fits `scripts/` (a small Node script with a stand-in localStorage, as
   `check-worker.mjs` does for the Worker): a new key is written, an existing one is
   kept, an unknown key and an oversized or broken fragment are ignored.
4. Try it for real before the switch: serve `site/` locally, put a `save:auto` and
   `telemetry=off` into its storage, press Play with the link pointed at a local game,
   and see the saved game offered on the start screen and the statistics still off.

Release the game with step 1 before phase 4. The homepage half waits for phase 3.

## Phase 3: the homepage as its own Worker

1. `scripts/deploy-site.sh`, modelled on `deploy-cloudflare.sh` but much shorter:
   refuse uncommitted changes and unpushed commits, copy the git-tracked files of
   `site/` (not `media.sh`) into a Build Output for a Worker named
   `streets-of-prague-site` with assets only and `workersDev: true`, write a `_headers`
   file (`/media/*` cached for a day, the page itself revalidated), then
   `cf deploy --prebuilt`, with `--dry-run` as in the game's script. No custom domain
   yet.
2. **Old links.** At the top of `site/index.html`, before anything is drawn: if the
   address has any query other than `lang`, or the page runs as an installed app
   (`matchMedia('(display-mode: standalone), (display-mode: fullscreen)')`), replace the
   location with `https://play.streetsofprague.com/` plus the same query, and the
   handover data as the fragment. That covers `?start=…`, `?subscribed` from
   confirmation emails already sent, and home-screen apps installed from the root.
3. Check on the `workers.dev` address: the page and both videos load, `?lang=cs` stays
   on the homepage, `?start=14.42,50.08` and `?subscribed` land in the game with the
   query intact.

## Phase 4: the switch

Do it at a quiet hour. Both halves are ready and proven by now, so this is two deploys
and one rule.

1. Remove `streetsofprague.com` from the game's `domains` and `routes` (keeping `play.`
   and the two `jonasjancarik.cz` names), commit, push and release. Before the real
   deploy, read what `cf deploy --prebuilt --dry-run` says it will do with the domains:
   whether leaving a name out of the list detaches it was not verified while planning.
   If it doesn't, detach the root from the game's Worker in the dashboard.
2. Add `streetsofprague.com` as the custom domain in `scripts/deploy-site.sh` and run
   it. Between steps 1 and 2 the root answers nothing, so have step 2 ready to run.
3. Change the Redirect Rule on `jonasjancarik.cz` so `streets.jonasjancarik.cz` goes to
   `https://play.streetsofprague.com`, keeping path and query.
4. Check:
   - `https://streetsofprague.com` shows the homepage, Play opens the game at `play.`.
   - In a browser that has played at the root: the saved game is on the start screen at
     `play.`, and the language and graphics settings are the old ones.
   - `https://streetsofprague.com/?subscribed` shows the game's "you're signed up" note.
   - `dig +short MX streetsofprague.com` is unchanged, and a test mail to
     `jonas@streetsofprague.com` arrives.
   - The beta still reports statistics and sends feedback.
5. If Web Analytics is in use, add the two hostnames there and put the game's new token
   in `deploy/web-analytics-token`.

**Undoing it:** check out the release before step 1 and run
`scripts/deploy-cloudflare.sh` (after detaching the root from the site's Worker). The
game is back at the root with every saved game still there, because phase 2 copies and
never moves. Checking out a tag changes the branch state: ask the user first.

## Phase 5: afterwards

- Add `https://streetsofprague.com` to `OTHER_ORIGINS` in `worker/stats.js` and to the
  Turnstile widget's hostnames, so a newsletter form on the homepage can post to
  `https://play.streetsofprague.com/api/subscribe`. Its confirmation link then comes
  back to the root with `?subscribed`, which phase 3's redirect passes on to the game.
  The form itself is a separate piece of work.
- Docs, in the same commits as the changes they describe where possible: the README's
  Deploying section (two sites and the homepage's script), `.agents/skills/deploy/SKILL.md`
  (a third row in the table, the new check addresses), `.agents/skills/player-forms/SKILL.md`
  (the `curl` lines, where the beta posts), `docs/versioning.md` and `docs/telemetry.md`
  (the game's address, the new value in the Domain filter),
  `plans/020-ios-and-android-apps.md` (the `/api` addresses), `plans/README.md`.
- After a few months, when nearly everyone who played at the root has been through the
  homepage once, the handover can stay as it is: it costs nothing and still serves
  anyone returning later.

## Risks

- **A player who never passes through the homepage.** Someone who opens `play.` directly
  on a device where they played at the root (from a link a friend sent, say) starts
  fresh there. Their old saves are added the first time they press Play on the homepage,
  without replacing anything made since.
- **Private windows and cleared storage** have nothing to hand over; nothing changes for
  them.
- **The gap in phase 4** between the two deploys. Minutes at most; the map and the beta
  are not affected.
- **Search engines and shared links** to the root now show the homepage instead of the
  game. That is the point of the move, but the homepage's Play button has to stay the
  first thing on it.

## Result

Built on the branch `night-play-subdomain` and gone live on 8 October 2026 with release
v0.5.5 (`GAME_MOVED=yes`); the Turnstile widget got `play.streetsofprague.com`. The owner decided the plan's questions on 7 October 2026,
differently from its defaults, so what was built is simpler than the phases above.

### As decided

| Question | Decided |
| --- | --- |
| Where the game goes | `play.streetsofprague.com` |
| The root, `streetsofprague.com` | Sends people on to `play.` with an ordinary redirect, keeping path, query string and hash. The homepage in `site/` is not put there for now |
| Saved games and settings | Not carried over: nobody has anything important saved yet |
| `streets-cf.jonasjancarik.cz` | Dropped; it was only there for old links |
| When to switch | The owner's choice, by the checklist |

### What was built

- **One Worker at both addresses.** `play.streetsofprague.com` joins the Worker's
  addresses and `streets-cf.jonasjancarik.cz` leaves them (`scripts/deploy-cloudflare.sh`,
  `wrangler.jsonc`).
- **The redirect is the Worker's own**, not a rule set by hand in the dashboard, so it is
  in git, checked by `scripts/check-worker.mjs`, tried locally, deployed by the release
  script and undone the same way. A page asked for at `streetsofprague.com` (or
  `streets.jonasjancarik.cz`) gets a 301 to the same path and query at `play.`. The
  answer names no fragment, which is what makes browsers keep the link's own. It may be
  remembered for an hour, not for good, so that the move can be taken back.
- **`/api` answers at both addresses.** A game left open in a tab since before the move
  keeps posting to the address it was loaded from, and that keeps working. So do its
  files and its check for a newer version: only `/api/*` and `/` run the Worker
  (`runWorkerFirst`), and everything else is served from the assets at either address.
  That also keeps Worker requests to one per visit.
- **A switch, `GAME_MOVED` in `deploy/address`**, empty as committed. Empty, the game is
  at the root and `play.` is a second address; `yes` turns the redirect on and points the
  beta's forms and statistics at `play.`. Merging and releasing therefore move nothing:
  the move is its own one-line commit, made once `play.` is seen to answer. This is what
  removes the ordering hazard of the first version of this branch, where the beta could
  not be deployed between the merge and the release.
- **Checks:** `scripts/check-worker.mjs` (the redirect, `/api` at the old address, one
  address's page refused at the other's `/api`), now also run by `scripts/release.sh`
  before the tag exists; `scripts/local-two-hosts.sh` with `scripts/check-two-hosts.mjs`
  (the Worker under `wrangler dev` as both addresses).
- **Docs:** the README's Deploying section, `docs/versioning.md`, `docs/telemetry.md`,
  the deploy and player-forms skills, plan 020's `/api` address. The homepage's copy in
  `site/index.html` was read as a visitor and four lines were reworded, in English and
  Czech.

### What was taken out again

The first version of this branch (5 to 6 October, for the plan's defaults) carried saved
games over and gave the homepage its own Worker. With the decisions above that went:
`src/handover.ts` and its import, the handover script in `site/index.html`,
`scripts/check-handover.mjs`, `scripts/deploy-site.sh`, `site/_headers`,
`site/_redirects`, the two domain lists with `scripts/check-domains.mjs`, and the
two-site local trial. The homepage's deploy script was removed too, not kept for later:
it was never dry-run against Cloudflare, and it has no address to deploy to until the
homepage's place is decided. All of it is in the branch's history (the commits before
"Plan 024 as decided").

### Verified, and not

Verified locally: `scripts/check-worker.mjs`; the Worker under `wrangler dev` as both
addresses, with the switch on (301 with the query kept, files and `/api` at both, the
game at `play.`) and off (the game at both); the deploy script's Worker configuration
against the schema in the installed `cf`'s own packages, offline.

Not verified, because it needs Cloudflare: `cf deploy --prebuilt --dry-run` with the new
address and the second `runWorkerFirst` pattern; that a new custom domain gets its DNS
record and certificate by itself; whether leaving `streets-cf.jonasjancarik.cz` out of
the list detaches it (the checklist says where to look); the Turnstile widget's
hostnames; the Redirect Rule on `jonasjancarik.cz`. That a browser keeps the `#fragment`
across the redirect is standard behaviour (RFC 9110, section 10.2.2) and is one of the
checks after the move; it could not be tried locally, because the redirect names the
real `https://play.streetsofprague.com`.
