import { CS } from './cs.ts';

// English and Czech. Every line of text in the game is written in English in the code
// and looked up here by that English text: `t('Taxi cancelled')` gives the Czech line
// (from cs.ts) when Czech is picked, and the English text itself when there is no
// Czech for it. `{name}` in a line is filled from the second argument. In index.html an
// element marked `data-t` is translated the same way (by its own text, or by the id
// given as the attribute's value); `data-t-label` does that for an aria-label.
//
// Which language: ?lang=cs or ?lang=en, else the one picked last time (the start
// screen has the choice), else Czech if the browser is set to Czech.

export type Lang = 'en' | 'cs';
export const LANGS: { id: Lang; label: string }[] = [{ id: 'en', label: 'English' }, { id: 'cs', label: 'Čeština' }];

const stored = () => { try { return localStorage.getItem('lang'); } catch { return null; } };
const pick = (): Lang => {
  const asked = new URLSearchParams(location.search).get('lang') ?? stored() ?? navigator.language;
  return asked.toLowerCase().startsWith('cs') ? 'cs' : 'en';
};

let lang: Lang = pick();
const listeners: (() => void)[] = [];

export const getLang = () => lang;

// Run `f` now and again whenever the language is changed.
export function onLang(f: () => void) {
  listeners.push(f);
  f();
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s);

export function t(en: string, vars?: Record<string, string | number>) {
  const cs = lang === 'cs' ? CS[en] : undefined;
  return fill(typeof cs === 'string' ? cs : en, vars);
}

// A line that depends on a count: 'one|other' in English, and 'one|few|many' in the
// Czech entry (1 auto, 2–4 auta, 5 aut). `{n}` is the count.
export function tn(n: number, en: string) {
  const [one, other] = en.split('|');
  const cs = lang === 'cs' ? CS[en] : undefined;
  if (typeof cs === 'string') {
    const [a, few, many] = cs.split('|');
    return fill(n === 1 ? a : n >= 2 && n <= 4 ? few : many, { n });
  }
  return fill(n === 1 ? one : other, { n });
}

function translateStatic() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
    el.dataset.en ??= el.innerHTML;
    const cs = lang === 'cs' ? CS[el.dataset.t || el.dataset.en] : undefined;
    el.innerHTML = typeof cs === 'string' ? cs : el.dataset.en;
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-t-label]')) {
    el.dataset.enLabel ??= el.getAttribute('aria-label') ?? '';
    el.setAttribute('aria-label', t(el.dataset.enLabel));
  }
}

export function setLang(next: Lang) {
  if (next === lang) return;
  lang = next;
  try { localStorage.setItem('lang', lang); } catch {}
  translateStatic();
  for (const f of listeners) f();
}

// Once the page's own markup is there (and again for anything added with data-t).
export const translatePage = translateStatic;
