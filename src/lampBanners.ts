// Banners on the main roads' lamp posts, as Prague hangs them for its exhibitions, festivals
// and the city itself: a cloth 0.75 m by 2.2 m on two brackets, standing out from the pole
// towards the road, so that whoever comes along the street sees it face on. A stretch of
// some STRETCH metres of a street carries them on its arm lamps or not (about one in three),
// all in one design; the designs are made up (no real event or organisation). Drawn with
// the poles, near the camera (lamps.ts), one InstancedMesh a design, lit by the street lamps
// like the poles.
import * as THREE from 'three';

export const BANNER = { from: 0.1, width: 0.75, bottom: 3.3, height: 2.2 };
const STRETCH = 120, SHARE = 0.36;
const W = 256, H = 750;
// (Designs: background, ink, accent, and what's written top to bottom.)
const DESIGNS: { bg: string; ink: string; accent: string; draw: (g: CanvasRenderingContext2D) => void }[] = [
  { bg: '#b3202a', ink: '#f6efe2', accent: '#f2c230', draw: (g) => {
    // The city's colours: red with a yellow band, a skyline of spires.
    g.fillStyle = '#f2c230'; g.fillRect(0, H * 0.62, W, H * 0.06);
    g.fillStyle = '#f6efe2';
    const spire = (x: number, w: number, h: number) => { g.beginPath(); g.moveTo(x - w / 2, H * 0.6); g.lineTo(x - w / 2, H * 0.6 - h * 0.6); g.lineTo(x, H * 0.6 - h); g.lineTo(x + w / 2, H * 0.6 - h * 0.6); g.lineTo(x + w / 2, H * 0.6); g.fill(); };
    spire(70, 30, 150); spire(110, 22, 220); spire(150, 22, 210); spire(196, 34, 120);
    text(g, 'PRAHA', H * 0.78, 64, '#f6efe2'); text(g, 'MĚSTO PRO VŠECHNY', H * 0.87, 22, '#f2c230');
  } },
  { bg: '#173f4a', ink: '#eef2ef', accent: '#e8875a', draw: (g) => {
    // An exhibition: rings and a disc, its name and dates.
    g.strokeStyle = '#e8875a'; g.lineWidth = 14;
    for (const r of [44, 78]) { g.beginPath(); g.arc(W / 2, H * 0.3, r, 0, Math.PI * 2); g.stroke(); }
    g.fillStyle = '#eef2ef'; g.beginPath(); g.arc(W / 2 + 30, H * 0.3 - 26, 22, 0, Math.PI * 2); g.fill();
    text(g, 'VÝSTAVA', H * 0.58, 46, '#eef2ef'); text(g, 'SVĚTLO', H * 0.66, 40, '#e8875a'); text(g, 'A STÍN', H * 0.72, 40, '#e8875a');
    text(g, '12/3 — 30/8', H * 0.84, 28, '#eef2ef');
  } },
  { bg: '#6a2d7c', ink: '#fbeef6', accent: '#f4b6d2', draw: (g) => {
    // A music festival: notes, its name, the summer.
    g.fillStyle = '#f4b6d2';
    for (const [x, y, s] of [[80, 150, 1], [160, 230, 0.8], [110, 300, 0.65]]) {
      g.beginPath(); g.ellipse(x, y, 26 * s, 19 * s, -0.4, 0, Math.PI * 2); g.fill();
      g.fillRect(x + 20 * s, y - 120 * s, 7 * s, 120 * s);
    }
    text(g, 'HUDEBNÍ', H * 0.58, 40, '#fbeef6'); text(g, 'LÉTO', H * 0.66, 58, '#fbeef6');
    text(g, 'NA NÁBŘEŽÍ', H * 0.74, 26, '#f4b6d2'); text(g, 'ČERVEN — ZÁŘÍ', H * 0.84, 24, '#fbeef6');
  } },
  { bg: '#d9a43b', ink: '#2a2118', accent: '#7a2e1d', draw: (g) => {
    // A museum's new display: an arch over a vase.
    g.strokeStyle = '#2a2118'; g.lineWidth = 10;
    g.beginPath(); g.moveTo(54, 330); g.lineTo(54, 170); g.arc(W / 2, 170, 74, Math.PI, 0); g.lineTo(202, 330); g.stroke();
    g.fillStyle = '#7a2e1d'; g.beginPath(); g.moveTo(108, 320); g.quadraticCurveTo(84, 250, 112, 210); g.lineTo(144, 210); g.quadraticCurveTo(172, 250, 148, 320); g.fill();
    text(g, 'MUZEUM', H * 0.58, 48, '#2a2118'); text(g, 'NOVÁ', H * 0.67, 34, '#7a2e1d'); text(g, 'EXPOZICE', H * 0.73, 34, '#7a2e1d');
    text(g, 'OTEVŘENO DENNĚ', H * 0.85, 22, '#2a2118');
  } },
];
function text(g: CanvasRenderingContext2D, s: string, y: number, size: number, colour: string) {
  g.save(); g.fillStyle = colour; g.font = `bold ${size}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = g.measureText(s).width, k = w > W * 0.86 ? W * 0.86 / w : 1;
  g.translate(W / 2, y); g.scale(k, 1); g.fillText(s, 0, 0); g.restore();
}

function atlas() {
  const c = document.createElement('canvas'); c.width = W * DESIGNS.length; c.height = H;
  const g = c.getContext('2d')!;
  DESIGNS.forEach((d, k) => {
    g.save(); g.translate(k * W, 0);
    g.fillStyle = d.bg; g.fillRect(0, 0, W, H);
    // The hems top and bottom, where the cloth is sewn round its rods.
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0, W, 16); g.fillRect(0, H - 16, W, 16);
    d.draw(g);
    g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// One design's banner (with its two brackets), in the lamp's frame: x out along its arm,
// y up from the pole's foot. Front and back each read the right way round.
function bannerGeometry(k: number) {
  const { from, width, bottom, height } = BANNER, u0 = k / DESIGNS.length, u1 = (k + 1) / DESIGNS.length;
  const x0 = from, x1 = from + width, y0 = bottom, y1 = bottom + height;
  // (A gentle belly in the cloth, out of the plane at its middle.)
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], col: number[] = [];
  const cols = 4, rows = 6;
  for (const side of [1, -1]) {
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
      const tri = side > 0 ? q : [q[0], q[2], q[1], q[3], q[5], q[4]];
      for (const [a, b] of tri) {
        const s = a / cols, t = b / rows;
        const belly = 0.035 * Math.sin(Math.PI * s) * (0.6 + 0.4 * Math.sin(Math.PI * t));
        pos.push(x0 + (x1 - x0) * s, y0 + (y1 - y0) * t, side * 0.004 + belly);
        uv.push(side > 0 ? u0 + (u1 - u0) * s : u1 - (u1 - u0) * s, t);
        nor.push(0, 0, side); col.push(1, 1, 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // The brackets: a steel rod along the top and the bottom from the pole (plain, from a
  // corner of the atlas that is the hem's dark).
  const rods: THREE.BufferGeometry[] = [];
  for (const y of [y0 + 0.03, y1 - 0.03]) {
    const r = new THREE.CylinderGeometry(0.012, 0.012, x1 - 0.02, 5).rotateZ(Math.PI / 2).translate((x1 - 0.02) / 2, y, 0).toNonIndexed();
    const n = r.attributes.position.count;
    r.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(n * 2).fill(0).map((_, i) => (i % 2 ? 0.995 : u0 + 0.002)), 2));
    r.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(0.35), 3));
    rods.push(r);
  }
  const all = [g, ...rods];
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'color']) {
    const size = name === 'uv' ? 2 : 3, arrays = all.map((x) => x.attributes[name].array as Float32Array);
    const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0; for (const a of arrays) { out.set(a, o); o += a.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  all.forEach((x) => x.dispose());
  return merged;
}

// Whether a lamp at (x, y) carries a banner, and which design (-1 for none).
export function bannerAt(x: number, y: number) {
  const i = Math.floor(x / STRETCH), j = Math.floor(y / STRETCH);
  const h = (n: number) => { const s = Math.sin(i * 127.1 + j * 311.7 + n * 74.7) * 43758.5453; return s - Math.floor(s); };
  return h(1) < SHARE ? Math.floor(h(2) * DESIGNS.length) : -1;
}

// The meshes, one a design; `lampLit` lights them by the street lamps (as the poles).
export function bannerMeshes(maxEach: number, lampLit: (sh: never) => void) {
  const map = atlas();
  const material = new THREE.MeshLambertMaterial({ map, vertexColors: true });
  material.onBeforeCompile = (sh) => lampLit(sh as never);
  material.customProgramCacheKey = () => 'lamp-pole';
  return DESIGNS.map((_, k) => {
    const mesh = new THREE.InstancedMesh(bannerGeometry(k), material, maxEach);
    mesh.name = 'lamp banners'; mesh.count = 0; mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  });
}
