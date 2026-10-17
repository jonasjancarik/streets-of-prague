// Credits: the line in the corner (index.html) names where the map comes from, as
// OpenStreetMap's ODbL and the CC BY licences ask; clicking it opens the full list,
// with the licences and a link to the libraries' licence texts (licenses.txt, which
// the build writes; see vite.config.js). Under them is the privacy note, which the
// newsletter and feedback forms link to.
import { onLang, t } from './i18n.ts';

const button = document.getElementById('credits');
const box = document.getElementById('credits-box');
export const creditsOpen = () => box instanceof HTMLDialogElement && box.open;
if (button && box instanceof HTMLDialogElement) {
  button.addEventListener('click', () => {
    button.blur(); // or Space, the handbrake, would press it again
    box.showModal();
  });
  // While it's open, keys don't reach the game (Escape still closes it). Key releases
  // still do, so nothing held down when it opened stays held.
  box.addEventListener('keydown', (e) => e.stopPropagation());
  // A click on the dimmed game around it closes it too.
  box.addEventListener('click', (e) => {
    const r = box.getBoundingClientRect();
    if (e.target === box && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) box.close();
  });
}

// The privacy note at the end of the credits, for the forms that take an email address.
export function privacyLink(parent: HTMLElement) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'news-privacy';
  parent.appendChild(link);
  onLang(() => { link.textContent = t('Privacy'); });
  link.addEventListener('click', () => {
    if (!(box instanceof HTMLDialogElement)) return;
    if (!box.open) box.showModal();
    document.getElementById('privacy')?.scrollIntoView();
  });
}
