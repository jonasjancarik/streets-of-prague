import type { PerspectiveCamera } from 'three';
import type { Walker } from '../src/people.ts';
import type { Sound } from '../src/audio.ts';
import { sourcePan } from '../src/soundmix.ts';
import { initialView } from '../src/streetView.ts';
import type { Scenario } from '../src/testkit.ts';
import { t as translate } from '../src/i18n.ts';

export default {
  title: 'Choose first person, walk, jump and turn toward a sound',
  async run(t) {
    const { walker, sound, camera } = window.__drive as { walker: Walker; sound: Sound; camera: PerspectiveCamera };
    const saved = localStorage.getItem('playerView'), paused = t.paused;
    const step = sound.footfall, contacts: string[] = [];
    sound.footfall = kind => { contacts.push(kind); };
    const settings = document.querySelector<HTMLDialogElement>('dialog.settings')!;
    const viewButton = (name: string) => [...settings.querySelectorAll<HTMLButtonElement>('.settings-chip')].find(b => b.textContent === translate(name))!;
    const openSettings = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    try {
      t.paused = true;
      await t.go('staromak', { heading: 0 });
      openSettings();
      t.check('Escape opens the normal settings', settings.open);
      viewButton('First person').click();
      t.check('the choice is saved and reported by the settings', initialView(new URLSearchParams()) === 'first' && viewButton('First person').ariaPressed === 'true');
      settings.close();
      await t.wait(0.1);
      await t.frames(10);
      t.check('on foot the overhead ring and speedometer disappear', !walker.ring.visible && getComputedStyle(document.querySelector('#speedo')!).display === 'none');
      t.check('facing north puts east in the right ear', !!sound.right && sourcePan(8, 0, 8, 25, sound.right) > 0.8);
      const startY = walker.y;
      await t.wait(1.4, { move: 1 });
      t.check('walking covers ground and sounds individual steps', walker.y > startY + 2 && contacts.filter(k => k === 'step').length >= 2);
      const heading = walker.h, startX = walker.x;
      await t.wait(0.8, { turn: -1 });
      t.check('strafing right moves east without turning', walker.x > startX + 1 && Math.abs(walker.h - heading) < 0.001);
      await t.wait(0.5);
      contacts.length = 0;
      await t.wait(0.8);
      t.check('standing still is quiet', !contacts.length);
      await t.wait(1 / 60, { jump: true });
      await t.wait(0.3);
      t.check('airborne feet make no steps', walker.jumping && !contacts.length);
      await t.wait(1.6);
      t.check('the jump has one landing', contacts.join() === 'land', contacts.join());
      t.eyes!.yaw = 180;
      await t.wait(1 / 60);
      await t.frames(4);
      t.check('turning around swaps the side of the same sound', !!sound.right && sourcePan(8, 0, 8, 25, sound.right) < -0.8);
      openSettings();
      viewButton('From above').click();
      settings.close();
      await t.frames(4);
      t.check('returning overhead restores the ring, camera and map stereo', walker.ring.visible && camera.fov === 38 && !sound.right);
    } finally {
      if (settings.open) settings.close();
      sound.footfall = step;
      t.eyes = null;
      t.paused = paused;
      if (saved === null) localStorage.removeItem('playerView');
      else localStorage.setItem('playerView', saved);
    }
  },
} satisfies Scenario;
