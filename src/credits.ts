// Credits: the line in the corner (index.html) names where the map comes from, as
// OpenStreetMap's ODbL and the CC BY licences ask; clicking it opens the full list,
// with the licences and a link to the libraries' licence texts (licenses.txt, which
// the build writes; see vite.config.js).

const button = document.getElementById('credits');
const box = document.getElementById('credits-box');
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
