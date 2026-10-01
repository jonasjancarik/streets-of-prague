// Does the newsletter signup (worker/index.js) take what it should and refuse the rest?
// Runs the Worker's handler here with Brevo replaced by a stand-in, so nothing is sent.
// Usage: node scripts/check-subscribe.mjs
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const SITE = 'https://streetsofprague.com';
const BETA = 'https://beta.streetsofprague.com';
const env = { BREVO_API_KEY: 'test-key', BREVO_LIST_ID: '7', BREVO_DOI_TEMPLATE_ID: '3', ASSETS: { fetch: async () => new Response('asset') } };

// What the Worker sent to Brevo, and what Brevo answers.
let sent = [];
let answer = () => new Response('{}', { status: 201 });
globalThis.fetch = async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return answer(); };
console.error = () => {};

const post = (body, { origin = SITE, method = 'POST', e = env } = {}) => {
  sent = [];
  return worker.fetch(new Request(`${SITE}/api/subscribe`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), e);
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

console.log('The newsletter signup behaves as expected.');
