import { getLang, onLang, t } from './i18n.ts';

// Signing up for news about the game by email: a link on the start screen and in the
// settings, which opens a small form. The address goes to the site's own
// /api/subscribe (worker/index.js), which passes it to the newsletter service; that
// sends an email with a link to confirm, and the link comes back here with ?subscribed.
// A build with no address for it (local development, or before the newsletter is set
// up: deploy/newsletter) shows none of this.

const URL_ = import.meta.env.VITE_SUBSCRIBE_URL as string | undefined;
const confirmed = new URLSearchParams(location.search).has('subscribed');

const el = (tag: string, cls: string, parent: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
};

const PROBLEMS: Record<string, string> = {
  email: 'That doesn\'t look like an email address.',
  busy: 'Too many tries from here. Please wait a minute and try again.',
};

let box: HTMLDialogElement | null = null;

function build() {
  const d = el('dialog', 'settings news', document.body) as HTMLDialogElement;
  const head = el('div', 'settings-head', d);
  const title = el('h2', '', head);
  const close = el('button', 'settings-close', head) as HTMLButtonElement;
  close.type = 'button';
  close.textContent = '×';
  const intro = el('p', '', d);
  const form = el('form', '', d) as HTMLFormElement;
  const email = el('input', '', form) as HTMLInputElement;
  email.type = 'email';
  email.name = 'email';
  email.required = true;
  email.autocomplete = 'email';
  email.autofocus = true; // or the dialog would start on its close button
  // People don't see this one; scripts that fill in every field give themselves away.
  const trap = el('input', 'news-trap', form) as HTMLInputElement;
  trap.name = 'website';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  trap.setAttribute('aria-hidden', 'true');
  const go = el('button', 'news-go', form) as HTMLButtonElement;
  go.type = 'submit';
  const status = el('p', 'news-status', d);
  status.setAttribute('role', 'status');
  const small = el('p', 'news-small', d);

  // What the status line says, kept as the English text so it follows the language.
  let message = '', sending = false, done = false;
  const label = () => {
    title.textContent = t('News about the game');
    close.ariaLabel = t('Close');
    intro.textContent = t('Leave your email address and you\'ll get a message when there is something new in the game.');
    email.placeholder = email.ariaLabel = t('Your email address');
    go.textContent = sending ? t('Sending…') : t('Sign up');
    go.disabled = sending;
    status.textContent = message && t(message);
    status.classList.toggle('bad', !done && !!message);
    form.hidden = intro.hidden = done;
    small.textContent = t('Your address is used only for these emails and is kept by Brevo, the service that sends them. Every email has a link to unsubscribe.');
  };
  onLang(label);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !URL_) return;
    sending = true; message = '';
    label();
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, website: trap.value, lang: getLang() }) });
      const answer = await res.json().catch(() => ({})) as { error?: string };
      done = res.ok;
      message = done ? 'Almost done. Open the email that is on its way to you and press the button in it to confirm your address.' : PROBLEMS[answer.error ?? ''] ?? 'Signing up didn\'t work this time. Please try again later.';
    } catch {
      message = 'Signing up didn\'t work this time. Please try again later.';
    }
    sending = false;
    label();
  });

  close.addEventListener('click', () => d.close());
  // While it's open, keys don't reach the game (Escape still closes it).
  d.addEventListener('keydown', (e) => e.stopPropagation());
  d.addEventListener('click', (e) => {
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
  });
  return d;
}

// The link that opens the form, added to `parent` (nothing, where there is no
// newsletter). With `thanks`, someone who has just confirmed their address by the link
// in the email reads that it worked instead.
export function newsletterLink(parent: HTMLElement, cls: string, { thanks = false, before = () => {} } = {}) {
  if (!URL_) return;
  if (thanks && confirmed) {
    const note = el('div', `${cls} done`, parent);
    onLang(() => { note.textContent = t('Your email address is confirmed. You\'ll hear when there is something new in the game.'); });
    return;
  }
  const link = el('button', cls, parent) as HTMLButtonElement;
  link.type = 'button';
  onLang(() => { link.textContent = t('Get news about the game by email'); });
  link.addEventListener('click', () => {
    before();
    box ??= build();
    box.showModal();
  });
}
