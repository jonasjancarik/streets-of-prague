// t.look (src/testkit.ts): one picture of a car, a person or a spot from several sides at
// once, so a change can be judged without hunting for camera angles. Each view is a pose
// of the free camera worked out from the subject's place, heading and size: the overhead
// view at the game's normal height (does it read from above?), a high three-quarter view
// and the four corners at eye height (does it look real from the street?). With `rows`,
// each row is the same views again after its own setup: before and after a change tried
// out in the page, say. The pictures come through scripts/scene.mjs (headless Chrome);
// elsewhere there's nothing to take them with, and the camera is left on the first view.
// A view whose camera would stand in or behind a building comes in to just short of its
// wall (the label says so). (Kept out of testkit.ts so that changing it reloads no game
// until one has used t.look.)

import type { FreeCam, Where } from './testkit.ts';

type Point2 = [number, number];
interface Box { L: number; W: number; H: number }
// A car (or anything with a `spec` of L, W and H metres), a person, `{ x, y }` in the
// game's metres, a place's name or [lat, lon]; 'me' or nothing: you, or your car.
export type LookSubject = Where | 'me' | { x: number; y: number; h?: number; gz?: number; spec?: Partial<Box> };
export interface LookView {
  label?: string;
  // From where: degrees round the subject from its front (90 its left side, 180 behind
  // it, -90 its right). A spot faces `heading` (north unless told).
  from?: number;
  // Metres from the subject's middle along the ground (left out: as near as fits it).
  dist?: number;
  // The eye's height above the ground: 1.6 (standing) unless `elev` is given.
  eye?: number;
  // Degrees above the level of the subject's middle to look down from instead.
  elev?: number;
  // Straight down from this height (metres): the overhead camera, as the game draws it.
  top?: number;
  // Drawn as from the street (life-size people, a 55° lens, the sky, the haze): all but `top`.
  street?: boolean;
  fov?: number;
  // How much of the picture's width (or height) the subject fills (0.8).
  fill?: number;
}
export interface LookOptions {
  views?: (string | LookView)[];
  // Each row: its label and what to do before its pictures (the same views in each).
  rows?: Record<string, () => unknown>;
  name?: string;
  // Each picture's width in the sheet (pixels; 640), and the columns (3; a row's views with `rows`).
  width?: number;
  columns?: number;
  // Frames drawn before each picture (5), for shadows and levels of detail to catch up.
  settle?: number;
  // For a spot: how big (6 × 6 × 3 m) and which way it faces (compass degrees).
  size?: Partial<Box>;
  heading?: number;
  // Leave the camera on the last view (otherwise it goes back to what it was).
  keep?: boolean;
}

export const LOOK_VIEWS: Record<string, LookView> = {
  top: { top: 100, label: 'from above' },
  above: { from: 30, elev: 35, label: 'high' },
  front: { from: 0 }, 'front-left': { from: 45 }, left: { from: 90 }, 'rear-left': { from: 135 },
  rear: { from: 180 }, 'rear-right': { from: -135 }, right: { from: -90 }, 'front-right': { from: -45 },
};
const DEFAULT_VIEWS = ['top', 'above', 'front-left', 'front-right', 'rear-left', 'rear-right'];
const PERSON: Box = { L: 0.5, W: 0.6, H: 1.8 };
const SPOT: Box = { L: 6, W: 6, H: 3 };

interface LookKit {
  cam: FreeCam | null;
  paused: boolean;
  toLocal(w: Where): Point2;
}
interface LookGame {
  me(): { x: number; y: number; h: number };
  car(): { x: number; y: number; h: number; gz?: number; spec: Box } | null;
  ground(x: number, y: number): number;
  toLonLat(x: number, y: number): Point2;
  loaded(x: number, y: number): Promise<void>;
  canvas: HTMLElement;
  // The ground's collision grid: 255 in a building or wall (as shots meet them).
  grid: { at(x: number, y: number): number };
}

const rad = (deg: number) => ((90 - deg) * Math.PI) / 180;
const compass = (a: number) => ((((90 - (a * 180) / Math.PI) % 360) + 360) % 360);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const round = (x: number, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

interface Subject { x: number; y: number; h: number; base: number; box: Box }

function subjectOf(kit: LookKit, g: LookGame, s: LookSubject | undefined, opt: LookOptions): Subject {
  const ground = (x: number, y: number) => { const z = g.ground(x, y); return Number.isFinite(z) ? z : 0; };
  if (s === undefined || s === 'me') {
    const c = g.car();
    if (c) s = c;
    else { const m = g.me(); return { x: m.x, y: m.y, h: m.h, base: ground(m.x, m.y), box: PERSON }; }
  }
  if (typeof s === 'object' && !Array.isArray(s) && 'x' in s) {
    const o = s as { x: number; y: number; h?: number; gz?: number; spec?: Partial<Box> };
    const box = o.spec?.L ? { ...PERSON, ...o.spec } : { ...PERSON, ...opt.size };
    return { x: o.x, y: o.y, h: o.h ?? rad(opt.heading ?? 0), base: Number.isFinite(o.gz) ? o.gz! : ground(o.x, o.y), box };
  }
  const [x, y] = kit.toLocal(s as Where);
  return { x, y, h: rad(opt.heading ?? 0), base: ground(x, y), box: { ...SPOT, ...opt.size } };
}

// The free camera that sees the subject from `v` (main.ts draws it: tilted back from the
// point it looks at, `height` above it, facing `heading`).
function poseOf(s: Subject, v: LookView, aspect: number, ground: (x: number, y: number) => number, walled: (x: number, y: number) => boolean): FreeCam & { nearer?: boolean } {
  const { L, W, H } = s.box;
  const middle = s.base + H / 2;
  if (v.top) return { x: s.x, y: s.y, targetY: s.base, height: v.top, tilt: 0, heading: 0, street: v.street ?? false, ...(v.fov ? { fov: v.fov } : {}) };
  const fov = v.fov ?? 55, fill = v.fill ?? 0.8;
  const phi = ((v.from ?? 45) * Math.PI) / 180, side = Math.abs(Math.sin(phi)), end = Math.abs(Math.cos(phi));
  // The subject's breadth across the picture and its depth along the line of sight.
  const across = L * side + W * end, deep = L * end + W * side;
  const tanV = Math.tan((fov * Math.PI) / 360), tanH = tanV * aspect;
  const elev = v.elev !== undefined ? (v.elev * Math.PI) / 180 : 0;
  let dist = v.dist ?? Math.max(2.2, deep / 3 + Math.max(across / 2 / (tanH * fill), H / 2 / (tanV * fill)) * Math.cos(elev));
  const bearing = s.h + phi;
  // Not from inside a building: in to just short of the first wall out from the subject.
  let nearer = false;
  for (let r = Math.min(1.5, dist); r <= dist; r += 0.25) {
    if (!walled(s.x + Math.cos(bearing) * r, s.y + Math.sin(bearing) * r)) continue;
    dist = Math.max(1, r - 0.6);
    nearer = true;
    break;
  }
  const ex = s.x + Math.cos(bearing) * dist, ey = s.y + Math.sin(bearing) * dist;
  // (Standing on the ground there, or on the subject's own level: a bridge's deck.)
  const ez = v.elev !== undefined ? middle + dist * Math.tan(elev) : Math.max(s.base, ground(ex, ey)) + (v.eye ?? 1.6);
  // The free camera looks down at its point; at eye height, just below the eye.
  const at = Math.min(middle, ez - 0.05);
  return {
    x: s.x, y: s.y, targetY: at, height: ez - at, tilt: (Math.atan2(dist, ez - at) * 180) / Math.PI,
    heading: compass(bearing + Math.PI), level: true, street: v.street ?? true, fov, ...(nearer ? { nearer } : {}),
  };
}

const viewOf = (v: string | LookView): LookView & { label: string } => {
  if (typeof v !== 'string') return { ...v, label: v.label ?? (v.top ? `top ${v.top} m` : `${v.from ?? 45}°`) };
  const named = LOOK_VIEWS[v];
  if (!named) throw new Error(`No view called ${v}; there are ${Object.keys(LOOK_VIEWS).join(', ')} (or give { from, dist, eye, elev, top })`);
  return { ...named, label: named.label ?? v };
};

const bitmap = async (base64: string) => {
  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
};
const base64Of = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function lookSheet(kit: LookKit, g: LookGame, subject?: LookSubject, opt: LookOptions = {}) {
  const s = subjectOf(kit, g, subject, opt);
  const views = (opt.views ?? DEFAULT_VIEWS).map(viewOf);
  const canvas = g.canvas as HTMLCanvasElement;
  const aspect = (canvas.clientWidth || innerWidth) / (canvas.clientHeight || innerHeight);
  const ground = (x: number, y: number) => { const z = g.ground(x, y); return Number.isFinite(z) ? z : -Infinity; };
  const walled = (x: number, y: number) => g.grid.at(x, y) === 255;
  const poses = views.map((v) => {
    const { nearer, ...cam } = poseOf(s, v, aspect, ground, walled);
    return { label: nearer ? `${v.label} (nearer: a wall)` : v.label, cam };
  });
  const [lon, lat] = g.toLonLat(s.x, s.y);
  const about = {
    subject: { x: round(s.x), y: round(s.y), heading: Math.round(compass(s.h)), ground: round(s.base), lat: round(lat, 6), lon: round(lon, 6) },
    // (Each pose again: `t.cam = views[i].cam` looks from it.)
    views: poses.map((p) => ({ label: p.label, cam: Object.fromEntries(Object.entries(p.cam).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])) })),
  };
  const grab = (window as { __grab?: () => Promise<string> }).__grab;
  const save = (window as { __saveShot?: (name: string, base64: string) => Promise<string> }).__saveShot;
  if (!grab || !save) {
    kit.cam = poses[0].cam;
    return { ...about, sheet: null, note: 't.look takes its pictures through scripts/scene.mjs; the camera is on the first view' };
  }

  const was = kit.cam, paused = kit.paused, settle = opt.settle ?? 5;
  // Only the game's picture: everything else on the page out of sight meanwhile.
  const hide = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el !== canvas && !el.contains(canvas));
  const shown = hide.map((el) => el.style.visibility);
  const rows = opt.rows ? Object.entries(opt.rows) : [['', null] as const];
  const cells: { label: string; bmp: ImageBitmap }[] = [];
  kit.cam = poses[0].cam;
  await g.loaded(s.x, s.y);
  kit.paused = true;
  for (const el of hide) el.style.visibility = 'hidden';
  try {
    for (const [row, setup] of rows) {
      if (setup) await setup();
      for (const p of poses) {
        kit.cam = { ...p.cam };
        for (let i = 0; i < settle; i++) await frame();
        cells.push({ label: row ? `${row} · ${p.label}` : p.label, bmp: await bitmap(await grab()) });
      }
    }
  } finally {
    kit.paused = paused;
    hide.forEach((el, i) => { el.style.visibility = shown[i]; });
    if (!opt.keep) kit.cam = was;
  }

  // The sheet: the pictures in a grid, each with its label.
  const cw = opt.width ?? 640, scale = cw / cells[0].bmp.width, ch = Math.round(cells[0].bmp.height * scale), gap = 4;
  const cols = opt.rows ? poses.length : Math.min(opt.columns ?? 3, cells.length);
  const lines = Math.ceil(cells.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * cw + (cols - 1) * gap;
  sheet.height = lines * ch + (lines - 1) * gap;
  const ctx = sheet.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  cells.forEach((c, i) => {
    const x = (i % cols) * (cw + gap), y = Math.floor(i / cols) * (ch + gap);
    ctx.drawImage(c.bmp, x, y, cw, ch);
    const w = ctx.measureText(c.label).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    ctx.fillRect(x, y, w + 14, 24);
    ctx.fillStyle = '#fff';
    ctx.fillText(c.label, x + 7, y + 5);
    c.bmp.close();
  });
  const blob = await new Promise<Blob>((resolve, reject) => sheet.toBlob((b) => (b ? resolve(b) : reject(new Error('The sheet could not be made'))), 'image/jpeg', 0.9));
  const path = await save(`${opt.name ?? 'look'}.jpg`, await base64Of(blob));
  return { sheet: path, ...about };
}
