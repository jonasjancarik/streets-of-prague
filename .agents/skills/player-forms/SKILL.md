---
name: player-forms
description: How the newsletter and the feedback form in Streets of Prague work end to end (the forms in the game, the Worker's /api/subscribe and /api/feedback, Brevo, Turnstile, Cloudflare email sending and the domain's mail DNS records), how to set each part up from nothing, and how to change, test and debug them. Use when working on src/newsletter.ts, src/feedback.ts or worker/index.js, when adding another form or /api endpoint, when a signup or a feedback message doesn't arrive, when setting up or rotating the Brevo, Turnstile or email settings, when touching the domain's SPF, DKIM or DMARC records, when sending a newsletter, or when changing what a feedback message carries.
---

# The newsletter signup and the feedback form

Two small forms in the game post to two addresses on production's Worker, and the
Worker passes each on to a service. The game knows only the two addresses; the Worker
stores nothing. This file is how to set the parts up, and how to work on the forms
without sending real email to anyone. Incoming mail for the domain (`news@` and
`jonas@streetsofprague.com`, archived and forwarded to Gmail) is a separate Worker,
described in `docs/email.md`.

| | Signup | Feedback |
|---|---|---|
| In the game | `src/newsletter.ts`: link on the start screen and in the settings | `src/feedback.ts`: link in the settings |
| Posts to | `/api/subscribe` `{ email, lang, token, website }` | `/api/feedback` `{ message, email?, context, lang, website }` |
| Worker passes it to | Brevo's double opt-in API (it sends the confirmation email) | Cloudflare email sending, to the one address in `deploy/feedback` |
| Shown in a build when | `deploy/newsletter` has the list and the template number | `deploy/feedback` has `FEEDBACK_TO` |

## Where things are

- `worker/index.js`: the Worker. `form()` does what both forms need before the body is
  read (own pages only, CORS for the beta, POST only, the rate limit, JSON); `subscribe`
  and `feedback` each return `[answer, status]`. Plain JavaScript with no imports, so
  Node can run it as it is.
- `scripts/check-worker.mjs`: runs that handler in Node with Brevo, Turnstile and the
  email sending replaced by stand-ins. The Cloudflare deploy runs it first.
- `src/newsletter.ts`: the signup form, and the two things the feedback form shares:
  `sheet()` (the dialog frame) and `trapField()` (the hidden field).
- `src/feedback.ts`: the feedback form, the frame counter and the error listeners, and
  `context()`, which gathers what is sent along.
- `deploy/newsletter`, `deploy/feedback`: the settings that aren't secret. Both deploy
  scripts `source` them, so they are shell assignments: no spaces around `=`.
- `scripts/deploy-cloudflare.sh` writes the Worker's `worker.config.json` (the bindings)
  and sets the `VITE_…` values for the build; `scripts/deploy-mbxp.sh` sets the same
  values for the beta, pointing at production's addresses. `wrangler.jsonc` mirrors the
  bindings but isn't what deploys.
- Styles are in `index.html` (`.news…`, `.ls-news`, `.settings-news`); Czech text in
  `src/cs.ts`.

## How a form reaches the game

Nothing shows unless the build was given the form's address:

| Build value | Set when | Effect |
|---|---|---|
| `VITE_SUBSCRIBE_URL` | `BREVO_LIST_ID` and `BREVO_DOI_TEMPLATE_ID` are both filled in | the signup links appear |
| `VITE_FEEDBACK_URL` | `FEEDBACK_TO` is filled in | "Send feedback" appears in the settings |
| `VITE_TURNSTILE_SITE_KEY` | `TURNSTILE_SITE_KEY` is filled in | the signup form loads Turnstile |

Local development has none of them, so `npm run dev` shows no forms. That is on
purpose: a half-set-up form must never reach players.

The beta (mbxp) has no Worker. Its forms post to `https://streetsofprague.com/api/…`,
and the Worker lets the beta's addresses in (`OTHER_ORIGINS`). A new address the game
is served from has to be added there and to the Turnstile widget's hostnames.

## Setting up, once

Each part below says how to see whether it is already in place; check before doing
anything again. Steps marked *not yet seen* are written from the services'
documentation, not from having been done on this project: correct them when they are.

### The domain's mail records

One domain serves three mail jobs, and their DNS records live side by side in the
`streetsofprague.com` zone at Cloudflare:

| Record | Belongs to | Check |
|---|---|---|
| `MX` to `route*.mx.cloudflare.net` and the root `TXT` `v=spf1 include:_spf.mx.cloudflare.net ~all` | Cloudflare Email Routing (incoming mail) | `dig +short MX streetsofprague.com` |
| Root `TXT` `brevo-code:…` | Brevo's proof the domain is ours | `dig +short TXT streetsofprague.com` |
| `CNAME` `brevo1._domainkey` and `brevo2._domainkey` to `…dkim.brevo.com` | Brevo's DKIM signatures | `dig +short CNAME brevo1._domainkey.streetsofprague.com` |
| `TXT` `_dmarc` (`v=DMARC1; p=none; rua=…brevo.com`) | DMARC for the whole domain | `dig +short TXT _dmarc.streetsofprague.com` |

- A domain has one SPF record. If a service ever asks for its own, add its `include:`
  to the existing record; a second `v=spf1` record breaks both. Brevo's setup here did
  not ask for one.
- The DKIM `CNAME`s must be "DNS only" in Cloudflare (grey cloud), not proxied.
- Keep all of these when changing any mail setting; `docs/email.md` says the same from
  the incoming side.
- Cloudflare email sending (for feedback) adds records of its own when it is turned
  on. *Not yet seen*: which ones.

### The newsletter (Brevo)

1. **Sender.** The newsletter is sent as `news@streetsofprague.com`; replies come back
   through the incoming route for that address. In Brevo it is under Senders, domains &
   dedicated IPs.
2. **Domain.** Authenticate `streetsofprague.com` in the same place. Brevo lists the
   records to add (the Brevo rows in the table above) and shows the domain as
   authenticated once it has seen them. They are in place.
3. **List.** Create a list for the newsletter; its number goes in `BREVO_LIST_ID`.
4. **Confirmation email.** Create a double opt-in template; its number goes in
   `BREVO_DOI_TEMPLATE_ID`. It has to be a template Brevo accepts for double opt-in:
   Brevo's default double opt-in template is, and one made from scratch needs the
   confirmation link (`{{ doubleoptin }}`) and, per Brevo's documentation, the tag
   `optin` (*not yet seen*). A Czech one is optional: `BREVO_DOI_TEMPLATE_ID_CS`.
5. **API key.** Create one in Brevo (SMTP & API → API keys) and have the user store it
   on the Worker as `BREVO_API_KEY` (the command is under "Settings and secrets").
6. **Language, optional.** Create a text attribute for contacts (say `LANGUAGE`) and
   name it in `BREVO_LANGUAGE_ATTRIBUTE`. Contacts then carry `en` or `cs`. An attribute
   named there that doesn't exist in Brevo may make signups fail (*not yet seen*), so
   create it first.
7. **Turnstile.** Done: the widget and how to manage it are under "Settings and
   secrets". For a new one, managed mode, the hostnames the game is served from, the
   site key in `TURNSTILE_SITE_KEY`, the secret on the Worker.
8. Commit `deploy/newsletter`, release, and have the user sign up with their own
   address. The whole round trip is: the form says "almost done", Brevo's email
   arrives, its link opens the game with "your email address is confirmed", and the
   contact shows in the Brevo list.

All of this is in place since release v0.1.1 (1 October 2026), when the round trip was
run for real with `jonas@streetsofprague.com`: the real Turnstile widget, Brevo's
template 1, delivery to Gmail through the incoming route, the confirmation and the
contact on list 3. The secrets set on the Worker beforehand were still there after the
release replaced it. Still open: a Czech template and the language attribute.

### Feedback (Cloudflare email sending)

1. **A verified address to receive it.** `cf email-routing addresses list` (with
   `CLOUDFLARE_ACCOUNT_ID` set) shows the account's destination addresses and whether
   each is verified. The one incoming mail is forwarded to is. A new one gets a
   verification email from Cloudflare that the user has to click.
2. **Email sending for the domain.** Turn it on in the Cloudflare dashboard (Compute →
   Email Service → Email Sending) for `streetsofprague.com`; it adds its DNS records.
   `cf` can't show its state (its login gets "Unauthorized" there), so look in the
   dashboard. *Not yet seen.* Sending to a verified address of the account is free on
   every plan; to anyone else it needs the paid Workers plan, which is why feedback
   goes to one fixed address.
3. Put the address in `deploy/feedback` as `FEEDBACK_TO`, commit, release, and have the
   user send a message from the settings. It should arrive from
   `feedback@streetsofprague.com` with the game's state under the message, and a reply
   should go to the player's address if they gave one.

### Sending a newsletter

*Not yet seen; correct this after the first edition.* An edition is a campaign in
Brevo, sent from `news@streetsofprague.com` to the list. With the language attribute in
place, write it twice and send each to the segment whose attribute is `en` or `cs`;
contacts from before the attribute have none, so decide which edition they get.
Brevo's free plan sends 300 emails a day, so a list beyond that goes out over several
days or needs a paid plan. Every campaign carries Brevo's unsubscribe link; people who
use it stay in the contacts as unsubscribed and are skipped from then on.

## Checking a change

**The Worker.** `node scripts/check-worker.mjs`. Add a case there for anything the
Worker newly accepts or refuses. Nothing leaves the machine.

**The forms in the browser.** Start a dev server with the values set, on its own port
so the user's running server is left alone:

    VITE_SUBSCRIBE_URL=/api/subscribe VITE_FEEDBACK_URL=/api/feedback \
      VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA PORT=5197 npm run dev

- `1x00000000000000000000AA` is Cloudflare's test site key: it always passes and works
  on localhost. The real key only works on the widget's hostnames.
- There is no `/api` on the dev server, so a real submit gets a 404 and shows the
  "didn't work this time" line: that checks the failure state. For the other states,
  replace `window.fetch` from the page for the one request and read what the form sent
  (`JSON.parse(init.body)`) and what it then says. Answer `{"ok":true}` with 200 for
  success, or `{"error":"email" | "busy" | "check" | "message"}` with 400, 429 or 403.
- The signup link is on the start screen at once. The feedback link is in the settings,
  which exist only once the game has loaded: open `/?go` and wait for
  `#loading.done`. Open the dialogs by calling `.click()` on the link from the page;
  clicking by element reference scrolls the start screen out of place.
- `/?subscribed` shows the start screen as it looks after the confirmation link.
- Stop the server afterwards. If a temporary entry went into `.claude/launch.json` for
  it, take it out again: the file is tracked.

Show the user screenshots of the form states that changed.

**The Worker's layout,** after changing bindings in `scripts/deploy-cloudflare.sh`:
build the output tree in a scratch folder with the `node -e` block from the script and
run `cf deploy --prebuilt --dry-run` there. It lists the bindings it understood. The
shapes it accepts are in the `cf` package's `@cloudflare/config` types
(`OutputWorkerSchema`); a secret is `{ "type": "secret" }` with no value.

**Never** test by sending a real signup or message to an address that isn't the
user's own. A signup with someone else's address sends them an email from the game's
domain.

## After a release

These two requests send no email and tell "set up" from "something is missing":

    curl -s -X POST https://streetsofprague.com/api/subscribe -H 'Origin: https://streetsofprague.com' -H 'Content-Type: application/json' -d '{"email":"nobody"}'
    curl -s -X POST https://streetsofprague.com/api/feedback -H 'Origin: https://streetsofprague.com' -H 'Content-Type: application/json' -d '{"message":""}'

| Answer | Meaning |
|---|---|
| `{"error":"email"}` / `{"error":"message"}` | The Worker is live and that form is set up. |
| `{"error":"unavailable"}` | A setting or secret is missing (below). |
| `{"error":"origin"}` | The `Origin` header isn't one of the game's addresses. |
| `{"error":"busy"}` | More than five requests in a minute from this address: wait. |
| The game's HTML, or a 404 | The Worker isn't deployed; only the assets are. |

The full round trip (the widget, Brevo's email, the link back with `?subscribed`; a
feedback message arriving with its attachment) can only be seen with the user's own
address. Ask them to do it, or do it with their address when they say so.

## When something doesn't arrive

Work down from the game to the service:

1. **No link in the game.** The build didn't get the address: the lines in
   `deploy/newsletter` or `deploy/feedback` are empty, or the build is a local one.
2. **`unavailable` (503).** For the signup: `BREVO_API_KEY` isn't on the Worker, a
   number is missing, or `TURNSTILE_SITE_KEY` is set without `TURNSTILE_SECRET_KEY`
   (the Worker then refuses everything rather than pass signups unchecked). For
   feedback: `FEEDBACK_TO` or the `EMAIL` binding is missing.
3. **`check` (403).** Turnstile refused the token: the page's hostname isn't on the
   widget, the secret belongs to another widget, or the visitor's blocker stopped the
   script. The form says so in words; the player can try again, and the widget is reset
   after every failed try because a token is good once.
4. **`failed` (502).** The service refused. The Worker logs why
   (`Brevo answered …`, `Sending feedback failed: …`): look in the Worker's logs in the
   Cloudflare dashboard. Common causes: a template that isn't a double opt-in one, a
   wrong list number, an attribute named in `BREVO_LANGUAGE_ATTRIBUTE` that doesn't
   exist in Brevo, a feedback address that isn't verified in the Cloudflare account or
   a domain not set up for sending.
5. **200 but no email.** Brevo accepted it: look in Brevo's transactional log and the
   spam folder, and check the sending domain is authenticated there.

## Settings and secrets

| Name | Where | What |
|---|---|---|
| `BREVO_LIST_ID`, `BREVO_DOI_TEMPLATE_ID`, `BREVO_DOI_TEMPLATE_ID_CS` | `deploy/newsletter` | the list, and the confirmation email in English and (optional) Czech |
| `BREVO_LANGUAGE_ATTRIBUTE` | `deploy/newsletter` | optional: the contact attribute that gets `en` or `cs` |
| `TURNSTILE_SITE_KEY` | `deploy/newsletter` | optional: the widget's public key |
| `FEEDBACK_TO`, `FEEDBACK_FROM` | `deploy/feedback` | who gets feedback, and the address it comes from |
| `BREVO_API_KEY`, `TURNSTILE_SECRET_KEY` | secrets on the Worker | never in the repository |

Secrets are the user's to set. Give them the command with a placeholder and let them
paste the key; don't read a key off a dashboard page or ask for it in the conversation:

    CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706 cf workers secrets update <NAME> --worker streets-of-prague --type secret_text --text <key>

It works before the first release too, and a release keeps the secrets that are already
on the Worker. A changed line in `deploy/…` takes effect with the next release
(production) or beta deploy. If a key has been shown anywhere it shouldn't have been,
make a new one in the service, store it, and revoke the old one there.

The Turnstile widget ("Streets of Prague newsletter signup", managed mode) can't be
managed with `cf`: its login has no Turnstile permission. Use the Cloudflare dashboard
(Application security → Turnstile) in a browser the user has signed in to. In the
hostname field, pressing Enter doesn't add a name; pick the suggestion under the field.
When reading the page after creating or opening a widget, take the site key only (the
short key; the secret is the longer one beside it).

## Changing what the forms do

- **Text.** English in the code, Czech in `src/cs.ts` under the same English line.
  Status lines are kept as their English text and translated when shown, so they follow
  a language switch. Write for the player, not about the mechanism.
- **Another problem the Worker can report.** Return `[{ error: '<word>' }, status]`,
  add the word to `PROBLEMS` in the form with its sentence, add the Czech, and a case
  in `check-worker.mjs`. Unknown words fall back to "didn't work this time".
- **More in a feedback message.** Add a line in `context()` in `src/feedback.ts`,
  inside its own `try` if it can throw: nothing gathered there may stop a message. The
  game's state comes in through `extra` (`setupSettings` in `src/settings.ts`) and from
  `window.__test.snapshot()`. The Worker cuts the attachment at 4,000 characters and
  the message at 5,000. Don't add anything that identifies the player beyond what they
  typed.
- **Another form or endpoint.** Add a handler to `FORMS` in the Worker; `form()` gives
  it the checks for free. Use `sheet()` and `trapField()` for the dialog, give the first
  field `autofocus` (or the dialog starts on its close button and Enter closes it), and
  gate the link on a `VITE_…` address the deploy scripts set only when the settings for
  it are complete. `/api/*` is the only path that runs the Worker (`runWorkerFirst`).
- **Turnstile on feedback too.** It was left off on purpose: feedback can only reach
  the author's inbox. If spam shows up, move the `human()` check into `form()` or call
  it from `feedback`, and render the widget in `src/feedback.ts` as the signup does.
- **Moving off Brevo or off email.** Only the body of `subscribe` or `feedback`
  changes. When leaving Brevo, export the contacts with their status and carry the
  unsubscribed ones over as a do-not-email list.

## Limits worth knowing

- The rate limit is five requests a minute for each visitor address, shared by both
  forms. The check script above counts too.
- "Own pages only" stops other websites, not a script that sets the `Origin` header
  itself. Turnstile is what stops scripts; the hidden field catches only the crudest.
- Brevo's free plan sends 300 emails a day, confirmation emails included.
- Feedback is free to send only to an address verified in the Cloudflare account. The
  binding is restricted to `FEEDBACK_TO`, so the Worker can't email anyone else.
