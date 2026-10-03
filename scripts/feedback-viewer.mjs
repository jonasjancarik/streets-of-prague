#!/usr/bin/env node
// The tool for the messages players send from the game's feedback form. It reads the copies
// that worker/index.js keeps in R2 (feedback/<date>/<time>-<id>.json) through your `cf` login,
// serves one page on this machine, and lets you mark what you did with each message: a status,
// a note and whether you replied. Those marks are one JSON object in the same bucket
// (feedback-state.json, outside feedback/), written back after every change.
//
//   node scripts/feedback-viewer.mjs              start on http://127.0.0.1:5196 and open it
//   node scripts/feedback-viewer.mjs --sample     made-up messages, marks kept in memory only
//   --port <n>   another port        --host <address>   reachable from elsewhere (default 127.0.0.1)
//   --no-open    don't open the page
//
// The page shows players' addresses and writes to the bucket without a login, so it listens on
// this machine only unless you pass --host. Downloaded messages are cached in .feedback/cache/
// (git-ignored; they hold email addresses). Messages sent before the copies existed are only
// in the inbox.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '7756b12931ecfb3900a31049e157d706', BUCKET = 'streets-of-prague-mail', STATE_KEY = 'feedback-state.json';
const CACHE = join(ROOT, '.feedback/cache'), UPLOAD = join(ROOT, '.feedback/state-upload.json');
const STATUSES = ['new', 'progress', 'done', 'wontdo'];
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(option('--port', 5196)), HOST = option('--host', '127.0.0.1');
const SAMPLE_MODE = flag('--sample');

const cf = (...a) => execFileSync('cf', a, { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const cfMessage = (e) => String(e.stderr || e.message).replace(/[┌│└]/g, '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');

function listKeys() {
  const keys = [];
  let after = '';
  for (;;) { // a page at a time, in key order, which is time order
    const page = JSON.parse(cf('r2', 'objects', 'list', '--bucket-name', BUCKET, '--prefix', 'feedback/', '--per-page', '1000', ...(after ? ['--start-after', after] : [])));
    if (!page.length) break;
    keys.push(...page.map((o) => o.key));
    after = page[page.length - 1].key;
    if (page.length < 1000) break;
  }
  return keys;
}

// Messages never change, so each is downloaded once and kept in .feedback/cache/.
function loadMessages() {
  mkdirSync(CACHE, { recursive: true });
  return listKeys().map((key) => {
    const file = join(CACHE, key.replaceAll('/', '__'));
    try {
      if (existsSync(file)) return { key, ...JSON.parse(readFileSync(file, 'utf8')) };
      const text = cf('r2', 'objects', 'get', key, '--bucket-name', BUCKET);
      const message = JSON.parse(text);
      writeFileSync(file, text);
      return { key, ...message };
    } catch (e) {
      return { key, time: '', message: `(could not be read: ${cfMessage(e)})`, context: '' };
    }
  });
}

function loadState() {
  try { return JSON.parse(cf('r2', 'objects', 'get', STATE_KEY, '--bucket-name', BUCKET)) || {}; }
  catch (e) {
    if (/not\s*found|NoSuchKey|10007|404/i.test(cfMessage(e))) return {}; // nothing saved yet
    throw e;
  }
}

function saveState(state) {
  mkdirSync(dirname(UPLOAD), { recursive: true });
  writeFileSync(UPLOAD, JSON.stringify(state));
  cf('r2', 'objects', 'put', STATE_KEY, '--bucket-name', BUCKET, '--file', UPLOAD, '--content-type', 'application/json');
}

const SAMPLE = [
  { key: 's1', time: '2026-10-02T09:12:00Z', message: 'The tram at Anděl drove through my car.\nIt happened twice.', email: 'player@example.com', lang: 'en', context: 'Version v0.1.2\nChrome 141 on macOS\nSpeed 62 km/h, near Anděl' },
  { key: 's2', time: '2026-10-01T18:40:00Z', message: 'Skvělá hra, ale policie střílí příliš přesně.', email: '', lang: 'cs', context: 'Version v0.1.1\nSafari on iPad' },
  { key: 's3', time: '2026-09-30T20:05:00Z', message: 'Could you add a way to change the radio station with the keyboard?', email: 'radio@example.com', lang: 'en', context: 'Version v0.1.1\nFirefox 142 on Windows' },
];

let messages = SAMPLE, state = {};
if (!SAMPLE_MODE) {
  try { messages = loadMessages(); state = loadState(); }
  catch (e) { console.error(`Couldn't read from the bucket: ${cfMessage(e)}`); process.exit(1); }
}
const known = new Set(messages.map((m) => m.key));

// Changes are written one at a time. A change that couldn't be written is taken back, so what
// the page shows is what is saved.
let queue = Promise.resolve();
function change(key, patch) {
  const run = queue.then(() => {
    const before = state[key];
    const next = { status: 'new', note: '', replied: false, ...before, ...patch, updated: new Date().toISOString() };
    state = { ...state, [key]: next };
    try { if (!SAMPLE_MODE) saveState(state); }
    catch (e) {
      state = { ...state, ...(before ? { [key]: before } : {}) };
      if (!before) delete state[key];
      throw e;
    }
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

function validate(body) {
  if (!body || typeof body !== 'object' || !known.has(body.key)) return 'Unknown message';
  const patch = {};
  if ('status' in body) { if (!STATUSES.includes(body.status)) return 'Unknown status'; patch.status = body.status; }
  if ('note' in body) { if (typeof body.note !== 'string' || body.note.length > 5000) return 'Note is not valid'; patch.note = body.note; }
  if ('replied' in body) { if (typeof body.replied !== 'boolean') return 'Replied is not valid'; patch.replied = body.replied; }
  if (!Object.keys(patch).length) return 'Nothing to change';
  return patch;
}

const send = (res, status, data, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(data) : data);
};

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // On the loopback address only this machine's own page may ask (guards against other sites in the browser).
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost';
  if (loopbackOnly && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'Not allowed' });
  if (req.method === 'GET' && path === '/') return send(res, 200, PAGE, 'text/html');
  if (req.method === 'GET' && path === '/api/messages') return send(res, 200, { messages, state, sample: SAMPLE_MODE });
  if (req.method === 'POST' && path === '/api/state') {
    if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return send(res, 415, { error: 'Not allowed' });
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'Not valid' }); }
      const patch = validate(body);
      if (typeof patch === 'string') return send(res, 400, { error: patch });
      change(body.key, patch).then((entry) => send(res, 200, { key: body.key, entry }), (e) => { console.error(`Saving failed: ${cfMessage(e)}`); send(res, 502, { error: 'Couldn\'t save' }); });
    });
    return undefined;
  }
  return send(res, 404, { error: 'Not found' });
});

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback</title>
<style>
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#222;--dim:#777;--line:#e2ded4;--bad:#b3261e}
@media(prefers-color-scheme:dark){:root{--bg:#1b1a18;--card:#262522;--ink:#eee;--dim:#999;--line:#38362f;--bad:#f2867f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem}
h1{font-size:1.4rem;margin:0 0 .25rem}.count{color:var(--dim);margin:0 0 1rem}
input,select,textarea{box-sizing:border-box;padding:.5rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
#q{width:100%;padding:.6rem .8rem;margin-bottom:.8rem}
#filters{display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:1rem}
#filters button{border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink);font:inherit;font-size:.9rem;padding:.25rem .8rem;cursor:pointer}
#filters button[aria-pressed=true]{background:var(--ink);color:var(--bg)}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin-bottom:.8rem}
header{display:flex;gap:.8rem;flex-wrap:wrap;color:var(--dim);font-size:.85rem}
.lang{text-transform:uppercase}
p{white-space:pre-wrap;margin:.5rem 0}
summary{color:var(--dim);font-size:.85rem;cursor:pointer}pre{font-size:.8rem;white-space:pre-wrap;color:var(--dim)}
a{color:inherit}
.marks{display:flex;gap:.8rem;flex-wrap:wrap;align-items:center;margin-top:.6rem;font-size:.9rem}
.marks label{display:flex;gap:.35rem;align-items:center}
textarea{width:100%;margin-top:.5rem;min-height:2.6rem;resize:vertical}
.saved{color:var(--dim);font-size:.85rem}.saved.bad{color:var(--bad)}
#banner{display:none;color:var(--bad);margin-bottom:1rem}
</style>
<main><h1>Feedback from players</h1><p class="count" id="count"></p>
<p id="banner"></p>
<input id="q" type="search" placeholder="Search the messages" autofocus>
<div id="filters"></div><div id="list"></div></main>
<script>
const STATUS={new:'New',progress:'In progress',done:'Done',wontdo:"Won't do"};
const FILTERS=[['attention','Needs attention'],...Object.entries(STATUS),['all','All']];
const $=(id)=>document.getElementById(id);
let messages=[],state={},filter='attention',query='';
const entry=(k)=>({status:'new',note:'',replied:false,...state[k]});
const matches=(m)=>{const s=entry(m.key).status;
  const inFilter=filter==='all'||(filter==='attention'?s==='new'||s==='progress':s===filter);
  return inFilter&&(!query||[m.message,m.email,m.context,entry(m.key).note].join('\\n').toLowerCase().includes(query))};
const inCount=(f,m)=>{const s=entry(m.key).status;return f==='all'||(f==='attention'?s==='new'||s==='progress':s===f)};
const QUOTE={en:['Re: your feedback on Streets of Prague','Thanks for your message:','Hello,'],cs:['Re: vaše zpětná vazba ke hře Streets of Prague','Děkuji za zprávu:','Dobrý den,']};
function mailto(m){const t=QUOTE[m.lang]||QUOTE.en;
  const body=t[2]+'\\n\\n'+t[1]+'\\n'+m.message.split('\\n').map(l=>'> '+l).join('\\n')+'\\n\\n';
  return 'mailto:'+encodeURIComponent(m.email).replace('%40','@')+'?subject='+encodeURIComponent(t[0])+'&body='+encodeURIComponent(body)}
function el(tag,props={},...kids){const e=Object.assign(document.createElement(tag),props);e.append(...kids);return e}
function card(m){
  const e=entry(m.key),saved=el('span',{className:'saved'});
  const note=el('textarea',{value:e.note,placeholder:'Note for yourself',rows:2});
  const status=el('select',{value:e.status},...Object.entries(STATUS).map(([v,l])=>el('option',{value:v,textContent:l})));
  status.value=e.status;
  const replied=el('input',{type:'checkbox',checked:e.replied});
  const save=async(patch,input)=>{saved.className='saved';saved.textContent='Saving…';
    try{const r=await fetch('/api/state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:m.key,...patch})});
      if(!r.ok)throw 0;const d=await r.json();state[m.key]=d.entry;saved.textContent='Saved';draw(false)}
    catch{saved.className='saved bad';saved.textContent="Couldn't save, try again";
      const old=entry(m.key);status.value=old.status;replied.checked=old.replied;if(input===note&&patch.note!==undefined)note.value=patch.note}};
  status.onchange=()=>save({status:status.value},status);
  replied.onchange=()=>save({replied:replied.checked},replied);
  let timer;const saveNote=()=>{clearTimeout(timer);if(note.value!==entry(m.key).note)save({note:note.value},note)};
  note.oninput=()=>{saved.textContent='';clearTimeout(timer);timer=setTimeout(saveNote,1200)};note.onblur=saveNote;
  return el('article',{},
    el('header',{},el('time',{textContent:m.time?new Date(m.time).toLocaleString('cs-CZ'):''}),
      el('span',{},m.email?el('a',{href:mailto(m),textContent:m.email}):'no address given'),
      ...(m.lang?[el('span',{className:'lang',textContent:m.lang})]:[])),
    el('p',{textContent:m.message}),
    ...(m.context?[el('details',{},el('summary',{textContent:'Game details'}),el('pre',{textContent:m.context}))]:[]),
    el('div',{className:'marks'},status,el('label',{},replied,'Replied'),saved),note);
}
function draw(full=true){
  const bar=$('filters');bar.replaceChildren(...FILTERS.map(([f,l])=>el('button',{type:'button',textContent:l+' ('+messages.filter(m=>inCount(f,m)).length+')',
    onclick:()=>{filter=f;draw()}, ariaPressed:String(f===filter)})));
  const shown=messages.filter(matches);
  $('count').textContent=shown.length+' of '+messages.length+' messages, newest first';
  if(!full)return; // a change leaves the cards in place so typing isn't interrupted
  $('list').replaceChildren(...(shown.length?shown.slice().sort((a,b)=>String(b.time).localeCompare(String(a.time))).map(card):[el('p',{textContent:!messages.length?'No messages yet.':query||filter!=='attention'?'No messages match.':'No messages need attention.'})]));
}
$('q').oninput=(e)=>{query=e.target.value.toLowerCase();draw()};
fetch('/api/messages').then(r=>r.json()).then(d=>{messages=d.messages;state=d.state;
  if(d.sample)$('count').before(el('p',{className:'saved',textContent:'Sample messages: changes are not kept.'}));draw()})
 .catch(()=>{$('banner').style.display='block';$('banner').textContent="Couldn't load the messages. Is the tool still running?"});
</script></html>`;

server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Pick another with --port.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}/`;
  console.log(`${messages.length} message${messages.length === 1 ? '' : 's'}${SAMPLE_MODE ? ' (sample)' : ''}. Open ${url}`);
  if (!flag('--no-open')) execFileSync('open', [url]);
});
