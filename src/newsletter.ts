import * as telemetry from './telemetry.ts';
import { LANGS, getLang, onLang, t } from './i18n.ts';
import type { Lang } from './i18n.ts';
import { privacyLink } from './credits.ts';

// Signing up for news about the game by email: a link on the start screen and in the
// settings, which opens a small form. The address goes to the site's own
// /api/subscribe (worker/index.js), which passes it to the newsletter service; that
// sends an email with a link to confirm, and the link comes back here with ?subscribed.
// A build with no address for it (local development, or before the newsletter is set
// up: deploy/newsletter) shows none of this.
//
// With a Turnstile site key in the build, the form also carries Cloudflare's check that
// a real browser is signing up: its script loads when the form is first opened, works
// unseen for most people (a box to tick appears for the rest), and gives a token that
// goes along with the address for the Worker to verify.

const URL_ = import.meta.env.VITE_SUBSCRIBE_URL as string | undefined;
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

interface Turnstile { render(where: HTMLElement, options: Record<string, unknown>): string; reset(id: string): void }
declare global { interface Window { turnstile?: Turnstile } }
let script: Promise<void> | null = null;
const loadTurnstile = () => (script ??= new Promise<void>((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.onload = () => resolve();
  s.onerror = () => { script = null; s.remove(); reject(new Error('Turnstile did not load')); };
  document.head.appendChild(s);
}));
const confirmed = new URLSearchParams(location.search).has('subscribed');

export const el = (tag: string, cls: string, parent: HTMLElement) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
};

const PROBLEMS: Record<string, string> = {
  email: 'That doesn\'t look like an email address.',
  busy: 'Too many tries from here. Please wait a minute and try again.',
  check: 'We couldn\'t confirm that a person is signing up. Please try again; if a content blocker is on for this page, switching it off may help.',
};

// A panel like the settings', with a title and a cross: the frame of this form and of
// the feedback form (feedback.ts).
export function sheet() {
  const d = el('dialog', 'settings news', document.body) as HTMLDialogElement;
  const head = el('div', 'settings-head', d);
  const title = el('h2', '', head);
  const close = el('button', 'settings-close', head) as HTMLButtonElement;
  close.type = 'button';
  close.textContent = '×';
  onLang(() => { close.ariaLabel = t('Close'); });
  close.addEventListener('click', () => d.close());
  // While it's open, keys don't reach the game (Escape still closes it).
  d.addEventListener('keydown', (e) => e.stopPropagation());
  d.addEventListener('click', (e) => {
    const r = d.getBoundingClientRect();
    if (e.target === d && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) d.close();
  });
  return { d, title };
}

// A field people don't see; scripts that fill in every field give themselves away.
export function trapField(form: HTMLFormElement) {
  const trap = el('input', 'news-trap', form) as HTMLInputElement;
  trap.name = 'website';
  trap.tabIndex = -1;
  trap.autocomplete = 'off';
  trap.setAttribute('aria-hidden', 'true');
  return trap;
}

let box: HTMLDialogElement | null = null;
export const newsletterOpen = () => !!box?.open;

function build() {
  const { d, title } = sheet();
  const intro = el('p', '', d);
  onLang(() => {
    title.textContent = t('News about the game');
    intro.textContent = t('Leave your email address and you\'ll get a message when there is something new in the game.');
  });
  signupFields(d, { focus: true, done: () => { intro.hidden = true; } });
  return d;
}

// The signup itself, added to `d`: the address, the language of the emails, Cloudflare's
// check, what came of it and the small print. Nothing, where there is no newsletter.
// `done` is called once an address has been taken.
export function signupFields(d: HTMLElement, { focus = false, done: onDone = () => {} } = {}) {
  if (!URL_) return false;
  const form = el('form', '', d) as HTMLFormElement;
  const email = el('input', '', form) as HTMLInputElement;
  email.type = 'email';
  email.name = 'email';
  email.required = true;
  email.autocomplete = 'email';
  email.autofocus = focus; // or a dialog with only this in it would start on its close button
  const trap = trapField(form);
  const go = el('button', 'news-go', form) as HTMLButtonElement;
  go.type = 'submit';

  // The language of the emails: the game's, until one is picked here.
  let picked: Lang | null = null;
  const lang = () => picked ?? getLang();
  const langRow = el('div', 'news-row', d);
  const langName = el('span', '', langRow);
  const langChips = LANGS.map((l) => {
    const b = el('button', 'settings-chip', langRow) as HTMLButtonElement;
    b.type = 'button';
    b.textContent = l.label;
    b.addEventListener('click', () => { picked = l.id; label(); });
    return { b, id: l.id };
  });

  // Cloudflare's check. The token is asked for when the form opens and waited for, a
  // while, when the form is sent before it has come.
  const checkBox = el('div', 'news-check', d);
  let token = '', widget = '', waiting: ((token: string) => void) | null = null;
  const startCheck = () => {
    if (!SITE_KEY || widget) return;
    loadTurnstile().then(() => {
      widget ||= window.turnstile!.render(checkBox, {
        sitekey: SITE_KEY, theme: 'dark', size: 'flexible', appearance: 'interaction-only', language: getLang(),
        callback: (tk: string) => { token = tk; waiting?.(tk); },
        'expired-callback': () => { token = ''; },
        'error-callback': () => { token = ''; return true; },
      });
    }).catch(() => {});
  };
  const checked = () => (token ? Promise.resolve(token) : new Promise<string>((resolve) => {
    startCheck();
    waiting = resolve;
    setTimeout(() => resolve(''), 15000);
  }));
  // A token is good for one try.
  const again = () => { token = ''; if (widget) window.turnstile?.reset(widget); };
  startCheck();

  const status = el('p', 'news-status', d);
  status.setAttribute('role', 'status');
  const foot = el('p', 'news-foot', d);
  const small = el('span', '', foot);
  privacyLink(foot);

  // What the status line says, kept as the English text so it follows the language.
  let message = '', sending = false, done = false;
  const label = () => {
    email.placeholder = email.ariaLabel = t('Your email address');
    go.textContent = sending ? t('Sending…') : t('Sign up');
    go.disabled = sending;
    status.textContent = message && t(message);
    status.classList.toggle('bad', !done && !!message);
    form.hidden = langRow.hidden = checkBox.hidden = done;
    langName.textContent = t('Emails in');
    for (const { b, id } of langChips) b.setAttribute('aria-pressed', String(id === lang()));
    small.textContent = t('Your address is used only for these emails and is kept by Brevo, the service that sends them. Every email has a link to unsubscribe.');
  };
  onLang(label);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !URL_) return;
    sending = true; message = '';
    label();
    try {
      const tk = SITE_KEY ? await checked() : '';
      if (SITE_KEY && !tk) message = PROBLEMS.check;
      else {
        const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, website: trap.value, lang: lang(), token: tk }) });
        const answer = await res.json().catch(() => ({})) as { error?: string };
        done = res.ok;
        if (done) telemetry.did('signed up for news');
        message = done ? 'Almost done. Open the email that is on its way to you and press the button in it to confirm your address.' : PROBLEMS[answer.error ?? ''] ?? 'Signing up didn\'t work this time. Please try again later.';
      }
    } catch {
      message = 'Signing up didn\'t work this time. Please try again later.';
    }
    if (!done) again();
    else onDone();
    sending = false;
    label();
  });
  return true;
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
