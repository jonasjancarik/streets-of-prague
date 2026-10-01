// The Worker in front of the site on Cloudflare. The game's files are served as static
// assets without it (scripts/deploy-cloudflare.sh sends only /api/* here); its one job
// is the newsletter signup:
//
//   POST /api/subscribe  { email, lang }
//
// It hands the address to Brevo, which sends the confirmation email; nobody is on the
// list until they click the link in it, and nothing is stored here. The game only ever
// talks to this address, so the newsletter can move to another service without the
// game changing.
//
// Settings (deploy/newsletter and a secret, see the README's "Newsletter"):
//   BREVO_API_KEY               secret
//   BREVO_LIST_ID               the list new contacts join
//   BREVO_DOI_TEMPLATE_ID       the confirmation email
//   BREVO_DOI_TEMPLATE_ID_CS    the same in Czech, if there is one
//   RATE                        rate limiter, per visitor address

// The beta is served from mbxp, with no Worker of its own, and signs up through this one.
const OTHER_ORIGINS = ['https://beta.streetsofprague.com', 'https://streets-beta.jonasjancarik.cz'];
const BREVO = 'https://api.brevo.com/v3/contacts/doubleOptinConfirmation';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function subscribe(request, env) {
  const here = new URL(request.url).origin;
  const origin = request.headers.get('Origin') ?? '';
  // Only the game's own pages may sign people up.
  if (origin !== here && !OTHER_ORIGINS.includes(origin)) return json({ error: 'origin' }, 403);
  const cors = origin === here ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
  }
  if (request.method !== 'POST') return json({ error: 'method' }, 405, cors);
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.BREVO_DOI_TEMPLATE_ID) return json({ error: 'unavailable' }, 503, cors);

  // Each signup sends an email to whatever address was typed, so one visitor gets few tries.
  if (env.RATE) {
    const { success } = await env.RATE.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
    if (!success) return json({ error: 'busy' }, 429, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'email' }, 400, cors); }
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (email.length > 254 || !EMAIL.test(email)) return json({ error: 'email' }, 400, cors);
  // A field people don't see and scripts fill in: say yes and do nothing.
  if (body.website) return json({ ok: true }, 200, cors);

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
  if (res.ok) return json({ ok: true }, 200, cors);
  const problem = await res.json().catch(() => ({}));
  console.error(`Brevo answered ${res.status} ${problem.code ?? ''}: ${problem.message ?? ''}`);
  // Brevo checks addresses more strictly than the pattern above.
  if (res.status === 400 && /email/i.test(problem.message ?? '')) return json({ error: 'email' }, 400, cors);
  return json({ error: 'failed' }, 502, cors);
}

const json = (data, status, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/subscribe') return subscribe(request, env);
    return env.ASSETS.fetch(request);
  },
};
