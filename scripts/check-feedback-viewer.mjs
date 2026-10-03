#!/usr/bin/env node
// Starts the feedback viewer on sample messages (no R2, no cf) and exercises its API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = 5197, base = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [new URL('./feedback-viewer.mjs', import.meta.url).pathname, '--sample', '--no-open', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
try {
  await new Promise((ok, fail) => {
    server.stdout.on('data', (d) => /Open http/.test(String(d)) && ok());
    server.on('exit', (c) => fail(new Error(`viewer exited with ${c}`)));
  });
  const post = (body) => fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const read = async () => (await fetch(`${base}/api/messages`)).json();

  const html = await (await fetch(base)).text();
  assert.match(html, /Feedback from players/);
  const { messages, state } = await read();
  assert.ok(messages.length >= 2 && !Object.keys(state).length, 'sample messages, no marks yet');

  const key = messages[0].key;
  assert.equal((await post({ key, status: 'progress', note: 'Looking at it', replied: true })).status, 200);
  assert.deepEqual({ ...(await read()).state[key], updated: 0 }, { status: 'progress', note: 'Looking at it', replied: true, updated: 0 });
  assert.equal((await post({ key, status: 'done' })).status, 200); // a partial change keeps the rest
  const kept = (await read()).state[key];
  assert.deepEqual([kept.status, kept.note, kept.replied], ['done', 'Looking at it', true]);

  assert.equal((await post({ key, status: 'bogus' })).status, 400, 'bad status refused');
  assert.equal((await post({ key: 'nope', status: 'done' })).status, 400, 'unknown message refused');
  assert.equal((await post({ key, replied: 'yes' })).status, 400, 'bad replied refused');
  assert.equal((await fetch(`${base}/api/state`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await read()).state[key].status, 'done', 'refused changes left the mark alone');
  console.log('Feedback viewer: page, status, note, replied and refusals passed');
} finally {
  server.kill();
}
