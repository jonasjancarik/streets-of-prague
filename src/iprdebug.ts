import * as THREE from 'three';
import { dataUrl } from './data.ts';

// Developer overlay (open the game with ?ipr): the technical map's surface marks and
// manholes round Újezd (from pipeline/ipr_debug.py) drawn as posts over the game's own
// map, to see what the survey has where. Traffic lights are the big red posts.
const STYLE: Record<number, [string, number]> = {
  605250: ['#ff2020', 1.6], // semafor
  606010: ['#ff00ff', 1], // stožár, sloup
  606560: ['#ffd400', 0.7], // svítidlo na stožáru
  606580: ['#ffd400', 0.5],
  606661: ['#ff8800', 0.6], // rozdělovací skříně
  706661: ['#ff8800', 0.6],
  306661: ['#ff8800', 0.6],
  106300: ['#2f8cff', 0.4], // vpusť
  106200: ['#9a9a9a', 0.4], // šachta
};

export async function iprOverlay(scene: THREE.Scene, area: string, height: (x: number, y: number) => number) {
  const data = await fetch(dataUrl(area, 'ipr_debug.json')).then((r) => r.json()).catch(() => null);
  if (!data) return;
  const count = new Map<number, number>();
  const group = new THREE.Group();
  for (const [x, y, code] of data.marks as [number, number, number][]) {
    if (code % 10 === 1 || code % 100 === 82) continue; // underground
    const [color, size] = STYLE[code] ?? ['#ffffff', 0.3];
    const h = 2.5 * size + 0.5;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.12 * size + 0.05, 0.12 * size + 0.05, h, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    m.position.set(x, height(x, y) + h / 2, -y);
    m.renderOrder = 999;
    group.add(m);
    count.set(code, (count.get(code) ?? 0) + 1);
  }
  scene.add(group);
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;background:#000c;color:#fff;font:11px/1.4 sans-serif;padding:6px 8px;max-width:340px;pointer-events:none';
  box.innerHTML = '<b>IPR technical map</b><br>' + [...count].sort((a, b) => b[1] - a[1]).map(([code, n]) =>
    `<span style="color:${(STYLE[code] ?? ['#fff'])[0]}">●</span> ${n} × ${data.codes[code]}`).join('<br>');
  document.body.appendChild(box);
}
