#!/usr/bin/env node
// Browser assertions against Vite's real TypeScript modules, with controlled fake
// workers. The game itself is exercised separately by scene.mjs and bench.mjs.
import { createRequire } from 'node:module';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => {
  if (v.startsWith('--')) a.push([v.slice(2), all[i + 1]]);
  return a;
}, []));
const base = args.url || 'http://localhost:5191/';
const which = args.case || 'all';
if (!['queue', 'sky', 'all'].includes(which)) throw new Error(`Unknown case: ${which}`);
const require = createRequire(import.meta.url);
const pw = (() => {
  for (const path of [process.env.PLAYWRIGHT_PATH || 'playwright', `${process.env.HOME}/projects/micromachines-clone/node_modules/playwright`]) {
    try { return require(path); } catch {}
  }
  throw new Error('Playwright not found; set PLAYWRIGHT_PATH');
})();
const browser = await pw.chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(new URL('src/tileWorkers.ts', base).href);
  const result = await page.evaluate(async (which) => {
    const { TileWorkers } = await import('/src/tileWorkers.ts');
    const { SkyRefresh } = await import('/src/skyRefresh.ts');
    const assert = (okay, message) => { if (!okay) throw new Error(message); };
    const tick = () => new Promise((done) => setTimeout(done, 5));
    class Fake {
      onmessage = null; onerror = null; onmessageerror = null;
      sent = []; dead = false; throwPost = false;
      postMessage(message, transfer) {
        if (this.throwPost) { this.throwPost = false; throw new Error('post failed'); }
        this.sent.push({ message: transfer?.length ? structuredClone(message, { transfer }) : message, transfer });
      }
      terminate() { this.dead = true; }
      done(result, at = 0) {
        const { message } = this.sent[at];
        this.onmessage?.({ data: { id: message.id, result } });
      }
      fail(message = 'worker failed') { this.onerror?.({ message, preventDefault() {} }); }
    }
    if (which === 'queue' || which === 'all') {
      const endpoints = [];
      const q = new TileWorkers(2, () => { const w = new Fake(); endpoints.push(w); return w; });
      const a = q.submit('roofs', {}, [], 'required');
      const b = q.submit('land', {}, [], 'required');
      const old = q.submit('sky', {}, [], 'optional');
      const buffer = new ArrayBuffer(8);
      const c = q.submit('ipr', { buffer }, [buffer], 'required');
      assert(q.counts.runningRequired === 2 && q.counts.queuedRequired === 1 && q.counts.queuedOptional === 1, 'one assignment per endpoint');
      assert(endpoints[0].sent.length === 1 && endpoints[1].sent.length === 1 && buffer.byteLength === 8, 'transfer retained in queue');
      endpoints[1].done('b'); // deliberately finish in reverse submission order
      assert(await b.promise === 'b' && endpoints[1].sent[1].message.type === 'ipr', 'required before optional');
      assert(endpoints[1].sent[1].transfer[0] === buffer, 'original transferable passed once');
      assert(buffer.byteLength === 0, 'buffer transferred only on dispatch');
      endpoints[1].done('c', 1);
      assert(await c.promise === 'c' && endpoints[1].sent[2].message.type === 'sky', 'optional progresses after required');
      endpoints[0].done('a'); endpoints[1].done('old', 2);
      assert(await a.promise === 'a' && await old.promise === 'old', 'out-of-order completion settled');
      const f = q.submit('roofs', {}), g = q.submit('ground', {}), h = q.submit('land', {});
      endpoints[0].onmessage?.({ data: { id: endpoints[0].sent.at(-1).message.id, error: 'job failed' } });
      await f.promise.catch((e) => assert(e.message === 'job failed', 'normal job error'));
      endpoints[1].fail();
      await g.promise.catch((e) => assert(e.message === 'worker failed', 'worker failure settles running job'));
      assert(endpoints[1].dead && endpoints.length === 3, 'failed worker replaced');
      endpoints[0].done('h', endpoints[0].sent.length - 1);
      assert(await h.promise === 'h', 'queue continues after worker error');
      const post = new TileWorkers(1, () => { const w = new Fake(); w.throwPost = true; endpoints.push(w); return w; });
      const bad = post.submit('roofs', {}), good = post.submit('ground', {});
      await bad.promise.catch((e) => assert(e.message === 'post failed', 'post failure settles job'));
      endpoints.at(-1).done('good');
      assert(await good.promise === 'good', 'post failure releases slot');
      const noWorkers = new TileWorkers(1, () => { throw new Error('constructor failed'); });
      await noWorkers.submit('roofs', {}).promise.catch((e) => assert(e.message === 'No tile workers available', 'no worker settles queue'));
      let made = 0, failedEndpoint;
      const exhausted = new TileWorkers(1, () => {
        if (made++) throw new Error('replacement failed');
        return (failedEndpoint = new Fake());
      });
      const dying = exhausted.submit('roofs', {}), waiting = exhausted.submit('ground', {});
      failedEndpoint.fail('last worker failed');
      await dying.promise.catch((e) => assert(e.message === 'last worker failed', 'last running job settles'));
      await waiting.promise.catch((e) => assert(e.message === 'No tile workers available', 'pending job settles when replacement fails'));
      const held = q.submit('roofs', {}), held2 = q.submit('land', {});
      const retained = new ArrayBuffer(4), cancelled = q.submit('ipr', { buffer: retained }, [retained]);
      cancelled.cancel();
      await cancelled.promise.catch((e) => assert(e.message.includes('cancelled'), 'cancelled promise settles'));
      assert(retained.byteLength === 4, 'cancelled queued transfer stays owned by caller');
      endpoints[0].done('held', endpoints[0].sent.length - 1);
      endpoints[2].done('held2', endpoints[2].sent.length - 1);
      await held.promise; await held2.promise;
    }
    if (which === 'sky' || which === 'all') {
      const endpoints = [];
      const q = new TileWorkers(1, () => { const w = new Fake(); endpoints.push(w); return w; });
      const applied = [];
      const refresh = () => new SkyRefresh((started) => q.submit('sky', () => { started(); return { version: state.version }; }, [], 'optional'), (v) => applied.push(v), 0);
      const state = { version: 1 };
      const r = refresh();
      const blocker = q.submit('roofs', {});
      r.request(); state.version = 2; r.request();
      await tick();
      assert(q.counts.queuedOptional === 1 && r.coalesced === 1, 'one coalesced queued refresh');
      endpoints[0].done('blocker'); await blocker.promise;
      assert(endpoints[0].sent[1].message.data.version === 2, 'snapshot made at dispatch');
      state.version = 3; r.request(); r.request();
      assert(r.running && q.counts.runningOptional === 1, 'at most one running refresh');
      endpoints[0].done('obsolete', 1); await tick();
      assert(applied.length === 0 && endpoints[0].sent.length === 3, 'obsolete result ignored, one follow-up');
      assert(endpoints[0].sent[2].message.data.version === 3, 'follow-up has latest shapes');
      endpoints[0].done('latest', 2); await tick();
      assert(applied.join() === 'latest' && r.applied === r.requested, 'latest revision applied');
      const old = refresh(); old.request(); await tick();
      const before = endpoints[0].sent.length; old.drop();
      const replacement = refresh(); state.version = 4; replacement.request(); await tick();
      endpoints[0].done('old', before - 1); await tick();
      assert(!applied.includes('old'), 'dropped entry cannot apply to replacement');
      endpoints[0].done('replacement', before); await tick();
      assert(applied.at(-1) === 'replacement', 'replacement can apply');
      const failure = refresh(); failure.request(); await tick();
      endpoints[0].onmessage?.({ data: { id: endpoints[0].sent.at(-1).message.id, error: 'sky failed' } }); await tick();
      assert(q.counts.queuedOptional === 0 && !failure.running, 'failure does not spin');
      failure.request(); await tick(); endpoints[0].done('retry', endpoints[0].sent.length - 1); await tick();
      assert(applied.at(-1) === 'retry', 'later neighbour change retries');
      const queued = refresh(); const busy = q.submit('ground', {}); queued.request(); await tick(); queued.drop();
      assert(q.counts.queuedOptional === 0 && queued.cancelled === 1, 'drop cancels queued refresh');
      endpoints[0].done('busy', endpoints[0].sent.length - 1); await busy.promise;
    }
    return `${which} checks passed`;
  }, which);
  console.log(result);
} finally { await browser.close(); }
