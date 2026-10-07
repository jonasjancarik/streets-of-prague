#!/usr/bin/env node
// The move of the game to play.streetsofprague.com, tried on this machine against the
// two copies of the Worker that scripts/local-two-hosts.sh serves: does the old address
// send people on with everything their link had, does /api answer at both, and is the
// game still served at the new one?
// Usage: scripts/local-two-hosts.sh &     then
//        node scripts/check-two-hosts.mjs
//   OLD_PORT (5311) and PLAY_PORT (5312) as for that script.
import assert from 'node:assert/strict';

const OLD = `http://localhost:${process.env.OLD_PORT || 5311}`, PLAY = `http://localhost:${process.env.PLAY_PORT || 5312}`;
const OLD_SITE = 'https://streetsofprague.com', SITE = 'https://play.streetsofprague.com';
const ask = (url, init = {}) => fetch(url, { redirect: 'manual', ...init });

// The old address: its page goes on, with the link's options untouched. The answer names
// no #fragment, which is what makes a browser carry the link's own over (RFC 9110, 10.2.2).
for (const tail of ['/', '/?start=14.42,50.08', '/?subscribed', '/?place=ujezd&time=22:30&lang=cs', '/?q=V%20Jirch%C3%A1%C5%99%C3%ADch']) {
  const res = await ask(`${OLD}${tail}`);
  assert.equal(res.status, 301, tail);
  assert.equal(res.headers.get('location'), `${SITE}${tail}`);
  assert.ok(!res.headers.get('location').includes('#'));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
}
// /index.html is the page too: the assets send it to /, which goes on.
let res = await ask(`${OLD}/index.html?start=1,2`);
assert.ok([301, 307, 308].includes(res.status));
assert.ok(['/?start=1,2', `${SITE}/index.html?start=1,2`].includes(res.headers.get('location')), res.headers.get('location'));
// Everything else is still there, for a game left open in a tab since before the move:
// what it loads late, its check for a newer version, and its /api.
res = await ask(`${OLD}/version.json`);
assert.equal(res.status, 200);
assert.equal(res.headers.get('cache-control'), 'no-store');
const { game } = await res.json();
assert.ok(game);
const html = await (await ask(`${PLAY}/`)).text();
const script = html.match(/\/assets\/[^"]+\.js/)[0];
for (const at of [OLD, PLAY]) {
  res = await ask(`${at}${script}`);
  assert.equal(res.status, 200, `${at}${script}`);
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal((await ask(`${at}/manifest.webmanifest`)).status, 200);
}
const post = (at, origin, path, body) => ask(`${at}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
for (const [at, origin] of [[OLD, OLD_SITE], [PLAY, SITE]]) {
  res = await post(at, origin, '/api/feedback', { message: '' });
  assert.deepEqual([res.status, await res.json()], [400, { error: 'message' }], `${origin}/api/feedback`);
  res = await post(at, origin, '/api/subscribe', { email: 'nobody' });
  assert.ok([400, 503].includes(res.status), 'the signup answers (503 here: no Brevo key on this machine)');
  assert.equal((await post(at, origin, '/api/report', { e: 'nope' })).status, 400);
  // The beta posts from its own address; other sites are refused.
  res = await post(at, 'https://beta.streetsofprague.com', '/api/feedback', { message: '' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://beta.streetsofprague.com');
  assert.equal((await post(at, 'https://example.com', '/api/feedback', { message: '' })).status, 403);
  assert.equal((await post(at, 'https://streets-cf.jonasjancarik.cz', '/api/feedback', { message: '' })).status, 403);
}
// The new address is the game, whatever the link.
for (const tail of ['/', '/?start=14.42,50.08', '/?subscribed']) {
  res = await ask(`${PLAY}${tail}`);
  assert.equal(res.status, 200, tail);
  assert.match(res.headers.get('content-type'), /text\/html/);
}
assert.equal((await (await ask(`${PLAY}/version.json`)).json()).game, game);
console.log('The old address sends pages on and both answer /api.');
