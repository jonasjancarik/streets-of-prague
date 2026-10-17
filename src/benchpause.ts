// On a dev server only: the game stands still while a benchmark runs anywhere on this
// machine (scripts/bench.mjs in any checkout), so that a game left open in a tab or a
// scene server doesn't take the GPU from under it. The dev server knows who is
// benchmarking (/__bench in vite.config.js, from scripts/game-lock.mjs) and the page
// asks it every two seconds. The benchmark's own page is the one that carries on.

declare global { interface Window { __bench?: unknown; __benchPause?: { check: () => Promise<void> } } }

const on = import.meta.env.DEV;
const listeners: ((paused: boolean) => void)[] = [];
let note: HTMLElement | null = null;
let requested = 0, answered = 0;

export const benchPause = {
  paused: false,
  // Before loading the map: wait here if a benchmark is running already.
  async clear() {
    if (!on) return;
    await check();
    while (benchPause.paused) await new Promise((r) => setTimeout(r, 2000));
  },
  onChange(f: (paused: boolean) => void) { listeners.push(f); },
};

function set(from: string | null) {
  const paused = from !== null;
  if (paused && !note) {
    note = document.createElement('div');
    note.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:8vw;'
      + 'background:rgba(20,13,12,0.82);color:#ece4d6;font:20px/1.45 system-ui,sans-serif;text-align:center';
    document.body.append(note);
  }
  if (note) {
    note.hidden = !paused;
    note.style.display = paused ? 'flex' : 'none';
    if (paused) note.textContent = `Paused while a benchmark runs in another session (${from}). The game carries on by itself when it finishes.`;
  }
  if (paused === benchPause.paused) return;
  benchPause.paused = paused;
  for (const f of listeners) f(paused);
}

async function check() {
  if (window.__bench) return;
  const id = ++requested, controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let from: string | null = null;
  try {
    // Bound both headers and body: a stuck startup poll must not hold clear() forever.
    const answer = await Promise.race([
      fetch('/__bench', { cache: 'no-store', signal: controller.signal }).then((r) => r.ok ? r.json() : null),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Benchmark status request timed out')); }, 4000);
      }),
    ]) as { bench?: unknown } | null;
    if (typeof answer?.bench === 'string' && answer.bench) from = answer.bench;
  } catch { /* a dev server without the check (or gone): nothing to wait for */ }
  finally { clearTimeout(timer); }
  // Apply completed responses in order. A slow poll can still answer while a newer
  // one is pending, but cannot overwrite a newer status that has already arrived.
  if (id < answered) return;
  answered = id;
  set(from);
}

if (on) {
  setInterval(check, 2000);
  window.__benchPause = { check };
}
