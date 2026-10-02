#!/usr/bin/env node
// Runs a snippet of test-API code (t = window.__test, __drive the game's objects) on the
// scene server and prints what it returns; the word TAG in the file becomes <tag>.
//
//   node .agents/skills/terrain-steps/look.mjs <file.js> [tag] [--port 5199]
//
// For pictures of a place from chosen angles: t.camera(...), t.shot('TAG-name').
import { readFileSync } from 'node:fs';

const [file, ...rest] = process.argv.slice(2);
const port = rest.includes('--port') ? rest[rest.indexOf('--port') + 1] : 5199;
const tag = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'x';
const code = readFileSync(file, 'utf8').replaceAll('TAG', tag);
const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'eval', code }) });
const out = await res.json();
console.log(JSON.stringify(out.error ? out : { value: out.value, errors: out.errors }).slice(0, 4000));
