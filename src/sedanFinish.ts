// The integer part of "painted" already carries body paint, lamp and damage
// tags. Its spare fractional bits distinguish the fitted sedan's surfaces.
import * as THREE from 'three';

export const SEDAN_FINISH = { paint: 1, metal: 2, fabric: 3, rubber: 4, optic: 5, dash: 6, rearGlass: 7, cover: 8 };
export function sedanFinish(name: string) {
  if (name === 'RearWindow') return SEDAN_FINISH.rearGlass;
  if (name === 'LensCover') return SEDAN_FINISH.cover;
  if (name === 'Paint') return SEDAN_FINISH.paint;
  if (['Polished', 'Nickel', 'BrakeSteel', 'MirrorGlass'].includes(name)) return SEDAN_FINISH.metal;
  if (['Cloth', 'Upholstery', 'Carpet', 'Stitch'].includes(name)) return SEDAN_FINISH.fabric;
  if (['LensRed', 'Ruby', 'Reflector', 'Lamp', 'Tail', 'AmberCell'].includes(name)) return SEDAN_FINISH.optic;
  if (name === 'GaugeFace' || name === 'DisplayFace') return SEDAN_FINISH.dash;
  return SEDAN_FINISH.rubber;
}

let instruments: THREE.CanvasTexture | undefined;
export function sedanInstruments() {
  if (instruments) return instruments;
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#12191e'; g.fillRect(0, 0, 512, 256);
  // Printed graduations. The speed needle is drawn in the material using the
  // vehicle's actual speed; u/v have the same axes as this face seen by its driver.
  {
    const cx = 256, limit = 240, label = 'km/h';
    g.strokeStyle = '#627078'; g.lineWidth = 2; g.beginPath(); g.ellipse(cx, 78, 66, 64, 0, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i <= 32; i++) {
      const angle = (136 + i * 268 / 32) * Math.PI / 180, major = i % 4 === 0, r = major ? 50 : 56;
      g.strokeStyle = '#b9c3bd'; g.lineWidth = major ? 2 : 1;
      g.beginPath(); g.moveTo(cx + Math.cos(angle) * r, 78 + Math.sin(angle) * r);
      g.lineTo(cx + Math.cos(angle) * 61, 78 + Math.sin(angle) * 61); g.stroke();
      if (major) {
g.fillStyle = '#ced5cf'; g.font = '12px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(limit * i / 32), cx + Math.cos(angle) * 41, 78 + Math.sin(angle) * 41);
}
    }
    g.fillStyle = '#889b9f'; g.font = '9px Arial'; g.textAlign = 'center'; g.fillText(label, cx, 103);
  }
  g.fillStyle = '#2b393e'; g.fillRect(56, 72, 95, 2); g.fillRect(361, 72, 95, 2);
  for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#39484c' : '#5c6969'; g.fillRect(59 + i * 11, 82, 7, 3); g.fillRect(365 + i * 11, 82, 7, 3); }
  // A subdued road diagram in the centre display, with a single position mark.
  g.fillStyle = '#1b272e'; g.fillRect(0, 166, 512, 90);
  g.save(); g.beginPath(); g.rect(0, 166, 512, 90); g.clip();
  for (let j = 0; j < 10; j++) {
g.strokeStyle = j % 3 ? '#40515a' : '#657780'; g.lineWidth = j % 3 ? 2 : 4; g.beginPath();
    g.moveTo(j * 72 - 95, 165); g.bezierCurveTo(j * 72 - 43, 188, j * 72 - 65, 216, j * 72 + 45, 258); g.stroke();
}
  for (let j = 0; j < 4; j++) {
g.strokeStyle = '#3c4b51'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 177 + j * 20);
    g.bezierCurveTo(118, 147 + j * 20, 374, 227 + j * 20, 512, 185 + j * 20); g.stroke();
}
  g.fillStyle = '#87c2ce'; g.beginPath(); g.moveTo(255, 193); g.lineTo(243, 218); g.lineTo(255, 212); g.lineTo(267, 218); g.fill(); g.restore();
  instruments = new THREE.CanvasTexture(c); instruments.colorSpace = THREE.SRGBColorSpace; instruments.anisotropy = 4; return instruments;
}

let weave: THREE.Texture | undefined;
export function sedanWeave() {
  if (!weave) {
    weave = new THREE.TextureLoader().load(import.meta.env.BASE_URL + 'sedan-upholstery.webp');
    weave.wrapS = weave.wrapT = THREE.RepeatWrapping;
    weave.colorSpace = THREE.NoColorSpace; weave.anisotropy = 4;
  }
  return weave;
}
