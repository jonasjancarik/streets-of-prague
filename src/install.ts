// Putting the game on the home screen (or the desktop) as an app, which opens it
// without the browser's bars (public/manifest.webmanifest asks for full screen).
// Chrome and Edge offer their own install dialog through beforeinstallprompt; Safari
// has none, so there the settings explain the Share menu instead. iPhones have no
// full screen in the browser at all, so this is the only way to get it there.

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPrompt | null = null;
const listeners: (() => void)[] = [];
const changed = () => { for (const f of listeners) f(); };

// Registered as the module loads, before the browser fires it.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // no mini-infobar: the settings have the button
  deferred = e as InstallPrompt;
  changed();
});
window.addEventListener('appinstalled', () => { deferred = null; changed(); });

/** Running as the installed app rather than in a browser tab. */
export function runningAsApp() {
  return matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** An iPhone or iPad (iPadOS says it's a Mac, but a Mac has no touch screen). */
export const apple = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** How the game can be installed here: with the browser's dialog, by hand from
 *  Safari's Share menu, or not at all (already installed, or a browser without it). */
export function installWay(): 'prompt' | 'share' | null {
  if (runningAsApp()) return null;
  if (deferred) return 'prompt';
  if (apple) return 'share';
  return null;
}

/** Opens the browser's install dialog. */
export async function install() {
  const p = deferred;
  if (!p) return;
  deferred = null; // a prompt can be shown only once
  await p.prompt().catch(() => {});
  await p.userChoice.catch(() => {});
  changed();
}

export function onInstallChange(f: () => void) { listeners.push(f); }
