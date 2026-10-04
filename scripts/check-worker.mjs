// Do the newsletter signup, the feedback form and the statistics (worker/index.js) take
// what they should and refuse the rest? Runs the Worker's handler here with Brevo and the email sending
// replaced by stand-ins, so nothing is sent.
// Usage: node scripts/check-worker.mjs
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const SITE = 'https://streetsofprague.com';
const BETA = 'https://beta.streetsofprague.com';
// What the Worker emailed to a player to confirm, what it sent to Brevo, and what Brevo
// answers; the same for Turnstile's check.
let confirmations = [], sent = [], checked = [];
const newsMailer = { send: async (m) => { confirmations.push(m); return { messageId: 'x' }; } };
const env = { BREVO_API_KEY: 'test-key', BREVO_LIST_ID: '7', CONFIRM_SECRET: 'secret-for-links', NEWS_FROM: 'news@streetsofprague.com', NEWS_EMAIL: newsMailer, ASSETS: { fetch: async () => new Response('asset') } };
let answer = () => new Response('{}', { status: 201 });
let verdict = () => new Response('{"success":true}');
globalThis.fetch = async (url, init) => {
  if (String(url).includes('turnstile')) { checked.push(JSON.parse(init.body)); return verdict(); }
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return answer();
};
console.error = () => {};

const post = (body, { origin = SITE, method = 'POST', e = env, path = '/api/subscribe' } = {}) => {
  confirmations = []; sent = []; checked = [];
  return worker.fetch(new Request(`${SITE}${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), e);
};
// Opening the link in the email.
const linkOf = (mail) => mail.text.match(/https:\/\/\S+/)[0];
const open = (link, e = env) => { sent = []; return worker.fetch(new Request(link), e); };

// A signup sends the confirmation email and nothing else: nobody is on the list yet.
let res = await post({ email: ' player@example.com ', lang: 'en' });
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true });
assert.equal(sent.length, 0);
assert.equal(confirmations.length, 1);
assert.equal(confirmations[0].to, 'player@example.com');
assert.deepEqual(confirmations[0].from, { email: 'news@streetsofprague.com', name: 'Streets of Prague' });
assert.equal(confirmations[0].subject, 'Confirm your email for Streets of Prague news');
assert.match(linkOf(confirmations[0]), new RegExp(`^${SITE}/api/confirm\\?t=[\\w-]+\\.[\\w-]+$`));
const link = linkOf(confirmations[0]);
assert.ok(confirmations[0].html.includes(link));

// The link adds the address to the list and sends the player back to the game.
res = await open(link);
assert.equal(res.status, 303);
assert.equal(res.headers.get('Location'), `${SITE}/?subscribed`);
assert.equal(sent.length, 1);
assert.equal(sent[0].url, 'https://api.brevo.com/v3/contacts');
assert.equal(sent[0].headers['api-key'], 'test-key');
assert.deepEqual(sent[0].body, { email: 'player@example.com', listIds: [7], updateEnabled: true });

// A link that was altered, cut short or made with another key adds nobody.
const [body, sig] = link.split('=')[1].split('.');
const forged = Buffer.from(JSON.stringify({ e: 'victim@example.com', l: 'en', o: SITE, x: Date.now() + 1e9 })).toString('base64url');
for (const t of [`${forged}.${sig}`, `${body}.${sig.slice(1)}`, body, '', 'a.b']) {
  res = await open(`${SITE}/api/confirm?t=${t}`);
  assert.equal(res.headers.get('Location'), `${SITE}/?subscribed=failed`, `"${t}" should not confirm`);
  assert.equal(sent.length, 0);
}
res = await open(link, { ...env, CONFIRM_SECRET: 'another-key' });
assert.equal(res.headers.get('Location'), `${SITE}/?subscribed=failed`);
assert.equal(sent.length, 0);
res = await open(`${SITE}/api/confirm`);
assert.equal(res.headers.get('Location'), `${SITE}/?subscribed=failed`);

// It stops working after a week.
{
  const now = Date.now;
  Date.now = () => now() + 8 * 864e5;
  res = await open(link);
  Date.now = now;
  assert.equal(res.headers.get('Location'), `${SITE}/?subscribed=failed`);
  assert.equal(sent.length, 0);
}

// Brevo refusing at that point is told to the player, not hidden.
answer = () => new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 });
assert.equal((await open(link)).headers.get('Location'), `${SITE}/?subscribed=failed`);
answer = () => new Response('{}', { status: 201 });

// Czech players get the Czech email, and the language is kept with the contact where an
// attribute for it is named; anything but Czech counts as English.
const lenv = { ...env, BREVO_LANGUAGE_ATTRIBUTE: 'LANGUAGE' };
await post({ email: 'hrac@example.cz', lang: 'cs' }, { e: lenv });
assert.match(confirmations[0].subject, /^Potvrď svůj e-mail/);
await open(linkOf(confirmations[0]), lenv);
assert.deepEqual(sent[0].body.attributes, { LANGUAGE: 'cs' });
await post({ email: 'player@example.com', lang: 'xx' }, { e: lenv });
assert.equal(confirmations[0].subject, 'Confirm your email for Streets of Prague news');
await open(linkOf(confirmations[0]), lenv);
assert.deepEqual(sent[0].body.attributes, { LANGUAGE: 'en' });

// With Turnstile set up, a signup needs a token that Cloudflare vouches for.
const tenv = { ...env, TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' };
res = await post({ email: 'player@example.com', token: 'good' }, { e: tenv });
assert.equal(res.status, 200);
assert.deepEqual(checked, [{ secret: 'secret', response: 'good' }]);
assert.equal(confirmations.length, 1);
res = await post({ email: 'player@example.com' }, { e: tenv });
assert.equal(res.status, 403);
assert.deepEqual(await res.json(), { error: 'check' });
assert.equal(checked.length, 0);
assert.equal(confirmations.length, 0);
verdict = () => new Response('{"success":false,"error-codes":["invalid-input-response"]}');
assert.equal((await post({ email: 'player@example.com', token: 'forged' }, { e: tenv })).status, 403);
assert.equal(confirmations.length, 0);
verdict = () => { throw new Error('unreachable'); };
assert.equal((await post({ email: 'player@example.com', token: 'good' }, { e: tenv })).status, 403);
verdict = () => new Response('{"success":true}');
// The widget is in the form but the secret is missing: nothing gets through unchecked.
assert.equal((await post({ email: 'player@example.com', token: 'good' }, { e: { ...tenv, TURNSTILE_SECRET_KEY: undefined } })).status, 503);
assert.equal(confirmations.length, 0);

// The beta signs up through production, and is sent back to the beta.
res = await post({ email: 'player@example.com' }, { origin: BETA });
assert.equal(res.status, 200);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), BETA);
assert.match(linkOf(confirmations[0]), new RegExp(`^${SITE}/api/confirm`));
assert.equal((await open(linkOf(confirmations[0]))).headers.get('Location'), `${BETA}/?subscribed`);
res = await post(null, { origin: BETA, method: 'OPTIONS' });
assert.equal(res.status, 204);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), BETA);

// Other sites can't.
res = await post({ email: 'player@example.com' }, { origin: 'https://example.com' });
assert.equal(res.status, 403);
assert.equal(confirmations.length, 0);

for (const email of ['', 'nobody', 'a@b', 'two words@example.com', `${'x'.repeat(250)}@example.com`, 42]) {
  res = await post({ email });
  assert.equal(res.status, 400, `"${email}" should be refused`);
  assert.equal(confirmations.length, 0);
}

// The hidden field filled in: looks like it worked, nothing is sent.
res = await post({ email: 'bot@example.com', website: 'https://spam.example' });
assert.equal(res.status, 200);
assert.equal(confirmations.length, 0);

res = await post({ email: 'player@example.com' }, { e: { ...env, RATE: { limit: async () => ({ success: false }) } } });
assert.equal(res.status, 429);
assert.equal(confirmations.length, 0);

// Anything missing from the setup: the form says it is unavailable, and nothing is sent.
for (const gone of ['BREVO_API_KEY', 'BREVO_LIST_ID', 'CONFIRM_SECRET', 'NEWS_FROM', 'NEWS_EMAIL']) {
  res = await post({ email: 'player@example.com' }, { e: { ...env, [gone]: undefined } });
  assert.equal(res.status, 503, gone);
  assert.equal(confirmations.length, 0);
}

// The email not going out is reported.
res = await post({ email: 'player@example.com' }, { e: { ...env, NEWS_EMAIL: { send: async () => { throw new Error('not allowed'); } } } });
assert.equal(res.status, 502);

assert.equal((await post(null, { method: 'GET' })).status, 405);
// Everything else is the game's files.
assert.equal(await (await worker.fetch(new Request(`${SITE}/index.html`), env)).text(), 'asset');

// ---- Feedback ----
let mail = [];
const mailer = { send: async (m) => { mail.push(m); return { messageId: 'x' }; } };
const fenv = { ...env, EMAIL: mailer, FEEDBACK_TO: 'author@example.com', FEEDBACK_FROM: 'feedback@streetsofprague.com' };
const say = (body, opts = {}) => { mail = []; return post(body, { path: '/api/feedback', e: fenv, ...opts }); };

res = await say({ message: ' The tram at Anděl drove through my car.\nSecond line. ', email: 'player@example.com', context: 'Version v1.2.3\nChrome' });
assert.equal(res.status, 200);
assert.equal(mail.length, 1);
assert.equal(mail[0].to, 'author@example.com');
assert.deepEqual(mail[0].from, { email: 'feedback@streetsofprague.com', name: 'Streets of Prague' });
assert.equal(mail[0].replyTo, 'player@example.com');
assert.equal(mail[0].subject, 'Feedback: The tram at Anděl drove through my car.');
assert.match(mail[0].text, /^The tram at Anděl drove through my car\.\nSecond line\.\n\n--\nFrom: player@example\.com\nVersion v1\.2\.3\nChrome$/);

// A copy is kept for the viewer, and losing it doesn't stop the email.
{
  const kept = [];
  mail = [];
  res = await post({ message: 'Kept.', email: 'player@example.com', context: 'v1', lang: 'cs' }, { path: '/api/feedback', e: { ...fenv, FEEDBACK_ARCHIVE: { put: async (key, value) => { kept.push([key, JSON.parse(value)]); } } } });
  assert.equal(res.status, 200);
  assert.match(kept[0][0], /^feedback\/\d{4}-\d\d-\d\d\/\d+-[0-9a-f-]+\.json$/);
  assert.deepEqual({ ...kept[0][1], time: 0 }, { time: 0, site: '', message: 'Kept.', email: 'player@example.com', context: 'v1', scenario: '', screenshot: '', lang: 'cs' });
  // A screenshot and a scenario are kept too; something that isn't a JPEG is dropped.
  const files = [];
  const store = { put: async (key, value) => { files.push([key, value]); } };
  const picture = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  mail = [];
  res = await post({ message: 'With a picture.', scenario: "t.time('12:00');", screenshot: picture }, { path: '/api/feedback', e: { ...fenv, FEEDBACK_ARCHIVE: store } });
  assert.equal(res.status, 200);
  assert.match(files[0][0], /^feedback-shots\/\d{4}-\d\d-\d\d\/\d+-[0-9a-f-]+\.jpg$/);
  assert.deepEqual([...files[0][1]], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(JSON.parse(files[1][1]).screenshot, files[0][0]);
  assert.equal(JSON.parse(files[1][1]).scenario, "t.time('12:00');");
  assert.match(mail[0].text, /t\.time\('12:00'\);/);
  files.length = 0;
  await post({ message: 'Not a picture.', screenshot: 'data:text/html;base64,AAAA' }, { path: '/api/feedback', e: { ...fenv, FEEDBACK_ARCHIVE: store } });
  assert.equal(files.length, 1, 'only the message was kept');
  assert.equal(JSON.parse(files[0][1]).screenshot, '');
  mail = [];
  res = await post({ message: 'Kept anyway.' }, { path: '/api/feedback', e: { ...fenv, FEEDBACK_ARCHIVE: { put: async () => { throw new Error('r2 down'); } } } });
  assert.equal(res.status, 200);
  assert.equal(mail.length, 1);
}

// No address is fine; there is then nobody to reply to.
res = await say({ message: 'Nice game' });
assert.equal(res.status, 200);
assert.equal('replyTo' in mail[0], false);
assert.match(mail[0].text, /From: no address given/);

// Long messages are cut, not refused.
await say({ message: 'x'.repeat(9000), context: 'y'.repeat(9000) });
assert.ok(mail[0].text.length < 9100);
assert.ok(mail[0].subject.length < 85);

assert.equal((await say({ message: '   ' })).status, 400);
assert.equal((await say({ message: 'Hi', email: 'not an address' })).status, 400);
assert.equal(mail.length, 0);
assert.equal((await say('just text')).status, 400);
res = await say({ message: 'Buy pills', website: 'https://spam.example' });
assert.equal(res.status, 200);
assert.equal(mail.length, 0);
assert.equal((await say({ message: 'Hi' }, { origin: 'https://example.com' })).status, 403);
assert.equal((await say({ message: 'Hi' }, { origin: BETA })).headers.get('Access-Control-Allow-Origin'), BETA);
assert.equal(mail.at(-1).subject, '[beta.streetsofprague.com] Feedback: Hi');
assert.equal((await say({ message: 'Hi' }, { e: { ...fenv, FEEDBACK_TO: '' } })).status, 503);
assert.equal((await say({ message: 'Hi' }, { e: { ...fenv, EMAIL: { send: async () => { throw new Error('refused'); } } } })).status, 502);

// ---- Statistics ----
let rows = [];
const senv = { ...env, TELEMETRY: { writeDataPoint: (row) => rows.push(row) } };
// (sendBeacon posts text, not JSON, and the game's host is whichever domain it was opened on.)
const tell = (body, { origin = SITE, method = 'POST', e = senv } = {}) => {
  rows = [];
  const request = new Request(`${SITE}/api/report`, { method, headers: { Origin: origin }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  return worker.fetch(Object.assign(request, { cf: { country: 'CZ' } }), e);
};

res = await tell({ e: 'frames', v: 'v1.2.3', d: '2026-10-01-b2', s: 'abc', f: { renderer: 'WebGPU', tier: 'high', seq: 2, medianMs: 16, unknown: 'dropped', p95Ms: 'not a number' } });
assert.equal(res.status, 204);
// Fields land in the order worker/stats.js lists them; what it doesn't list is dropped.
assert.deepEqual(rows, [{ indexes: ['frames'], blobs: ['frames', 'v1.2.3', 'abc', 'CZ', 'streetsofprague.com', '2026-10-01-b2', 'WebGPU', '', 'high'], doubles: [2, 0, 0, 16, 0, 0, 0, 0, 0] }]);
await tell({ e: 'error', f: { message: 'x'.repeat(5000).slice(0, 3000) } });
assert.equal(rows[0].blobs[7].length, 600);

// Several reports of one kind in a request: one row each, and no more than the limit.
res = await tell({ e: 'activity', v: 'v1.2.3', s: 'abc', rows: [{ kind: 'did', name: 'rode a tram', seq: 1, times: 2, firstAt: 95 }, { kind: 'spent', name: 'ticket', seq: 1, times: 1, firstAt: 96, amount: 46 }, 'not a report'] });
assert.equal(res.status, 204);
assert.deepEqual(rows.map((r) => [...r.blobs.slice(6), ...r.doubles]), [['did', 'rode a tram', 1, 2, 95, 0], ['spent', 'ticket', 1, 1, 96, 46], ['', '', 0, 0, 0, 0]]);
await tell({ e: 'activity', rows: Array.from({ length: 100 }, () => ({ kind: 'did', name: 'x' })) });
assert.equal(rows.length, 40);

assert.equal((await tell({ e: 'constructor' })).status, 400);
assert.equal((await tell('{')).status, 400);
assert.equal((await tell('x'.repeat(9000))).status, 413);
assert.equal((await tell({ e: 'start' }, { origin: 'https://example.com' })).status, 403);
res = await tell({ e: 'start', v: 'v1' }, { origin: BETA });
assert.equal(res.status, 204);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), BETA);
assert.equal(rows[0].blobs[4], 'beta.streetsofprague.com');
assert.equal((await tell(null, { method: 'GET' })).status, 405);
assert.equal((await tell({ e: 'start' }, { e: env })).status, 503);
assert.equal(rows.length, 0);
// Reports are not held back by the forms' rate limit.
assert.equal((await tell({ e: 'start' }, { e: { ...senv, RATE: { limit: async () => ({ success: false }) } } })).status, 204);

console.log('The newsletter signup, the feedback form and the statistics behave as expected.');
