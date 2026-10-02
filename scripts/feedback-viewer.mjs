#!/usr/bin/env node
// The viewer for the messages players send from the game's feedback form: reads the copies
// that worker/index.js keeps in R2 (feedback/<date>/<time>-<id>.json) through your `cf`
// login and writes one HTML page. Nothing here is public: the page is a file on this machine.
//
//   node scripts/feedback-viewer.mjs              all messages, then opens the page
//   node scripts/feedback-viewer.mjs --sample     made-up messages, to see the page
//   --out <file>   where to write it (.feedback/viewer.html)     --no-open
//
// Messages sent before the copies existed are only in the inbox.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '7756b12931ecfb3900a31049e157d706', BUCKET = 'streets-of-prague-mail';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const OUT = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, '.feedback/viewer.html'));

const cf = (...a) => execFileSync('cf', a, { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT }, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });

function load() {
  const keys = [];
  let after = '';
  for (;;) { // a page at a time, in key order, which is time order
    const page = JSON.parse(cf('r2', 'objects', 'list', '--bucket-name', BUCKET, '--prefix', 'feedback/', '--per-page', '1000', ...(after ? ['--start-after', after] : [])));
    if (!page.length) break;
    keys.push(...page.map((o) => o.key));
    after = page[page.length - 1].key;
    if (page.length < 1000) break;
  }
  return keys.map((key) => {
    try { return { key, ...JSON.parse(cf('r2', 'objects', 'get', key, '--bucket-name', BUCKET)) }; }
    catch (e) { return { key, time: '', message: `(could not be read: ${String(e.message).split('\n')[0]})`, context: '' }; }
  });
}

const SAMPLE = [
  { key: 's1', time: '2026-10-02T09:12:00Z', message: 'The tram at Anděl drove through my car.\nIt happened twice.', email: 'player@example.com', lang: 'en', context: 'Version v0.1.2\nChrome 141 on macOS\nSpeed 62 km/h, near Anděl' },
  { key: 's2', time: '2026-10-01T18:40:00Z', message: 'Skvělá hra, ale policie střílí příliš přesně.', email: '', lang: 'cs', context: 'Version v0.1.1\nSafari on iPad' },
];

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(items) {
  const rows = items.slice().reverse().map((m) => `
  <article>
    <header><time>${esc(m.time ? new Date(m.time).toLocaleString('cs-CZ') : '')}</time>
      <span>${m.email ? `<a href="mailto:${esc(m.email)}">${esc(m.email)}</a>` : 'no address given'}</span>${m.lang ? `<span class="lang">${esc(m.lang)}</span>` : ''}</header>
    <p>${esc(m.message)}</p>
    ${m.context ? `<details><summary>Game details</summary><pre>${esc(m.context)}</pre></details>` : ''}
  </article>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Feedback</title>
<style>
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#222;--dim:#777;--line:#e2ded4}
@media(prefers-color-scheme:dark){:root{--bg:#1b1a18;--card:#262522;--ink:#eee;--dim:#999;--line:#38362f}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:46rem;margin:0 auto;padding:1.5rem 1rem}
h1{font-size:1.4rem;margin:0 0 .25rem}.count{color:var(--dim);margin:0 0 1rem}
input{width:100%;box-sizing:border-box;padding:.6rem .8rem;margin-bottom:1rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit}
article{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin-bottom:.8rem}
header{display:flex;gap:.8rem;flex-wrap:wrap;color:var(--dim);font-size:.85rem}
.lang{text-transform:uppercase}
p{white-space:pre-wrap;margin:.5rem 0}
summary{color:var(--dim);font-size:.85rem;cursor:pointer}pre{font-size:.8rem;white-space:pre-wrap;color:var(--dim)}
a{color:inherit}
</style>
<main><h1>Feedback from players</h1><p class="count"><span id="n">${items.length}</span> of ${items.length} messages, newest first</p>
<input id="q" type="search" placeholder="Search the messages" autofocus>${rows || '<p>No messages yet.</p>'}</main>
<script>
const cards=[...document.querySelectorAll('article')],n=document.getElementById('n');
document.getElementById('q').addEventListener('input',e=>{const q=e.target.value.toLowerCase();let c=0;
for(const a of cards){const ok=a.textContent.toLowerCase().includes(q);a.hidden=!ok;if(ok)c++}n.textContent=c});
</script></html>`;
}

const items = flag('--sample') ? SAMPLE : load();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page(items));
console.log(`${items.length} message${items.length === 1 ? '' : 's'} written to ${OUT}`);
if (!flag('--no-open')) execFileSync('open', [OUT]);
