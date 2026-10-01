// The Worker in front of the site on Cloudflare. The game's files are served as static
// assets without it (scripts/deploy-cloudflare.sh sends only /api/* here); it takes the
// two forms in the game:
//
//   POST /api/subscribe  { email, lang }
//   POST /api/feedback   { message, email?, context?, lang }
//
// A signup is handed to Brevo, which sends the confirmation email; nobody is on the
// list until they click the link in it. Feedback is sent on as an email to the game's
// author. Nothing is stored here, and the game only ever talks to these two addresses,
// so either can move to another service without the game changing.
//
// Settings (deploy/newsletter, deploy/feedback and a secret; see the README's
// "Newsletter and feedback"):
//   BREVO_API_KEY               secret
//   BREVO_LIST_ID               the list new contacts join
//   BREVO_DOI_TEMPLATE_ID       the confirmation email
//   BREVO_DOI_TEMPLATE_ID_CS    the same in Czech, if there is one
//   EMAIL                       Cloudflare's email sending, for feedback
//   FEEDBACK_TO, FEEDBACK_FROM  who gets the feedback, and the address it comes from
//   RATE                        rate limiter, per visitor address

// The beta is served from mbxp, with no Worker of its own, and signs up through this one.
const OTHER_ORIGINS = ['https://beta.streetsofprague.com', 'https://streets-beta.jonasjancarik.cz'];
const BREVO = 'https://api.brevo.com/v3/contacts/doubleOptinConfirmation';
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
  if (env.RATE) {
    const { success } = await env.RATE.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
    if (!success) return json({ error: 'busy' }, 429, cors);
  }
  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') return json({ error: 'invalid' }, 400, cors);
  const [answer, status] = await handle(body, env, origin);
  return json(answer, status, cors);
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const address = (v) => { const s = text(v, 255); return s.length <= 254 && EMAIL.test(s) ? s : ''; };

async function subscribe(body, env, origin) {
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.BREVO_DOI_TEMPLATE_ID) return [{ error: 'unavailable' }, 503];
  const email = address(body.email);
  if (!email) return [{ error: 'email' }, 400];
  // A field people don't see and scripts fill in: say yes and do nothing.
  if (body.website) return [{ ok: true }, 200];

  const template = (body.lang === 'cs' && env.BREVO_DOI_TEMPLATE_ID_CS) || env.BREVO_DOI_TEMPLATE_ID;
  const res = await fetch(BREVO, {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email,
      includeListIds: [Number(env.BREVO_LIST_ID)],
      templateId: Number(template),
      // Where the link in the email leads: back to the game, which says thanks.
      redirectionUrl: `${origin}/?subscribed`,
    }),
  });
  if (res.ok) return [{ ok: true }, 200];
  const problem = await res.json().catch(() => ({}));
  console.error(`Brevo answered ${res.status} ${problem.code ?? ''}: ${problem.message ?? ''}`);
  // Brevo checks addresses more strictly than the pattern above.
  if (res.status === 400 && /email/i.test(problem.message ?? '')) return [{ error: 'email' }, 400];
  return [{ error: 'failed' }, 502];
}

async function feedback(body, env) {
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
  try {
    await env.EMAIL.send({
      to: env.FEEDBACK_TO,
      from: { email: env.FEEDBACK_FROM, name: 'Streets of Prague' },
      // Replying to the email answers the player.
      ...(email ? { replyTo: email } : {}),
      subject: `Feedback: ${first.length > 70 ? `${first.slice(0, 70)}…` : first}`,
      text: `${message}\n\n--\nFrom: ${email || 'no address given'}\n${context}`,
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
    const handle = FORMS[new URL(request.url).pathname];
    if (handle) return form(request, env, handle);
    return env.ASSETS.fetch(request);
  },
};
