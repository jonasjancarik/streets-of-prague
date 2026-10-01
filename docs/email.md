# Email for Streets of Prague

read_when: changing incoming email addresses, mail archival or forwarding; deploying the mail Worker.

`news@streetsofprague.com` and `jonas@streetsofprague.com` receive mail through
Cloudflare Email Routing. Both routes run the separate `streets-of-prague-mail`
Worker (`worker/mail.js`), which saves the complete original MIME message,
including attachments, to the private R2 bucket `streets-of-prague-mail`, then
forwards it to the account's verified destination `jonas.jancarik@gmail.com`.
No catch-all address is enabled. Unknown addresses are rejected.

The bucket has no public domain or public access. Messages are stored as
`news/YYYY-MM-DD/<uuid>.eml` or `jonas/YYYY-MM-DD/<uuid>.eml`, with the envelope
sender, recipient and receipt time in object metadata. Download an object from
the authenticated Cloudflare dashboard to open it in a mail client. There is no
automatic expiry; messages remain until deliberately removed. The Worker rejects
messages larger than 25 MiB and archives before forwarding. Storage errors stop
forwarding; forwarding errors are logged with the archived object's key, and
the archived copy remains available for recovery.

## Deploying the mail Worker

Mail is independent of the game's releases. Use the repository's Node runtime
and authenticated `cf` CLI:

```sh
node scripts/check-mail-worker.mjs
node scripts/build-mail-worker.mjs /tmp/streets-mail-build
cd /tmp/streets-mail-build
export CLOUDFLARE_ACCOUNT_ID=7756b12931ecfb3900a31049e157d706
cf deploy --prebuilt --dry-run
cf deploy --prebuilt
```

The build writes its own temporary Build Output and never replaces the game's
output. The R2 bucket must exist first. Email Routing must be enabled on the
domain, with an exact destination-address rule for each of the two addresses
whose `worker` action names `streets-of-prague-mail`. Keep the Brevo DKIM,
verification and DMARC records when changing mail DNS.

After a change, send one uniquely named test message to each address. Check that
each message appears in Gmail and in the corresponding R2 prefix. This tests
real SMTP delivery as well as archival; the local test uses stand-in messages.

## Sending and replying

These routes provide incoming mail and archival, not an IMAP mailbox or outgoing
SMTP credentials. Brevo sends the newsletter using `news@streetsofprague.com`;
responses to it use the incoming route above. Sending personal mail as
`jonas@streetsofprague.com` requires a separately configured sending provider
and mail client. From January 2027, Gmail removes external-provider “Send as”;
forwarding into Gmail continues to work. See
[Google's notice](https://support.google.com/mail/answer/17101213?hl=en).
