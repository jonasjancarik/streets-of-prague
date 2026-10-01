import { getLang, onLang, t } from './i18n.ts';
import { el, sheet, trapField } from './newsletter.ts';

declare const __APP_VERSION__: string; // set by vite.config.js
declare const __APP_BUILT__: string;
declare const __DATA_VERSION__: string;

// Telling the author what's wrong or missing: a link in the settings opens a form, and
// the message goes to the site's own /api/feedback (worker/index.js), which emails it
// on. The game adds what a bug report needs and players rarely write: its version, the
// browser, and where the player was. A build with no address for it (local development,
// or before it's set up: deploy/feedback) shows none of this.

const URL_ = import.meta.env.VITE_FEEDBACK_URL as string | undefined;

const PROBLEMS: Record<string, string> = {
  message: 'Write a few words first.',
  email: 'That doesn\'t look like an email address.',
  busy: 'Too many tries from here. Please wait a minute and try again.',
};
const FAILED = 'Sending didn\'t work this time. Please try again later.';

function context(extra: () => string) {
  const lines = [
    `Version ${__APP_VERSION__} · ${__APP_BUILT__} · map data ${__DATA_VERSION__ || 'local'}`,
    `Page: ${location.origin}${location.pathname} · language ${getLang()}`,
    `Browser: ${navigator.userAgent}`,
    `Window: ${innerWidth}×${innerHeight} at ${devicePixelRatio}x${matchMedia('(pointer: coarse)').matches ? ' · touch' : ''}`,
  ];
  // The game's part may not be there yet (the start screen) and must never stop a message.
  try { lines.push(extra()); } catch {}
  try { const s = window.__test?.snapshot(); if (s) lines.push('', s); } catch {}
  return lines.join('\n');
}

function build(extra: () => string) {
  const { d, title } = sheet();
  const intro = el('p', '', d);
  const form = el('form', 'news-stack', d) as HTMLFormElement;
  const message = el('textarea', '', form) as HTMLTextAreaElement;
  message.name = 'message';
  message.required = true;
  message.rows = 5;
  message.maxLength = 5000;
  message.autofocus = true; // or the dialog would start on its close button
  const email = el('input', '', form) as HTMLInputElement;
  email.type = 'email';
  email.name = 'email';
  email.autocomplete = 'email';
  const trap = trapField(form);
  const go = el('button', 'news-go', form) as HTMLButtonElement;
  go.type = 'submit';
  const status = el('p', 'news-status', d);
  status.setAttribute('role', 'status');
  const small = el('p', 'news-small', d);

  // What the status line says, kept as the English text so it follows the language.
  let note = '', sending = false, done = false;
  const label = () => {
    title.textContent = t('Send feedback');
    intro.textContent = t('Found a bug, or something you\'d like to see in the game? Write it here.');
    message.ariaLabel = t('Your message');
    email.placeholder = email.ariaLabel = t('Your email address, if you\'d like an answer');
    go.textContent = sending ? t('Sending…') : t('Send');
    go.disabled = sending;
    status.textContent = note && t(note);
    status.classList.toggle('bad', !done && !!note);
    form.hidden = intro.hidden = small.hidden = done;
    small.textContent = t('The game\'s version, your browser and where you are in the game are sent along, to help find the problem.');
  };
  onLang(label);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !URL_) return;
    sending = true; note = '';
    label();
    try {
      const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: message.value, email: email.value, website: trap.value, lang: getLang(), context: context(extra) }) });
      const answer = await res.json().catch(() => ({})) as { error?: string };
      done = res.ok;
      note = done ? 'Thank you. Your message is on its way.' : PROBLEMS[answer.error ?? ''] ?? FAILED;
    } catch {
      note = FAILED;
    }
    sending = false;
    label();
  });
  // Opened again after a message went out, it is ready for another.
  d.addEventListener('close', () => {
    if (!done) return;
    done = false; note = ''; message.value = '';
    label();
  });
  return d;
}

// The link that opens the form, added to `parent` (nothing, where feedback isn't set
// up). `extra` is a line about the game's state to send along.
export function feedbackLink(parent: HTMLElement, cls: string, { before = () => {}, extra = (): string => '' } = {}) {
  if (!URL_) return;
  let box: HTMLDialogElement | null = null;
  const link = el('button', cls, parent) as HTMLButtonElement;
  link.type = 'button';
  onLang(() => { link.textContent = t('Send feedback'); });
  link.addEventListener('click', () => {
    before();
    box ??= build(extra);
    box.showModal();
  });
}
