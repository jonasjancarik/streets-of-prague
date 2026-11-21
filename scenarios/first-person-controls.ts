import type { PerspectiveCamera } from 'three';
import type { Scenario } from '../src/testkit.ts';
import { firstPersonOptions, setFirstPersonOptions } from '../src/streetView.ts';
import { t as translate } from '../src/i18n.ts';

export default {
  title: 'Adjust first-person controls and switch views from the keyboard',
  async run(t) {
    await t.go('staromak');
    const g = window.__drive as { camera: PerspectiveCamera; renderer: { domElement: HTMLCanvasElement } };
    const saved = { ...firstPersonOptions },
      savedJSON = localStorage.getItem('firstPersonOptions'),
      savedView = localStorage.getItem('playerView');
    const wasPaused = t.paused, settings = document.querySelector<HTMLDialogElement>('dialog.settings')!;
    const key = (code: string, metaKey = false) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { code, metaKey, bubbles: true }));
    try {
      t.paused = true;
      t.eyes = null;
      key('KeyV');
      await t.frames(3);
      t.check('V enters first person on foot', !!t.eyes && g.camera.fov !== 38);
      key('KeyV', true);
      await t.frames(2);
      t.check('the paste shortcut leaves the camera alone', !!t.eyes && localStorage.getItem('playerView') === 'first');
      key('Escape');
      const details = settings.querySelector<HTMLInputElement>('[data-camera="fov"]')!.closest('details')!;
      details.open = true;
      for (const [k, value] of [['fov', '69'], ['sensitivity', '150']]) {
        const slider = settings.querySelector<HTMLInputElement>(`[data-camera="${k}"]`)!;
        slider.value = value;
        slider.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const motion = settings.querySelector<HTMLSelectElement>('[data-camera="motion"]')!;
      motion.value = 'steady';
      motion.dispatchEvent(new Event('change', { bubbles: true }));
      t.check('the chosen controls are saved', JSON.parse(localStorage.getItem('firstPersonOptions')!).motion === 'steady');
      settings.close();
      await t.frames(3);
      t.check('the walking view uses the selected vertical field of view', g.camera.fov === 69);
      const canvas = g.renderer.domElement, eyes = t.eyes as { yaw: number; pitch: number } | null;
      if (!eyes) return;
      const pointer = (name: string, x: number, y: number) =>
        canvas.dispatchEvent(
          new PointerEvent(name, { pointerType: 'mouse', pointerId: 88, button: 2, clientX: x, clientY: y, bubbles: true }),
        );
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 180, 600);
      pointer('pointerup', 180, 600);
      t.check(
        'sensitivity scales real mouse movement and the player can look down at their feet',
        Math.abs(eyes.yaw + 30) < .01 && eyes.pitch === -82,
        { yaw: eyes.yaw, pitch: eyes.pitch },
      );
      key('KeyV');
      await t.frames(3);
      t.check(
        'third person keeps its own lens',
        localStorage.getItem('playerView') === 'third' && Number(g.camera.fov) === 55,
      );
      key('KeyV');
      await t.frames(3);
      t.check('the next press restores the overhead view', !t.eyes && Number(g.camera.fov) === 38);
      key('Escape');
      t.check(
        'first-person controls are tucked away in overhead view',
        details.hidden &&
          [...settings.querySelectorAll('button')].some((b) =>
            b.textContent === translate('Overhead') && b.ariaPressed === 'true'
          ),
      );
    } finally {
      if (settings.open) settings.close();
      setFirstPersonOptions(saved, false);
      if (savedJSON === null) localStorage.removeItem('firstPersonOptions');
      else localStorage.setItem('firstPersonOptions', savedJSON);
      if (savedView === null) localStorage.removeItem('playerView');
      else localStorage.setItem('playerView', savedView);
      t.eyes = null;
      t.paused = wasPaused;
    }
  },
} satisfies Scenario;
