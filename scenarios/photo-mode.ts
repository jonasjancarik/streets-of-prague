import type { Scenario } from '../src/testkit.ts';

// Photo mode (src/photo.ts): C stops the game, hides everything but the picture and frees
// the camera; leaving it puts the clock and the camera back.
const key = (code: string) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));

export default {
  title: 'Photo mode frees the camera, and leaving it puts the clock back',
  async run(t) {
    await t.go('staromak');
    t.time('14:00');
    t.weather('clear');
    const paused = t.paused;
    key('KeyC');
    await t.frames();
    t.check('the screen is cleared for the picture', document.body.classList.contains('photo'));
    t.check('the camera is free', !!t.cam);
    t.check('the game is paused', t.paused);
    const bar = document.getElementById('photo');
    if (!t.check('the bar is there', !!bar)) return;
    const [time, tilt] = [...bar!.querySelectorAll('input')] as HTMLInputElement[];
    time.value = String(19 * 60 + 30);
    time.dispatchEvent(new Event('input'));
    tilt.value = '40';
    tilt.dispatchEvent(new Event('input'));
    await t.frames();
    t.check('the hour follows its slider', t.probe().time === '19:30', t.probe().time);
    t.check('the camera tilts with its slider', Math.abs((t.cam?.tilt ?? 0) - 40) < 0.5, `tilt ${t.cam?.tilt}`);
    await t.shot('photo-mode');
    // A slow WebGPU warm-up can still have its working framebuffer bound. Check
    // the next display draw and the actual PNG produced by the Save button.
    const { renderer } = window.__drive as { renderer: {
      domElement: HTMLCanvasElement; _getFrameBufferTarget?: () => unknown;
      getRenderTarget(): unknown; setRenderTarget(target: unknown): void;
    } };
    const working = renderer._getFrameBufferTarget?.();
    if (working) {
      renderer.setRenderTarget(working);
      await t.frames(4);
      t.check('the next frame draws to the display', renderer.getRenderTarget() === null);
    }
    const original = HTMLAnchorElement.prototype.click;
    let timeout = 0;
    try {
      const file = new Promise<Blob>((resolve, reject) => {
        timeout = window.setTimeout(() => reject(Error('No saved picture')), 30000);
        HTMLAnchorElement.prototype.click = function () {
          if (!this.download.startsWith('streets-of-prague-')) return original.call(this);
          void fetch(this.href).then(r => r.blob()).then(resolve, reject);
        };
      });
      bar!.querySelector<HTMLButtonElement>('button.go')!.click();
      const blob = await file, bitmap = await createImageBitmap(blob);
      try {
        const source = renderer.domElement;
        t.check('the saved PNG has the full canvas dimensions', blob.type === 'image/png' && bitmap.width === source.width && bitmap.height === source.height);
        const probe = document.createElement('canvas'); probe.width = probe.height = 16;
        const ctx = probe.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        const red = data.filter((_, i) => i % 4 === 0);
        t.check('the file contains the rendered city', data[3] > 0 && Math.max(...red) - Math.min(...red) > 12);
      } finally { bitmap.close(); }
    } finally { clearTimeout(timeout); HTMLAnchorElement.prototype.click = original; }
    key('Escape');
    await t.frames();
    t.check('the screen is back', !document.body.classList.contains('photo'));
    t.check('the camera follows you again', !t.cam);
    t.check('the game goes on as it was', t.paused === paused);
    t.check('the clock is back', t.probe().time === '14:00', t.probe().time);
  },
} satisfies Scenario;
