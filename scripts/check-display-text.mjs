#!/usr/bin/env node
// External names in the HUD and developer search must remain text, not markup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.window = new EventTarget();
class Element extends EventTarget {
  children = []; options = [{}, {}]; value = ''; textContent = ''; html = ''; style = {};
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.children = [...children]; this.html = ''; }
  querySelector() { return new Element(); }
}
globalThis.HTMLInputElement = Element;
const elements = new Map();
const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
globalThis.document = {
  createElement: () => new Element(), getElementById: el, body: new Element(), head: new Element(),
  documentElement: {}, querySelectorAll: () => [],
};
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { t, tHtml, setLang } = await server.ssrLoadModule('/src/i18n.ts');
  const { Ferries } = await server.ssrLoadModule('/src/ferries.ts');
  const { setupDev } = await server.ssrLoadModule('/src/dev.ts');
  const name = 'A & B <img src=x onerror="alert(1)"> "Quay" \'s &lt; pier';
  const escaped = 'A &amp; B &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &quot;Quay&quot; &#39;s &amp;lt; pier';
  const safe = (html, context, markup = false) => {
    assert.ok(html.includes(escaped), `${context}: external name is escaped exactly once`);
    assert.ok(!html.includes('<img'), `${context}: external markup cannot become a DOM element`);
    if (markup) assert.ok(html.includes('<b>E</b>'), `${context}: key markup is preserved`);
  };

  // Evaluate the production HUD expressions with only the named transit fixtures.
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const expression = needle => {
    const line = main.split('\n').find(line => line.includes(needle));
    assert.ok(line, `locate ${needle}`);
    return line.slice(line.indexOf('hint = ') + 'hint = '.length).replace(/;$/, '');
  };
  for (const lang of ['en', 'cs']) {
    setLang(lang);
    const ordinary = { name: 'Karlovo náměstí' };
    assert.equal(tHtml('At {name}', ordinary), t('At {name}', ordinary), `${lang} ordinary names retain existing rendering`);
    assert.equal(tHtml('{n}× speed', { n: 2 }), t('{n}× speed', { n: 2 }), `${lang} numbers retain existing rendering`);
    const boarding = new Function('t', 'tHtml', 'canBoard', 'ride', `return ${expression('get on the {line} to {name}')}`);
    safe(boarding(t, tHtml, { line: { ref: name } }, { headsign: () => name }), `${lang} boarding hint`, true);
    const metro = new Function('t', 'tHtml', 'station', `return ${expression('take the metro from {name}')}`);
    safe(metro(t, tHtml, { name }), `${lang} metro hint`, true);
    const destinationLine = main.split('\n').find(line => line.includes("if (dest) parts.push("));
    const destination = new Function('t', 'tHtml', 'dest', 'next', `const parts=[]; ${destinationLine}; return parts[0];`);
    safe(destination(t, tHtml, name, false), `${lang} chosen tram destination`);
    safe(destination(t, tHtml, name, true), `${lang} next tram destination`);

    const ferry = Object.assign(Object.create(Ferries.prototype), { o: { day: () => 200 } });
    const boat = { line: { ref: name, allYear: true, hours: [7, 21], stops: [{ name }, { name }] }, open: true, stop: null, to: 1 };
    ferry.me = boat;
    safe(ferry.offer(boat), `${lang} ferry offer`, true);
    safe(ferry.hint(false, 1), `${lang} sailing ferry hint`);
    boat.stop = 0;
    safe(ferry.hint(true, 1), `${lang} landed ferry hint`);
    boat.open = false;
    safe(ferry.offer(boat), `${lang} closed ferry timetable`);
    boat.line.allYear = false; ferry.o.day = () => 1;
    safe(ferry.offer(boat), `${lang} seasonal ferry timetable`);
  }
  setLang('en');
  assert.equal(t('At {name}', { name }), `At ${name}`, 'plain text translations keep literal names');
  assert.equal(tHtml('<b>E</b> get off'), '<b>E</b> get off', 'templates without substitutions retain markup');
  assert.equal(tHtml('At {name}', { name: '{line}' }), 'At {line}', 'substitutions cannot trigger another substitution');

  const originalFetch = globalThis.fetch;
  let finishTeleport;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ [name]: [0, 0] }) });
  try {
    const developer = setupDev({
      area: 'test', index: { bbox_wgs84: [14.3, 50, 14.5, 50.1] },
      teleport: () => new Promise(resolve => { finishTeleport = resolve; }), position: () => [0, 0],
      graphics: { choice: 'high' }, season: {}, weather: { kinds: ['clear'], get: () => 'clear' },
    });
    const query = el('dev-q'), results = el('dev-results');
    query.value = 'A & B'; query.dispatchEvent(new Event('input'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(results.children[0].textContent, name, 'street search result renders the literal external name');
    const going = results.children[0].onclick();
    assert.equal(results.children[0]?.textContent, `Going to ${name}…`, 'clicked street result stays literal while teleporting');
    assert.ok(!results.innerHTML.includes('<img'), 'teleport progress does not reinterpret external markup');
    finishTeleport(); await going;
    assert.equal(results.children.length, 0, 'completed teleport clears the progress note');
    globalThis.fetch = async () => ({ json: async () => [{ lon: '14.4', lat: '50.05', display_name: name }] });
    query.value = 'An address';
    query.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Enter' }));
    await new Promise(resolve => setImmediate(resolve));
    const address = results.children.find(child => child.className === 'dev-hit');
    assert.equal(address.textContent, name, 'address lookup result renders the literal external name');
    const moving = address.onclick();
    assert.equal(results.children[0]?.textContent, `Going to ${name}…`, 'clicked address result stays literal while teleporting');
    finishTeleport(); await moving;
    developer.attach({
      PLACES: {}, scenarios: ['fixture'],
      run: async () => ({ title: name, pass: false, checks: [{ name, detail: name, pass: false }], error: name }),
    });
    await el('dev-run').onclick();
    const report = el('dev-out').innerHTML;
    assert.ok(!report.includes('<img'), 'scenario result names, details and errors remain text');
    assert.equal(report.match(/&lt;img/g)?.length, 4, 'all four report fields escape external data');
  } finally { globalThis.fetch = originalFetch; }
  console.log('Display text: English/Czech transit HUD hints, ferry names, trusted key markup and clicked external search labels passed.');
} finally { await server.close(); }
