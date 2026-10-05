// Who is running the game on this machine, so that sessions in different checkouts
// don't spoil each other's benchmarks. Every script that opens the game in a browser
// checks in here first (bench.mjs, scene.mjs, the check-*.mjs that use Chrome):
//
//   const slot = await checkIn('bench', 'bench.mjs --vs …');   // or 'game'
//   await slot.take();     // waits its turn, saying on stderr whom it waits for
//   …                      // the entry goes when the process ends
//
// A benchmark has the machine to itself: it waits until no other script is running
// the game, and nothing else starts while it waits or runs. Scenes and checks run
// side by side, MAX_GAMES at a time, and queue behind a benchmark. A scene server
// rests between commands (slot.rest()): its page stays open and pauses itself while
// a benchmark runs, as every game open from a dev server does (src/benchpause.ts,
// asked through /__bench in vite.config.js).
//
// The entries are files in one folder for the whole machine, one per process, and an
// entry whose process has gone is dropped. Scripts from checkouts older than this
// file don't check in; they are found among the running processes instead.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const DIR = process.env.SOP_LOCK_DIR || join(homedir(), '.cache', 'streets-of-prague', 'running');
const MAX_GAMES = Number(process.env.SOP_MAX_GAMES || 3);
// How long a benchmark waits for a script that never checked in (it may be a scene
// server left running in an old checkout, which never ends).
const STRANGER_PATIENCE = Number(process.env.SOP_STRANGER_WAIT || 300) * 1000;
const POLL = 1000;
const ROOT = new URL('..', import.meta.url).pathname;

const living = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const file = (pid) => join(DIR, `${pid}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`; };
const before = (a, b) => a.since < b.since || (a.since === b.since && a.pid < b.pid);

// Everyone checked in whose process is still there.
export function entries() {
  let names = [];
  try { names = readdirSync(DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let e;
    try { e = JSON.parse(readFileSync(join(DIR, name), 'utf8')); } catch { continue; } // being written
    if (living(e.pid)) out.push(e);
    else try { unlinkSync(join(DIR, name)); } catch {}
  }
  return out;
}

// Scripts with a browser open that never checked in (a checkout from before this file):
// Chrome started by Playwright whose parent is one of the game's scripts.
export function strangers(known = entries()) {
  let lines;
  try { lines = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n'); } catch { return []; }
  const procs = new Map(), parents = new Set();
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.set(Number(m[1]), m[3]);
    if (m[3].includes('--remote-debugging-pipe') && !m[3].includes('--type=')) parents.add(Number(m[2]));
  }
  const mine = new Set(known.map((e) => e.pid));
  const out = [];
  for (const pid of parents) {
    const script = procs.get(pid)?.match(/scripts\/(bench|scene|check-[\w-]+)\.mjs/);
    if (!script || mine.has(pid) || pid === process.pid) continue;
    out.push({ pid, kind: script[1] === 'bench' ? 'bench' : 'game', status: 'running', stranger: true, what: `${script[1]}.mjs`, where: 'an older checkout' });
  }
  return out;
}

// The benchmark that has the machine now, if any (for the dev server to tell its pages).
export function runningBench() {
  const known = entries();
  return known.find((e) => e.kind === 'bench' && e.status === 'running') || strangers(known).find((e) => e.kind === 'bench') || null;
}

const describe = (e) => `${e.kind === 'bench' ? 'the benchmark' : e.what} from ${e.where}${e.since ? `, started ${ago(e.since)}` : ` (process ${e.pid})`}`;

let leaving = false;
export async function checkIn(kind, what = basename(process.argv[1] || 'script')) {
  mkdirSync(DIR, { recursive: true });
  const me = { pid: process.pid, kind, status: 'idle', since: Date.now(), what, where: /\/worktrees\//.test(ROOT) ? basename(ROOT) : 'the main checkout' };
  const write = (status) => {
    me.status = status;
    writeFileSync(`${file(me.pid)}.tmp`, JSON.stringify(me));
    renameSync(`${file(me.pid)}.tmp`, file(me.pid));
  };
  const out = () => { try { unlinkSync(file(me.pid)); } catch {} };
  write('idle');
  if (!leaving) {
    leaving = true;
    process.on('exit', out);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));
  }

  // Who stands in the way just now. Both sides write their entry before they look, so
  // of a benchmark and a scene starting at the same moment one always sees the other.
  const inTheWay = (waitingSince) => {
    const known = entries().filter((e) => e.pid !== me.pid);
    const unknown = strangers(known);
    if (kind === 'bench') {
      const patient = Date.now() - waitingSince < STRANGER_PATIENCE;
      return [
        ...known.filter((e) => (e.kind === 'bench' && before(e, me)) || (e.kind === 'game' && e.status === 'running')),
        ...unknown.filter((e) => e.kind === 'bench' || patient),
      ];
    }
    const benches = [...known, ...unknown].filter((e) => e.kind === 'bench');
    const ahead = known.filter((e) => e.kind === 'game' && e.status !== 'idle' && before(e, me));
    return benches.length ? benches : ahead.length >= MAX_GAMES ? ahead : [];
  };

  return {
    // Wait for a turn, then hold it until rest() or the end of the process.
    async take() {
      me.since = Date.now();
      let said = '';
      write('waiting');
      for (;;) {
        let blocked = inTheWay(me.since);
        // A scene shows itself as running, then looks once more for a benchmark that
        // came at that moment (a benchmark's entry is there before it looks for scenes).
        if (!blocked.length && kind !== 'bench') {
          write('running');
          blocked = inTheWay(me.since);
          if (blocked.length) write('waiting');
        }
        if (!blocked.length) break;
        const who = blocked.map((e) => e.pid).join();
        if (who !== said) { said = who; console.error(`Waiting for ${blocked.map(describe).join(' and ')} to finish…`); }
        await sleep(POLL);
      }
      write('running');
      if (kind === 'bench') {
        const left = strangers(entries());
        if (left.length) console.error(`Warning: still running after ${STRANGER_PATIENCE / 1000} s of waiting, and likely to disturb these timings: ${left.map(describe).join(', ')}`);
      }
      if (said) console.error('Free now, carrying on.');
    },
    // Between commands: still here with a browser open, but in nobody's way.
    rest() { write('idle'); },
    out,
  };
}
