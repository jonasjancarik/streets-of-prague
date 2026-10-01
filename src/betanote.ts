import { onLang, t } from './i18n.ts';
import { el, sheet, signupFields } from './newsletter.ts';

// A word from the author before the first game, while the game is in beta: it isn't finished, feedback
// is welcome and where to send it, and the newsletter signup for those who want it. Shown once
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
  // The newsletter signup, right here.
  const news = el('p', 'beta-news', d);
  let asked = false; // an address was given, so the button no longer turns anything down
  const go = document.createElement('button');
  const label = () => {
    title.textContent = t('Welcome to the beta');
    intro.textContent = t('Thanks for trying Streets of Prague this early. The game isn\'t finished yet.');
    rough.textContent = t('It can run slowly on some computers and phones, and you\'ll come across bugs and things that are missing. I know about many of them and I\'m working on them.');
    tell.textContent = t('If something breaks, or you have an idea, I\'d love to hear it: press "Feedback" in the corner of the screen at any time.');
    news.textContent = t('Want to hear when there is something new in the game? Leave your email address.');
    go.textContent = asked ? t('Start playing') : t('Skip, don\'t bother me now');
  };
  // Signed up: the line about the email to open stays up for a moment, then the game begins.
  news.hidden = !signupFields(d, { done: () => { asked = true; news.hidden = true; label(); setTimeout(() => d.close(), 5000); } });
  const actions = el('div', 'beta-actions', d);
  el('span', 'beta-sign', actions).textContent = 'Jonáš';
  go.className = 'news-go';
  go.type = 'button';
  go.autofocus = true; // or the dialog would start on its close button
  actions.appendChild(go);
  onLang(label);
  go.addEventListener('click', () => d.close());
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => { d.remove(); resolve(); }, { once: true }));
}
