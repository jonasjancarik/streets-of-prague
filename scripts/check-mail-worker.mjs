import assert from 'node:assert/strict';
import worker from '../worker/mail.js';

const bytes = new TextEncoder().encode('From: sender@example.org\r\nContent-Type: application/octet-stream\r\n\r\n\u0000attachment\xff');
function fixture(to = 'news@streetsofprague.com') {
  const calls = [];
  const message = {
    from: 'sender@example.org', to, rawSize: bytes.length,
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(reason) { calls.push(['reject', reason]); },
    async forward(to, headers) { calls.push(['forward', to, headers.get('X-Original-Recipient')]); },
  };
  const env = {
    FORWARD_TO: 'inbox@example.org',
    MAIL_ARCHIVE: { async put(key, raw, options) { calls.push(['archive', key, raw, options]); } },
  };
  return { message, env, calls };
}
for (const recipient of ['news@streetsofprague.com', 'JONAS@streetsofprague.com']) {
  const { message, env, calls } = fixture(recipient);
  await worker.email(message, env);
  assert.equal(calls[0][0], 'archive');
  assert.deepEqual(new Uint8Array(calls[0][2]), bytes);
  assert.equal(calls[0][3].httpMetadata.contentType, 'message/rfc822');
  assert.equal(calls[0][3].customMetadata.to, recipient.toLowerCase());
  assert.deepEqual(calls[1], ['forward', env.FORWARD_TO, recipient.toLowerCase()]);
}
for (const oversize of [false, true]) {
  const { message, env, calls } = fixture(oversize ? undefined : 'unknown@streetsofprague.com');
  if (oversize) message.rawSize = 26 * 1024 * 1024;
  await worker.email(message, env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'reject');
}
const failedArchive = fixture();
failedArchive.env.MAIL_ARCHIVE.put = async () => { throw new Error('storage unavailable'); };
await assert.rejects(worker.email(failedArchive.message, failedArchive.env), /storage unavailable/);
assert.equal(failedArchive.calls.length, 0);
const failedForward = fixture();
failedForward.message.forward = async () => { throw new Error('forward unavailable'); };
await assert.rejects(worker.email(failedForward.message, failedForward.env), /forward unavailable/);
assert.equal(failedForward.calls[0][0], 'archive');
console.log('Mail archives preserve MIME bytes, forward both addresses, and handle rejection and failures.');
