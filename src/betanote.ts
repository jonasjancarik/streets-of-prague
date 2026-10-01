import { onLang, t } from './i18n.ts';
import { el, newsletterLink, sheet } from './newsletter.ts';

// A word before the first game, while the game is in beta: it isn't finished, feedback
// is welcome and where to send it, and news by email for those who want it. Shown once
// (remembered in the browser), after "Start game" is pressed and before the game begins.

const KEY = 'beta-note';
const feedback = !!import.meta.env.VITE_FEEDBACK_URL; // as in feedback.ts: no form, no mention of it

const seen = () => { try { return localStorage.getItem(KEY) === 'seen'; } catch { return false; } };

// Resolves when the note is closed, or at once if it has been shown before.
export function betaNote(): Promise<void> {
  if (seen()) return Promise.resolve();
  try { localStorage.setItem(KEY, 'seen'); } catch { /* storage blocked: it shows again next time */ }
  const { d, title } = sheet();
  d.classList.add('beta');
  const intro = el('p', '', d), rough = el('p', '', d), tell = el('p', '', d);
  tell.hidden = !feedback;
  const actions = el('div', 'beta-actions', d);
  let asked = false; // the signup form was opened, so the button no longer turns anything down
  const go = el('button', 'news-go', actions) as HTMLButtonElement;
  go.type = 'button';
  go.autofocus = true; // or the dialog would start on its close button
  const label = () => {
    title.textContent = t('Welcome to the beta');
    intro.textContent = t('Thanks for trying Streets of Prague this early. The game isn\'t finished yet.');
    rough.textContent = t('It can run slowly on some computers and phones, and you\'ll come across bugs and things that are missing. We know about many of them and are working on them.');
    tell.textContent = t('If something breaks, or you have an idea, we\'d love to hear it: open the settings in the corner of the screen and choose "Send feedback".');
    go.textContent = asked ? t('Start playing') : t('Skip, don\'t bother me now');
  };
  newsletterLink(actions, 'beta-news', { before: () => { asked = true; label(); } });
  actions.appendChild(go); // after the signup link
  onLang(label);
  go.addEventListener('click', () => d.close());
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => { d.remove(); resolve(); }, { once: true }));
}
