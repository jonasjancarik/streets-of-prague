---
read_when: moving the game to play.streetsofprague.com, or undoing that
---

# Going live: the game on play.streetsofprague.com

The checklist for plan 024 (`plans/024-game-on-play-subdomain.md`), as decided on
7 October 2026: the game moves to `play.streetsofprague.com`, and `streetsofprague.com`
sends people on to it. Saved games are not carried over, the homepage in `site/` stays
offline for now, and `streets-cf.jonasjancarik.cz` is dropped.

Nothing has been deployed, and nothing at Cloudflare was read or changed while preparing
this. Delete this file once step 5 is done.

## How it works

One Worker, `streets-of-prague`, answers at both addresses. A switch in `deploy/address`
decides which of them is the game:

- `GAME_MOVED=` (empty, as committed): the game is at `streetsofprague.com`, and
  `play.streetsofprague.com` shows the same game. Nothing changes for anyone.
- `GAME_MOVED=yes`: the game is at `play.streetsofprague.com`. A page asked for at
  `streetsofprague.com` gets a 301 to the same path and options at `play.`; the browser
  carries a `#fragment` over by itself. `/api` and the game's files keep answering at the
  old address, so a game left open in a tab keeps working until it is reloaded. The beta
  posts its forms and statistics to `play.` from its next deploy.

Because of the switch, merging the branch and releasing move nothing by themselves: the
first release only adds the second address. The move is a one-line commit and a release,
and so is taking it back.

To try it on this machine first (optional, no Cloudflare involved):

    scripts/local-two-hosts.sh          # the Worker as both addresses, on :5311 and :5312; Ctrl-C stops both
    node scripts/check-two-hosts.mjs    # in another terminal

## Step 1: Turnstile (dashboard)

Before step 3, or the signup form at the new address answers "We couldn't confirm that
a person is signing up".

Application security → Turnstile → "Streets of Prague newsletter signup" → Settings →
Hostname Management: add `play.streetsofprague.com`. (A widget that lists
`streetsofprague.com` covers its subdomains by Cloudflare's documentation; that wasn't
tried on this widget, so add it anyway.) Pressing Enter doesn't add a name: pick the
suggestion under the field. Remove `streets-cf.jonasjancarik.cz` if it is listed; leave
`streetsofprague.com`, which open tabs still use.

## Step 2: the game answers at play.streetsofprague.com too

1. Merge the branch into `main`, push, `cf auth whoami` (the login expires), then
   `scripts/release.sh minor`. The deploy attaches `play.streetsofprague.com` to the
   Worker, which also creates its DNS record.
2. Check (the certificate of a new address can take a few minutes):
   - `curl https://play.streetsofprague.com/version.json` names the new release, and the
     game loads at <https://play.streetsofprague.com> with the map.
   - The forms and the statistics answer there:

         curl -s -X POST https://play.streetsofprague.com/api/subscribe -H 'Origin: https://play.streetsofprague.com' -H 'Content-Type: application/json' -d '{"email":"nobody"}'     # {"error":"email"}
         curl -s -X POST https://play.streetsofprague.com/api/feedback -H 'Origin: https://play.streetsofprague.com' -H 'Content-Type: application/json' -d '{"message":""}'           # {"error":"message"}
         curl -s -o /dev/null -w '%{http_code}\n' -X POST https://play.streetsofprague.com/api/report -H 'Origin: https://play.streetsofprague.com' -d '{"e":"nope"}'                   # 400

   - A real signup at `play.` with `jonas@streetsofprague.com` goes through, and the link
     in the email comes back to `https://play.streetsofprague.com/?subscribed`.
   - <https://streetsofprague.com> still shows the game, as before.

To take it back: nothing needs to be; the extra address harms nothing.

## Step 3: the move

At a quiet hour by `node scripts/telemetry-dashboard.mjs`, and not on the day of a
newsletter.

1. In `deploy/address`, set `GAME_MOVED=yes`. Commit, push, `scripts/release.sh patch`.
2. Check:
   - `curl -sI 'https://streetsofprague.com/?start=14.42,50.08'` answers `301` with
     `location: https://play.streetsofprague.com/?start=14.42,50.08`.
   - In a browser, <https://streetsofprague.com/?lang=cs#x> ends at
     `https://play.streetsofprague.com/?lang=cs#x`, in Czech.
   - <https://streetsofprague.com/?subscribed> ends in the game with its "your email
     address is confirmed" note (confirmation emails already sent point there).
   - `curl -s https://streetsofprague.com/version.json` still answers, and so does
     `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://streetsofprague.com/api/report -H 'Origin: https://streetsofprague.com' -d '{"e":"nope"}'`
     with `400`: tabs left open keep working, and show "A newer version of the game is
     available"; Reload takes them to `play.`.
   - `dig +short MX streetsofprague.com` is unchanged and a test mail to
     `jonas@streetsofprague.com` arrives. (Mail records are not touched.)
3. Deploy the beta (`scripts/deploy-mbxp.sh`) and send a feedback message from it; it now
   posts to `play.`. Until then it posts to the root, which keeps answering.

To take it back: set `GAME_MOVED=` again, commit, push, `scripts/release.sh patch`. The
game is at the root again. A browser remembers the redirect for an hour at most.

Players start without their saved games and settings at the new address: browsers keep
those per address. That was decided, as nobody has much saved yet. The saves are still
in their browsers under the old address, should that ever matter.

## Step 4: the two jonasjancarik.cz names (dashboard)

- **`streets.jonasjancarik.cz`**: `jonasjancarik.cz` → Rules → Redirect Rules: change the
  rule's target from `https://streetsofprague.com` to `https://play.streetsofprague.com`,
  still keeping the path and the query string. Until then its visitors arrive anyway,
  through two redirects instead of one.
- **`streets-cf.jonasjancarik.cz`** is no longer in the Worker's list of addresses.
  Whether a deploy detaches an address that left the list was not tried, so look:
  Workers & Pages → streets-of-prague → Settings → Domains & Routes. If
  `streets-cf.jonasjancarik.cz` is still there, remove it.
  Then choose one of two things for the name:
  - *Recommended:* add it to the same Redirect Rule as `streets.` (the rule's hostname
    condition becomes "is in" both names). The name was given out for a while and a
    dead link costs more than one more name in a rule that exists anyway. A redirect
    rule only works for a name with a proxied DNS record: if removing the custom domain
    removed the record, add `streets-cf` as a proxied `AAAA` record to `100::`.
  - Or delete its DNS record as well, if no link to it is worth keeping. The name then
    stops resolving.

  Check: `curl -sI 'https://streets-cf.jonasjancarik.cz/?start=14.42,50.08'` answers a
  redirect to `play.` with the option kept, or nothing at all, as chosen.

## Step 5: afterwards

- Delete this file and the two pointers to it (`deploy/address`, the deploy skill).
- Set plan 024 to DONE in the plan and in `plans/README.md`.
- Search engines and links follow the 301 by themselves. Use
  `https://play.streetsofprague.com` in new links to the game.
- Cloudflare Web Analytics isn't in use. If it is switched on later, its token belongs
  to one hostname: `play.streetsofprague.com`.
- The homepage in `site/` has no address yet. When it gets one, the Worker's redirect
  for `streetsofprague.com` is what has to give way (`OLD_HOSTS` in `worker/index.js`).
