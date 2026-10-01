// Do the newsletter signup and the feedback form (worker/index.js) take what they should
// and refuse the rest? Runs the Worker's handler here with Brevo and the email sending
// replaced by stand-ins, so nothing is sent.
// Usage: node scripts/check-worker.mjs
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const SITE = 'https://streetsofprague.com';
const BETA = 'https://beta.streetsofprague.com';
const env = { BREVO_API_KEY: 'test-key', BREVO_LIST_ID: '7', BREVO_DOI_TEMPLATE_ID: '3', ASSETS: { fetch: async () => new Response('asset') } };

// What the Worker sent to Brevo, and what Brevo answers; the same for Turnstile's check.
let sent = [], checked = [];
let answer = () => new Response('{}', { status: 201 });
let verdict = () => new Response('{"success":true}');
globalThis.fetch = async (url, init) => {
  if (String(url).includes('turnstile')) { checked.push(JSON.parse(init.body)); return verdict(); }
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return answer();
};
console.error = () => {};

const post = (body, { origin = SITE, method = 'POST', e = env, path = '/api/subscribe' } = {}) => {
  sent = []; checked = [];
  return worker.fetch(new Request(`${SITE}${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), e);
};

let res = await post({ email: ' player@example.com ', lang: 'en' });
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { ok: true });
assert.equal(sent.length, 1);
assert.equal(sent[0].headers['api-key'], 'test-key');
assert.deepEqual(sent[0].body, { email: 'player@example.com', includeListIds: [7], templateId: 3, redirectionUrl: `${SITE}/?subscribed` });

// Czech players get the Czech confirmation email when there is one.
await post({ email: 'hrac@example.cz', lang: 'cs' }, { e: { ...env, BREVO_DOI_TEMPLATE_ID_CS: '4' } });
assert.equal(sent[0].body.templateId, 4);
await post({ email: 'hrac@example.cz', lang: 'cs' });
assert.equal(sent[0].body.templateId, 3);

// The language is kept with the contact where an attribute for it is named; anything
// but Czech counts as English.
await post({ email: 'hrac@example.cz', lang: 'cs' }, { e: { ...env, BREVO_LANGUAGE_ATTRIBUTE: 'LANGUAGE' } });
assert.deepEqual(sent[0].body.attributes, { LANGUAGE: 'cs' });
await post({ email: 'player@example.com', lang: 'xx' }, { e: { ...env, BREVO_LANGUAGE_ATTRIBUTE: 'LANGUAGE' } });
assert.deepEqual(sent[0].body.attributes, { LANGUAGE: 'en' });

// With Turnstile set up, a signup needs a token that Cloudflare vouches for.
const tenv = { ...env, TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' };
res = await post({ email: 'player@example.com', token: 'good' }, { e: tenv });
assert.equal(res.status, 200);
assert.deepEqual(checked, [{ secret: 'secret', response: 'good' }]);
assert.equal(sent.length, 1);
res = await post({ email: 'player@example.com' }, { e: tenv });
assert.equal(res.status, 403);
assert.deepEqual(await res.json(), { error: 'check' });
assert.equal(checked.length, 0);
assert.equal(sent.length, 0);
verdict = () => new Response('{"success":false,"error-codes":["invalid-input-response"]}');
assert.equal((await post({ email: 'player@example.com', token: 'forged' }, { e: tenv })).status, 403);
assert.equal(sent.length, 0);
verdict = () => { throw new Error('unreachable'); };
assert.equal((await post({ email: 'player@example.com', token: 'good' }, { e: tenv })).status, 403);
verdict = () => new Response('{"success":true}');
// The widget is in the form but the secret is missing: nothing gets through unchecked.
assert.equal((await post({ email: 'player@example.com', token: 'good' }, { e: { ...tenv, TURNSTILE_SECRET_KEY: undefined } })).status, 503);
assert.equal(sent.length, 0);

// The beta signs up through production, and is sent back to the beta.
res = await post({ email: 'player@example.com' }, { origin: BETA });
assert.equal(res.status, 200);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), BETA);
assert.equal(sent[0].body.redirectionUrl, `${BETA}/?subscribed`);
res = await post(null, { origin: BETA, method: 'OPTIONS' });
assert.equal(res.status, 204);
assert.equal(res.headers.get('Access-Control-Allow-Origin'), BETA);

// Other sites can't.
res = await post({ email: 'player@example.com' }, { origin: 'https://example.com' });
assert.equal(res.status, 403);
assert.equal(sent.length, 0);

for (const email of ['', 'nobody', 'a@b', 'two words@example.com', `${'x'.repeat(250)}@example.com`, 42]) {
  res = await post({ email });
  assert.equal(res.status, 400, `"${email}" should be refused`);
  assert.equal(sent.length, 0);
}

// The hidden field filled in: looks like it worked, nothing is sent.
res = await post({ email: 'bot@example.com', website: 'https://spam.example' });
assert.equal(res.status, 200);
assert.equal(sent.length, 0);

res = await post({ email: 'player@example.com' }, { e: { ...env, RATE: { limit: async () => ({ success: false }) } } });
assert.equal(res.status, 429);
assert.equal(sent.length, 0);

res = await post({ email: 'player@example.com' }, { e: { ...env, BREVO_API_KEY: undefined } });
assert.equal(res.status, 503);

answer = () => new Response(JSON.stringify({ code: 'invalid_parameter', message: 'Invalid email address' }), { status: 400 });
assert.equal((await post({ email: 'player@example.com' })).status, 400);
answer = () => new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 });
assert.equal((await post({ email: 'player@example.com' })).status, 502);

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
assert.equal((await say({ message: 'Hi' }, { e: { ...fenv, FEEDBACK_TO: '' } })).status, 503);
assert.equal((await say({ message: 'Hi' }, { e: { ...fenv, EMAIL: { send: async () => { throw new Error('refused'); } } } })).status, 502);

console.log('The newsletter signup and the feedback form behave as expected.');
