// The Worker in front of the site on Cloudflare. The game's files are served as static
// assets without it (scripts/deploy-cloudflare.sh sends only /api/* here); it takes the
// two forms in the game, and the game's anonymous statistics (worker/stats.js):
//
//   POST /api/subscribe  { email, lang, token }
//   GET  /api/confirm    ?t=<the signed token from the confirmation email>
//   POST /api/feedback   { message, email?, context?, scenario?, screenshot?, lang }
//   POST /api/report     one statistics report
//
// A signup is answered with a confirmation email sent from here (Cloudflare's email
// sending). The link in it carries the address in a signed token, so nothing is stored; the
// address is added to the Brevo list only when the link is opened. With Turnstile set up, a
// signup also has to carry a token showing it came from a real browser. Feedback is sent on as an email to the game's
// author. Nothing is stored here, and the game only ever talks to these two addresses,
// so either can move to another service without the game changing.
//
// Settings (deploy/newsletter, deploy/feedback and two secrets; see the player-forms
// skill, .agents/skills/player-forms/SKILL.md):
//   BREVO_API_KEY               secret
//   BREVO_LIST_ID               the list new contacts join
//   CONFIRM_SECRET              secret: signs the links in the confirmation emails
//   NEWS_EMAIL                  Cloudflare's email sending, to any address, for confirmations
//   NEWS_FROM                   the address confirmations come from
//   BREVO_LANGUAGE_ATTRIBUTE    the contact attribute that gets "en" or "cs", if there is one
//   TURNSTILE_SITE_KEY          the Turnstile widget in the signup form, if there is one,
//   TURNSTILE_SECRET_KEY        and its secret
//   EMAIL                       Cloudflare's email sending, for feedback
//   FEEDBACK_ARCHIVE            R2 bucket streets-of-prague-mail, where each message is also kept
//   FEEDBACK_TO, FEEDBACK_FROM  who gets the feedback, and the address it comes from
//   RATE                        rate limiter, per visitor address
//   TELEMETRY                   the Analytics Engine dataset the statistics go to

import { report, OTHER_ORIGINS } from './stats.js';

const BREVO = 'https://api.brevo.com/v3/contacts';
// How long the link in a confirmation email works.
const LINK_DAYS = 7;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const JPEG = 'data:image/jpeg;base64,';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FORMS = { '/api/subscribe': subscribe, '/api/feedback': feedback };

// What both forms need settled before they look at what was sent.
async function form(request, env, handle) {
  const here = new URL(request.url).origin;
  const origin = request.headers.get('Origin') ?? '';
  // Only the game's own pages may use the forms.
  if (origin !== here && !OTHER_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403);
  const cors = origin === here ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);

  // Every use sends an email, a signup to whatever address was typed, so one visitor
  // gets few tries.
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (env.RATE) {
    const { success } = await env.RATE.limit({ key: ip || 'unknown' });
    if (!success) return json({ error: 'busy' }, 429, cors);
  }
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') return json({ error: 'invalid' }, 400, cors);
  const [answer, status] = await handle(body, env, origin, ip, here);
  return json(answer, status, cors);
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const address = (v) => { const s = text(v, 255); return s.length <= 254 && EMAIL.test(s) ? s : ''; };

// Did the token come from the Turnstile widget on our page, just now, and unused?
async function human(token, env, ip) {
  if (!token) return false;
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
    });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

async function subscribe(body, env, origin, ip, here) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.NEWS_EMAIL || !env.NEWS_FROM || !env.CONFIRM_SECRET) return [{ error: 'unavailable' }, 503];
  // The form shows the widget but there is no secret to check its token with: refuse
  // rather than let everything through.
  if (env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY) return [{ error: 'unavailable' }, 503];
  const email = address(body.email);
  if (!email) return [{ error: 'email' }, 400];
  // A field people don't see and scripts fill in: say yes and do nothing.
  if (body.website) return [{ ok: true }, 200];
  if (env.TURNSTILE_SECRET_KEY && !await human(text(body.token, 2048), env, ip)) return [{ error: 'check' }, 403];

  // The language picked in the form: of the confirmation email, and kept with the
  // contact so later emails can go out in it.
  const lang = body.lang === 'cs' ? 'cs' : 'en';
  const token = await sign({ e: email, l: lang, o: origin, x: Date.now() + LINK_DAYS * 864e5 }, env);
  const mail = confirmation(`${here}/api/confirm?t=${token}`, lang);
  try {
    await env.NEWS_EMAIL.send({ to: email, from: { email: env.NEWS_FROM, name: 'Streets of Prague' }, ...mail });
  } catch (e) {
    console.error(`Sending the confirmation failed: ${e?.message ?? e}`);
    return [{ error: 'failed' }, 502];
  }
  return [{ ok: true }, 200];
}

const EN = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const hmac = (env) => crypto.subtle.importKey('raw', EN.encode(env.CONFIRM_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// A signup as a token that can't be forged or changed: the data, then its signature.
async function sign(data, env) {
  const body = b64(EN.encode(JSON.stringify(data)));
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(env), EN.encode(body))))}`;
}

// The data in a token, or null if it was altered, is not ours, or has run out.
async function unsign(token, env) {
  try {
    const [body, sig] = token.split('.');
    if (!await crypto.subtle.verify('HMAC', await hmac(env), unb64(sig), EN.encode(body))) return null;
    const data = JSON.parse(new TextDecoder().decode(unb64(body)));
    return data.x > Date.now() && address(data.e) ? data : null;
  } catch {
    return null;
  }
}

function confirmation(link, lang) {
  const cs = lang === 'cs';
  const lines = cs
    ? ['Ahoj,', 'někdo (snad ty) zadal tuto adresu pro novinky ze hry Streets of Prague. Potvrď ji prosím tímto odkazem:', link, 'Když ses nepřihlašoval(a), nic dělat nemusíš. Nic ti pak nepošleme.']
    : ['Hello,', 'someone (hopefully you) entered this address to get news about the game Streets of Prague. Please confirm it with this link:', link, 'If that wasn\'t you, there is nothing to do. We won\'t send you anything.'];
  const html = (cs ? 'Ahoj,' : 'Hello,') + `<p>${lines[1]}</p><p><a href="${link}">${cs ? 'Potvrdit adresu' : 'Confirm my address'}</a></p><p>${lines[3]}</p>`;
  return {
    subject: cs ? 'Potvrď svůj e-mail pro novinky ze Streets of Prague' : 'Confirm your email for Streets of Prague news',
    text: lines.join('\n\n'),
    html,
  };
}

// The link in the email: adds the address to the list and sends the player back to the
// game, which says it worked (or that the link didn't).
async function confirm(request, env) {
  const url = new URL(request.url);
  const data = env.CONFIRM_SECRET && env.BREVO_API_KEY && env.BREVO_LIST_ID ? await unsign(url.searchParams.get('t') ?? '', env) : null;
  const back = data && (data.o === url.origin || OTHER_ORIGINS.includes(data.o)) ? data.o : url.origin;
  const go = (state) => new Response(null, { status: 303, headers: { Location: `${back}/?subscribed${state}`, 'Cache-Control': 'no-store' } });
  if (!data) return go('=failed');
  const res = await fetch(BREVO, {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email: data.e,
      listIds: [Number(env.BREVO_LIST_ID)],
      // Opening the link twice, or signing up again later, is not a problem.
      updateEnabled: true,
      ...(env.BREVO_LANGUAGE_ATTRIBUTE ? { attributes: { [env.BREVO_LANGUAGE_ATTRIBUTE]: data.l } } : {}),
    }),
  });
  if (res.ok) return go('');
  const problem = await res.json().catch(() => ({}));
  console.error(`Brevo answered ${res.status} ${problem.code ?? ''}: ${problem.message ?? ''}`);
  return go('=failed');
}

async function feedback(body, env, origin, ip, here) {
  if (!env.EMAIL || !env.FEEDBACK_TO || !env.FEEDBACK_FROM) return [{ error: 'unavailable' }, 503];
  const message = text(body.message, 5000);
  if (!message) return [{ error: 'message' }, 400];
  // The address is optional, for an answer; one that was typed has to be a real one.
  const email = address(body.email);
  if (text(body.email, 1) && !email) return [{ error: 'email' }, 400];
  if (body.website) return [{ ok: true }, 200];

  // What the game adds by itself: its version, the browser, where the player was.
  const context = text(body.context, 4000);
  const first = message.split('\n')[0];
  // The beta's messages say so, in the subject and the archive.
  const site = origin === here || !origin ? '' : new URL(origin).hostname;
  // A copy for the feedback viewer (scripts/feedback-viewer.mjs), which also keeps its own
  // feedback-state.json beside these. Losing the copy never stops the email.
  // The game's situation as a scenario that replays it (scenarios/, scripts/scene.mjs), and a
  // picture of the game at the moment of sending, kept beside the copy (outside feedback/, so
  // the viewer's listing doesn't see it). Both are optional.
  const scenario = text(body.scenario, 4000);
  let picture = null;
  if (typeof body.screenshot === 'string' && body.screenshot.length <= 2_500_000 && body.screenshot.startsWith(JPEG)) {
    try { picture = Uint8Array.from(atob(body.screenshot.slice(JPEG.length)), (c) => c.charCodeAt(0)); } catch { /* not an image */ }
  }
  let screenshot = '';
  if (env.FEEDBACK_ARCHIVE) {
    const now = new Date();
    const name = `${now.toISOString().slice(0, 10)}/${now.getTime()}-${crypto.randomUUID()}`;
    try {
      if (picture) {
        await env.FEEDBACK_ARCHIVE.put(`feedback-shots/${name}.jpg`, picture, { httpMetadata: { contentType: 'image/jpeg' } });
        screenshot = `feedback-shots/${name}.jpg`;
      }
    } catch (e) {
      console.error(`Archiving the screenshot failed: ${e?.message ?? e}`);
    }
    try {
      await env.FEEDBACK_ARCHIVE.put(`feedback/${name}.json`,
        JSON.stringify({ time: now.toISOString(), site, message, email, context, scenario, screenshot, lang: text(body.lang, 8) }), { httpMetadata: { contentType: 'application/json' } });
    } catch (e) {
      console.error(`Archiving feedback failed: ${e?.message ?? e}`);
    }
  }
  try {
    await env.EMAIL.send({
      to: env.FEEDBACK_TO,
      from: { email: env.FEEDBACK_FROM, name: 'Streets of Prague' },
      // Replying to the email answers the player.
      ...(email ? { replyTo: email } : {}),
      subject: `${site ? `[${site}] ` : ''}Feedback: ${first.length > 70 ? `${first.slice(0, 70)}…` : first}`,
      text: `${message}\n\n--\nFrom: ${email || 'no address given'}\n${context}${scenario ? `\n\n${scenario}` : ''}${screenshot ? '\n\nA screenshot is in the feedback viewer.' : ''}`,
    });
  } catch (e) {
    console.error(`Sending feedback failed: ${e?.message ?? e}`);
    return [{ error: 'failed' }, 502];
  }
  return [{ ok: true }, 200];
}

const json = (data, status, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/report') return report(request, env);
    if (path === '/api/confirm' && request.method === 'GET') return confirm(request, env);
    const handle = FORMS[path];
    if (handle) return form(request, env, handle);
    return env.ASSETS.fetch(request);
  },
};
