// Is there a newer version of the game than the one in this tab? version.json at the
// site root (scripts/write-version-json.mjs) names the current one; a tab left open for
// hours would otherwise keep playing an old build. It is asked for on load and when the
// tab comes back into view, at most every 15 minutes, and any failure is ignored
// (a missing file, no network, or the dev server answering with index.html). The game
// is never reloaded from here: the player does it, from a line in the settings panel
// or on the start screen.
import { onLang, t } from './i18n.ts';

declare const __APP_VERSION__: string; // set by vite.config.js

const EVERY = 15 * 60 * 1000;
const listeners: (() => void)[] = [];
let newer = false;
let started = false;
let last = 0;

async function check() {
  if (Date.now() - last < EVERY) return;
  last = Date.now();
  try {
    // no-store: the beta's server can't say so itself.
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { game } = await res.json();
    if (typeof game === 'string' && game && game !== __APP_VERSION__ && !newer) {
      newer = true;
      for (const f of listeners) f();
    }
  } catch { /* nothing to tell the player */ }
}

// Run `f` when a newer version is known (at once if it already is). The first call
// starts the checking.
export function onNewerVersion(f: () => void) {
  listeners.push(f);
  if (newer) f();
  if (started) return;
  started = true;
  void check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
}

// A quiet line with a Reload button, hidden until there is something to reload for.
export function updateNotice(parent: HTMLElement, cls: string) {
  const line = document.createElement('p');
  line.className = cls;
  line.hidden = true;
  const text = document.createElement('span');
  const button = document.createElement('button');
  button.type = 'button';
  button.addEventListener('click', () => location.reload());
  line.append(text, ' ', button);
  parent.appendChild(line);
  onLang(() => { text.textContent = t('A newer version of the game is available.'); button.textContent = t('Reload'); });
  onNewerVersion(() => { line.hidden = false; });
  return line;
}
