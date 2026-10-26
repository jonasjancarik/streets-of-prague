// A warning on the start screen when the game can't draw the way it's made to: the browser
// draws without the graphics card (hardware acceleration off, a missing driver, a virtual
// machine), or WebGPU didn't start and the game fell back to the old WebGL renderer, which
// is no longer kept up to date. Either can mean a game that runs at a few frames a second
// with no error anywhere, so the player hears why and what to try. renderer.ts reports it;
// ?renderer=webgl asks for WebGL on purpose and gets no warning.
import { onLang, t } from './i18n.ts';

export type Trouble = 'software' | 'webgl';

// Software renderers by the names browsers give them: Windows' WARP, Chrome's SwiftShader,
// Mesa's llvmpipe/softpipe/lavapipe, Apple's software renderer.
const SOFTWARE = /basic render|swiftshader|llvmpipe|softpipe|lavapipe|software/i;
export const isSoftware = (gpu: string) => SOFTWARE.test(gpu);

const TEXT: Record<Trouble, string> = {
  software: 'This browser isn\'t using the graphics card, so the game will run very slowly. Turn on hardware acceleration in the browser\'s settings and restart the browser. If that doesn\'t help, update the graphics card driver.',
  webgl: 'This browser didn\'t start the game\'s usual graphics (WebGPU), so the game is using an older mode it isn\'t made for: it may run slowly or look wrong. The latest Chrome or Edge works best.',
};

let trouble: Trouble | null = null;
const listeners: (() => void)[] = [];

export function reportTrouble(kind: Trouble) {
  if (trouble === 'software') return; // the worse of the two stays
  trouble = kind;
  for (const f of listeners) f();
}

// A line hidden until there's something to warn about.
export function graphicsWarning(parent: HTMLElement, cls: string) {
  const line = document.createElement('p');
  line.className = cls;
  line.hidden = true;
  line.setAttribute('role', 'status');
  parent.appendChild(line);
  const show = () => {
    line.hidden = !trouble;
    if (trouble) line.textContent = t(TEXT[trouble]);
  };
  listeners.push(show);
  onLang(show);
  return line;
}
