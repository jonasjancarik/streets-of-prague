import * as telemetry from './telemetry.ts';
import { getLang, onLang, t } from './i18n.ts';
import { privacyLink } from './credits.ts';
import { el, sheet, trapField, postForm } from './newsletter.ts';
import { graphicsReport } from './graphicswarning.ts';

declare const __APP_VERSION__: string; // set by vite.config.js
declare const __APP_BUILT__: string;
declare const __DATA_VERSION__: string;

// Telling the author what's wrong or missing: a link in the settings opens a form, and
// the message goes to the site's own /api/feedback (worker/index.js), which emails it
// on. The game adds what a bug report needs and players rarely write: its version, the
// browser and graphics card, how smoothly it runs, anything that went wrong, and where the
// player was. A build with no address for it (local development, or before it's set up:
// deploy/feedback) shows none of this.

const URL_ = import.meta.env.VITE_FEEDBACK_URL as string | undefined;

// The frame rate over the last second or so, and the last few errors the page saw:
// kept as the game runs, for when a message is written.
let fps = 0;
const errors: string[] = [];
if (URL_) {
  let frames = 0, since = performance.now();
  const tick = (now: number) => {
    frames++;
    if (now - since >= 1000) { fps = Math.round(frames * 1000 / (now - since)); frames = 0; since = now; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const keep = (what: unknown) => {
    const at = Math.round(performance.now() / 1000);
    errors.push(`${at} s: ${String(what).slice(0, 300)}`);
    if (errors.length > 5) errors.shift();
  };
  window.addEventListener('error', (e) => keep(e.message ? `${e.message} (${e.filename.split('/').pop()}:${e.lineno})` : 'a file failed to load'));
  window.addEventListener('unhandledrejection', (e) => keep(e.reason instanceof Error ? e.reason.message : e.reason));
}

// How the form gets a picture of the game: main.ts says how once the game is running.
let screenshot: () => Promise<string | null> = async () => null;
export const setScreenshot = (fn: () => Promise<string | null>) => { screenshot = fn; };

// The graphics card, as the browser names it (it may decline to).
function card() {
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  return name || 'not named by the browser';
}

const duration = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

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
  // Each of the rest may not be there (the start screen, a browser that won't say) and
  // must never stop a message.
  try { lines.push(`Graphics card: ${card()}`); } catch {}
  try { lines.push(extra()); } catch {}
  const drawing = graphicsReport();
  if (drawing) lines.push(drawing);
  lines.push(`Running at ${fps} frames a second · page open for ${duration(performance.now() / 1000)}`);
  const tally = document.getElementById('tally')?.textContent;
  if (tally) lines.push(`Tally: ${tally}`);
  lines.push(errors.length ? `Errors (seconds since the page opened):\n${errors.map((e) => `  ${e}`).join('\n')}` : 'No errors seen');
  return lines.join('\n');
}

// What the player was looking at when they opened the form: a picture of the game, and the
// situation as a scenario that replays it (testkit.ts's snapshot).
function look() {
  let scenario = '';
  try { scenario = window.__test?.snapshot() ?? ''; } catch {}
  return { picture: screenshot().catch(() => null), scenario };
}

function build(extra: () => string, seen: () => ReturnType<typeof look>) {
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
  const foot = el('p', 'news-foot', d);
  const small = el('span', '', foot);
  privacyLink(foot);

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
    small.textContent = t('A picture of the game, its version, your browser and where you are in the game are sent along, to help find the problem.');
  };
  onLang(label);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending || !URL_) return;
    sending = true; note = '';
    label();
    try {
      const { picture, scenario } = seen();
      const answer = await postForm(URL_, { message: message.value, email: email.value, website: trap.value, lang: getLang(), context: context(extra), scenario, screenshot: await picture });
      done = answer.ok;
      if (done) telemetry.did('sent feedback');
      note = done ? 'Thank you. Your message is on its way.' : PROBLEMS[answer.error ?? ''] ?? FAILED;
    } catch (error) {
      note = error instanceof DOMException && error.name === 'TimeoutError'
        ? 'We couldn\'t confirm whether your message arrived. Your message is still here if you want to try again.'
        : FAILED;
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

// Whether the form is on screen: the game stands still behind it, as it does behind the settings.
let form: HTMLDialogElement | null = null;
export const feedbackOpen = () => !!form?.open;

// The link that opens the form, added to `parent` (nothing, where feedback isn't set
// up). `extra` is a line about the game's state to send along.
export function feedbackLink(parent: HTMLElement, cls: string, { before = () => {}, extra = (): string => '' } = {}) {
  if (!URL_) return null;
  const link = el('button', cls, parent) as HTMLButtonElement;
  link.type = 'button';
  onLang(() => { link.textContent = t('Send feedback'); });
  let seen: ReturnType<typeof look> | null = null;
  const open = () => {
    seen = look(); // before the settings close and the form covers the game
    before();
    form ??= build(extra, () => seen ?? look());
    form.showModal();
  };
  link.addEventListener('click', open);
  return open;
}
