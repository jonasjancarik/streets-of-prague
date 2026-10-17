#!/usr/bin/env node
// Exercise the real developer-panel setup without loading a map or renderer.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let raw = null, blocked = false;
globalThis.localStorage = { getItem() { if (blocked) throw new Error('Storage blocked'); return raw; }, removeItem() {} };
globalThis.location = { search: '?lang=en' };
class Element extends EventTarget {
  children = []; options = [{}, {}];
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  querySelector() { return new Element(); }
}
globalThis.document = { createElement: () => new Element() };
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, plugins: [{
  name: 'expose-mist-setup-for-regression',
  transform(source, id) {
    if (id.endsWith('/src/dev.ts')) return source + '\nexport { setupMist, MIST_SLIDERS, VOLUME_SLIDERS };';
  },
}] });
try {
  const { setupMist, MIST_SLIDERS, VOLUME_SLIDERS } = await server.ssrLoadModule('/src/dev.ts');
  const { MIST, MIST_DEFAULT } = await server.ssrLoadModule('/src/weather.ts');
  const { LOCAL_MIST, LOCAL_MIST_DEFAULT, MIST_MODE, setLocalMist } = await server.ssrLoadModule('/src/localmist.ts');
  const restore = value => {
    Object.assign(MIST, MIST_DEFAULT);
    Object.assign(LOCAL_MIST, LOCAL_MIST_DEFAULT);
    MIST_MODE.value = 'sheets';
    raw = value;
    setupMist(() => new Element(), { get: () => 'clear', set() {} }, () => {});
  };
  for (const [sliders, values, defaults, wrap] of [
    [MIST_SLIDERS, MIST, MIST_DEFAULT, value => value],
    [VOLUME_SLIDERS, LOCAL_MIST, LOCAL_MIST_DEFAULT, value => ({ volume: value })],
  ]) {
    for (const slider of sliders) {
      for (const [saved, expected] of [[slider.min - 100, slider.min], [slider.max + 100, slider.max], [(slider.min + slider.max) / 2, (slider.min + slider.max) / 2]]) {
        restore(JSON.stringify(wrap({ [slider.key]: saved })));
        assert.equal(values[slider.key], expected, `${slider.key}: clamp saved values to the control's range`);
      }
      for (const saved of ['invalid', null, true]) {
        restore(JSON.stringify(wrap({ [slider.key]: saved })));
        assert.equal(values[slider.key], defaults[slider.key], `${slider.key}: ignore values that are not numbers`);
      }
      restore(JSON.stringify(wrap({ [slider.key]: 'OVERFLOW' })).replace('"OVERFLOW"', '1e400'));
      assert.equal(values[slider.key], defaults[slider.key], `${slider.key}: ignore JSON numeric overflow`);
    }
  }
  for (const invalid of ['{', 'null', '[]', '{}']) {
    restore(invalid);
    assert.deepEqual(MIST, MIST_DEFAULT);
    assert.deepEqual(LOCAL_MIST, LOCAL_MIST_DEFAULT);
  }
  setLocalMist(() => null); // capability only; no material or renderer is created
  restore('{"mode":"volume","bankSize":220,"volume":{"width":40}}');
  assert.equal(MIST_MODE.value, 'volume', 'supported saved mode survives');
  location.search = '?mist=sheets';
  restore('{"mode":"volume"}');
  assert.equal(MIST_MODE.value, 'sheets', 'explicit URL overrides saved mode');
  location.search = '?mist=volume'; setLocalMist(null);
  restore('{"mode":"volume"}');
  assert.equal(MIST_MODE.value, 'sheets', 'unsupported local mist still falls back');
  blocked = true;
  assert.doesNotThrow(() => restore(null));
  assert.deepEqual(MIST, MIST_DEFAULT);
  console.log(`Mist settings: ${MIST_SLIDERS.length + VOLUME_SLIDERS.length} controls, finite ranges, invalid storage and mode precedence passed.`);
} finally { await server.close(); }
