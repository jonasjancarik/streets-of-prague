import { getLang, onLang, t } from './i18n.ts';
import { el, sheet } from './newsletter.ts';

// The beta (beta.streetsofprague.com) is a test version: it has what is coming next,
// before the regular game at play.streetsofprague.com does. Its start screen says so, with
// a link to the regular game and the list of what's different (deploy/beta-notes.json,
// scripts/beta-notes.mjs), and a small "Test version" button in the corner opens that list
// during the game. A list the player hasn't seen yet is marked as new.

declare const __BETA_NOTES__: { en: string[]; cs: string[] } | null; // set by vite.config.js

export const TEST_VERSION = import.meta.env.VITE_CHANNEL === 'beta';
const REGULAR = 'https://play.streetsofprague.com/';
const notes = TEST_VERSION ? __BETA_NOTES__ : null;
const KEY = 'test-version-notes';
const stamp = notes ? notes.en.join('\n') : '';
const seen = () => { try { return localStorage.getItem(KEY) === stamp; } catch { return false; } };
const changed: (() => void)[] = [];

function regularLink(parent: HTMLElement) {
  const a = el('a', '', parent) as HTMLAnchorElement;
  a.href = REGULAR;
  a.textContent = 'play.streetsofprague.com';
  return a;
}

// The sheet with the list, or with only the link when there is no list.
export function testVersionSheet() {
  try { localStorage.setItem(KEY, stamp); } catch { /* shown as new again next time */ }
  for (const f of changed) f();
  const { d, title } = sheet();
  d.classList.add('test-notes');
  const intro = el('p', '', d);
  const list = el('ul', 'test-list', d);
  const where = el('p', '', d);
  onLang(() => {
    title.textContent = t('What’s new in the test version');
    intro.textContent = notes ? t('This version has a few things the regular game doesn’t have yet:') : t('This version has the newest changes before the regular game gets them. They may not be finished.');
    list.replaceChildren(...(notes?.[getLang()] ?? []).map((s) => { const li = document.createElement('li'); li.textContent = s; return li; }));
    list.hidden = !notes;
    where.replaceChildren(t('Things may break here more often. The regular game is at '));
    regularLink(where);
    where.append('.');
  });
  d.showModal();
  d.addEventListener('close', () => d.remove(), { once: true });
}

// The line on the start screen.
export function testVersionNotice(parent: HTMLElement) {
  if (!TEST_VERSION) return;
  const box = el('div', 'ls-test', parent);
  const text = el('p', '', box);
  const more = el('button', '', box) as HTMLButtonElement;
  more.type = 'button';
  more.addEventListener('click', testVersionSheet);
  const label = () => {
    text.replaceChildren(t('This is the test version of the game. The regular game is at '));
    regularLink(text);
    text.append('.');
    more.textContent = t('What’s new here');
    more.classList.toggle('new', !!notes && !seen());
  };
  changed.push(label);
  onLang(label);
}

// The button in the corner, during the game.
export function testVersionButton(corner: HTMLElement) {
  if (!TEST_VERSION) return;
  const b = el('button', 'corner-btn corner-test', corner) as HTMLButtonElement;
  corner.prepend(b);
  b.type = 'button';
  onLang(() => { b.textContent = t('Test version'); b.title = b.ariaLabel = t('What’s new in the test version'); });
  b.addEventListener('click', () => { b.blur(); testVersionSheet(); });
}
