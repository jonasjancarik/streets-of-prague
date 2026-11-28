// The traffic signs (pipeline/build_traffic_signs.py: data/<area>_now/traffic-signs.json),
// their faces drawn to a canvas atlas in the Czech designs, and each tile's posts as one
// mesh (map/signs.ts builds it in the land worker). The crossings' lit boxes glow after
// dark (lightSigns). Optional: without the file a map has no signs.
import * as THREE from 'three';
import { cutAway } from './shading.ts';
import { cellRect, signStyle, CELL, BOTTOM } from './map/signs.ts';
import type { SignArrays, TrafficSigns } from './map/signs.ts';
import { directionLayout, faceOutline, PX, PANEL_LINE, WHITE_CORNER } from './map/directions.ts';
import type { DirectionArrays, DirectionSign, Face, PlateColour, Rect } from './map/directions.ts';
export { loadTrafficSigns } from './map/signs.ts';
export type { TrafficSigns } from './map/signs.ts';

// The Czech signs' colours (the paints as they look on the street, a little off the pure
// RGB of the drawings), and the zone colours of Prague's paid parking.
const RED = '#c8102e', BLUE = '#1450a0', YELLOW = '#f6c100', WHITE = '#f7f7f3', BLACK = '#171717', GREY = '#8b8e90', FADED = '#a9abab';
const ZONE_BAND: Record<string, string> = { RES: '#1450a0', MIX: '#6a2c8e', VIS: '#ee7203' };
// Czech signs are lettered in a narrow, DIN-like grotesque; this is the nearest common one.
const FONT = '"DIN Condensed", "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
type Ctx = CanvasRenderingContext2D;

// The Czech number style on signs: a decimal comma.
const czech = (v: string) => v.replace('.', ',');

function walker(c: Ctx, x: number, y: number, h: number, colour: string, child = false, hat = false) {
  // A walking figure `h` tall standing on (x, y), going right.
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = h * (child ? .12 : .11); c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); c.arc(x + h * .04, y - h * .89, h * .095, 0, Math.PI * 2); c.fill();
  // The IP 6 walker's hat.
  if (hat) { c.fillRect(x - h * .1, y - h * .97, h * .28, h * .035); c.fillRect(x - h * .04, y - h * 1.07, h * .16, h * .1); }
  // A body that widens to the shoulders, then the legs and arms in stride.
  c.beginPath(); c.moveTo(x + h * .03, y - h * .76); c.lineTo(x - h * .02, y - h * .44); c.stroke();
  c.beginPath(); c.moveTo(x - h * .02, y - h * .44); c.lineTo(x + h * .15, y - h * .22); c.lineTo(x + h * .16, y);
  c.moveTo(x - h * .02, y - h * .44); c.lineTo(x - h * .12, y - h * .2); c.lineTo(x - h * .26, y - h * .04);
  c.moveTo(x + h * .03, y - h * .72); c.lineTo(x + h * .19, y - h * .52); c.lineTo(x + h * .27, y - h * .4);
  c.moveTo(x + h * .03, y - h * .72); c.lineTo(x - h * .12, y - h * .54); c.lineTo(x - h * .19, y - h * .4);
  c.stroke(); c.restore();
}
function car(c: Ctx, x: number, y: number, w: number, colour: string) {
  // A car seen from the side, `w` long, its wheels on (x, y) about its middle, facing left.
  c.save(); c.fillStyle = colour;
  c.beginPath(); c.roundRect(x - w / 2, y - w * .34, w, w * .2, w * .06); c.fill();
  c.beginPath(); c.moveTo(x - w * .28, y - w * .32); c.lineTo(x - w * .14, y - w * .52); c.lineTo(x + w * .2, y - w * .52); c.lineTo(x + w * .34, y - w * .32); c.fill();
  for (const s of [-.29, .29]) { c.beginPath(); c.arc(x + s * w, y - w * .13, w * .12, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function carFront(c: Ctx, x: number, y: number, w: number, colour: string) {
  // A car seen from the front, `w` wide, standing on (x, y): B 11's.
  c.save(); c.fillStyle = colour;
  c.beginPath(); c.moveTo(x - w * .36, y - w * .3); c.lineTo(x - w * .28, y - w * .56); c.lineTo(x + w * .28, y - w * .56); c.lineTo(x + w * .36, y - w * .3); c.fill();
  c.beginPath(); c.roundRect(x - w / 2, y - w * .34, w, w * .24, w * .06); c.fill();
  for (const s of [-1, 1]) c.fillRect(x + s * w * .36 - w * .08, y - w * .12, w * .16, w * .12);
  c.fillStyle = WHITE; c.beginPath(); c.moveTo(x - w * .27, y - w * .34); c.lineTo(x - w * .22, y - w * .5); c.lineTo(x + w * .22, y - w * .5); c.lineTo(x + w * .27, y - w * .34); c.fill();
  for (const s of [-1, 1]) { c.beginPath(); c.arc(x + s * w * .33, y - w * .23, w * .05, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function lorry(c: Ctx, x: number, y: number, w: number, colour: string) {
  c.save(); c.fillStyle = colour;
  c.fillRect(x - w / 2, y - w * .6, w * .64, w * .42);
  c.beginPath(); c.moveTo(x + w * .18, y - w * .18); c.lineTo(x + w * .18, y - w * .46); c.lineTo(x + w * .38, y - w * .46); c.lineTo(x + w * .5, y - w * .3); c.lineTo(x + w * .5, y - w * .18); c.fill();
  c.fillStyle = WHITE; c.beginPath(); c.moveTo(x + w * .3, y - w * .42); c.lineTo(x + w * .37, y - w * .42); c.lineTo(x + w * .45, y - w * .31); c.lineTo(x + w * .3, y - w * .31); c.fill();
  c.fillStyle = colour;
  for (const s of [-.33, -.12, .36]) { c.beginPath(); c.arc(x + s * w, y - w * .12, w * .1, 0, Math.PI * 2); c.fill(); }
  c.restore();
}
function motorbike(c: Ctx, x: number, y: number, w: number, colour: string) {
  // A motorcycle and its rider, side on, `w` long, standing on (x, y).
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = w * .07; c.lineCap = 'round'; c.lineJoin = 'round';
  for (const s of [-.33, .33]) { c.beginPath(); c.arc(x + s * w, y - w * .16, w * .15, 0, Math.PI * 2); c.stroke(); }
  c.beginPath(); c.moveTo(x - w * .33, y - w * .16); c.lineTo(x - w * .12, y - w * .34); c.lineTo(x + w * .16, y - w * .34); c.lineTo(x + w * .33, y - w * .16);
  c.moveTo(x + w * .16, y - w * .34); c.lineTo(x + w * .24, y - w * .52); c.stroke();
  c.beginPath(); c.ellipse(x, y - w * .38, w * .2, w * .07, 0, 0, Math.PI * 2); c.fill();
  // The rider leaning forward.
  c.lineWidth = w * .12;
  c.beginPath(); c.moveTo(x - w * .06, y - w * .44); c.lineTo(x + w * .06, y - w * .72); c.lineTo(x + w * .22, y - w * .54); c.stroke();
  c.beginPath(); c.arc(x + w * .1, y - w * .86, w * .1, 0, Math.PI * 2); c.fill();
  c.restore();
}
// An arrow from (x, y) up `len`, then bent by `turn` (-1 left, 1 right, 0 straight on).
function arrow(c: Ctx, x: number, y: number, len: number, wid: number, turn: number, colour: string) {
  c.save(); c.strokeStyle = c.fillStyle = colour; c.lineWidth = wid; c.lineJoin = 'miter';
  const bend = turn ? len * .55 : len - wid * 1.6;
  c.beginPath(); c.moveTo(x, y); c.lineTo(x, y - bend);
  let tx = x, ty = y - bend, dx = 0, dy = -1;
  if (turn) { tx = x + turn * len * .45; ty = y - bend; c.lineTo(tx - turn * wid * 1.4, ty); dx = turn; dy = 0; }
  c.stroke();
  const hx = tx + dx * wid * .2, hy = ty + dy * wid * .2, s = wid * 1.6;
  c.beginPath(); c.moveTo(hx + dx * s, hy + dy * s); c.lineTo(hx - dy * s - dx * s * .6, hy + dx * s - dy * s * .6); c.lineTo(hx + dy * s - dx * s * .6, hy - dx * s - dy * s * .6); c.fill();
  c.restore();
}
function slash(c: Ctx, r: number, colour: string, width: number) {
  c.save(); c.strokeStyle = colour; c.lineWidth = width; c.lineCap = 'butt';
  c.beginPath(); c.moveTo(-r * .68, -r * .68); c.lineTo(r * .68, r * .68); c.stroke(); c.restore();
}
function text(c: Ctx, s: string, x: number, y: number, size: number, colour = BLACK, weight = 'bold') {
  c.save(); c.fillStyle = colour; c.font = `${weight} ${size}px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(s, x, y); c.restore();
}
// A closed outline with its corners rounded by `r`.
function rounded(c: Ctx, pts: [number, number][], r: number) {
  c.beginPath();
  const n = pts.length, mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1], pts[0]);
  c.moveTo(start[0], start[1]);
  for (let k = 0; k < n; k++) { const p = pts[k], q = pts[(k + 1) % n]; c.arcTo(p[0], p[1], q[0], q[1], r); }
  c.closePath();
}
// A rectangular sign's field with its rounded corners, and the white (or black) line just
// inside its edge that Czech blue and white signs have.
function field(c: Ctx, w: number, h: number, fill: string, line: string | null, edge = .022, width = .012) {
  c.fillStyle = fill; c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, Math.min(w, h) * .06); c.fill();
  if (!line) return;
  c.strokeStyle = line; c.lineWidth = width;
  c.beginPath(); c.roundRect(-w / 2 + edge, -h / 2 + edge, w - edge * 2, h - edge * 2, Math.min(w, h) * .04); c.stroke();
}
// A round prohibition sign of radius `r` at (x, y): white, the red ring 80 mm of a 700 mm
// sign, a thin white rim outside it.
function ring(c: Ctx, x: number, y: number, r: number, colour = RED) {
  c.save(); c.fillStyle = WHITE; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.strokeStyle = colour; c.lineWidth = r * .23; c.beginPath(); c.arc(x, y, r * .855, 0, Math.PI * 2); c.stroke(); c.restore();
}
// The parking meter in the corner of a paid-parking sign: a white square, the meter's
// dial in the field's blue.
function meter(c: Ctx, x: number, y: number, a: number) {
  c.save(); c.fillStyle = WHITE; c.beginPath(); c.roundRect(x - a / 2, y - a / 2, a, a, a * .08); c.fill();
  c.fillStyle = BLUE;
  c.beginPath(); c.moveTo(x - a * .36, y - a * .3); c.lineTo(x + a * .36, y - a * .3); c.lineTo(x + a * .3, y + a * .05);
  c.quadraticCurveTo(x, y + a * .42, x - a * .3, y + a * .05); c.closePath(); c.fill();
  c.strokeStyle = WHITE; c.lineWidth = a * .045;
  for (let k = -2; k <= 2; k++) { const t = k * .28; c.beginPath(); c.moveTo(x + Math.sin(t) * a * .12, y - a * .02 - Math.cos(t) * a * .12); c.lineTo(x + Math.sin(t) * a * .24, y - a * .02 - Math.cos(t) * a * .24); c.stroke(); }
  c.restore();
}

// One sign's face in its cell, `s` px a metre, about the middle (canvas y down).
function drawFace(c: Ctx, name: string, w: number, h: number, s: number) {
  const R = w / 2 * s, W = w * s, H = h * s;
  const disc = (fill: string) => {
    c.fillStyle = WHITE; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
    c.fillStyle = fill; c.beginPath(); c.arc(0, 0, R * .965, 0, Math.PI * 2); c.fill();
  };
  const prohibition = () => ring(c, 0, 0, R);
  const square = (fill: string) => field(c, W, H, fill, WHITE, s * .022, s * .012);
  const big = (v: string) => R * (v.length > 2 ? .82 : 1.08);
  let m: RegExpMatchArray | null;
  if (name === 'no entry') { disc(RED); c.fillStyle = WHITE; c.fillRect(-R * .74, -R * .16, R * 1.48, R * .32); return; }
  if ((m = name.match(/^speed (\d+)$/))) { prohibition(); text(c, m[1], 0, R * .06, big(m[1])); return; }
  if ((m = name.match(/^speed (\d+) end$/))) {
    // B 20b: no red ring; the number grey under five black bars.
    disc(WHITE); c.strokeStyle = BLACK; c.lineWidth = R * .025; c.beginPath(); c.arc(0, 0, R * .955, 0, Math.PI * 2); c.stroke();
    text(c, m[1], 0, R * .06, big(m[1]), FADED);
    c.save(); c.beginPath(); c.arc(0, 0, R * .94, 0, Math.PI * 2); c.clip(); c.strokeStyle = BLACK; c.lineWidth = R * .05;
    for (const k of [-.26, -.13, 0, .13, .26]) { c.beginPath(); c.moveTo(R * (1 + k), -R * (1 - k)); c.lineTo(-R * (1 - k), R * (1 + k)); c.stroke(); }
    c.restore(); return;
  }
  if ((m = name.match(/^weight ([\d.]+)$/))) { prohibition(); text(c, czech(m[1]) + ' t', 0, R * .06, R * (m[1].length > 2 ? .66 : .86)); return; }
  if ((m = name.match(/^height ([\d.]+)$/))) {
    // B 16: the height over a small "m", black wedges pointing in at the top and bottom.
    prohibition(); text(c, czech(m[1]), 0, -R * .1, R * (m[1].length > 2 ? .62 : .78)); text(c, 'm', 0, R * .3, R * .3);
    c.fillStyle = BLACK;
    for (const d of [-1, 1]) { c.beginPath(); c.moveTo(-R * .2, d * R * .76); c.lineTo(R * .2, d * R * .76); c.lineTo(0, d * R * .52); c.fill(); }
    return;
  }
  if (name === 'no lorries') { prohibition(); lorry(c, 0, R * .34, R * 1.2, BLACK); return; }
  if (name === 'no motor vehicles') {
    // B 11: a car over a motorcycle, a red bar between them.
    prohibition(); c.fillStyle = RED; c.fillRect(-R * .76, -R * .07, R * 1.52, R * .14);
    carFront(c, 0, -R * .16, R * .72, BLACK); motorbike(c, 0, R * .64, R * .62, BLACK); return;
  }
  if (name === 'no left turn' || name === 'no right turn') {
    const t = name === 'no left turn' ? -1 : 1;
    prohibition(); arrow(c, -t * R * .2, R * .55, R * 1.1, R * .17, t, BLACK);
    slash(c, R, RED, R * .2); return;
  }
  if (name === 'ahead only') { disc(BLUE); arrow(c, 0, R * .66, R * 1.3, R * .22, 0, WHITE); return; }
  if (name === 'left only' || name === 'right only') { const t = name === 'left only' ? -1 : 1; disc(BLUE); arrow(c, -t * R * .22, R * .62, R * 1.2, R * .22, t, WHITE); return; }
  if (name === 'roundabout') {
    // C 1: three arrows chasing each other anticlockwise.
    disc(BLUE); c.save(); c.strokeStyle = c.fillStyle = WHITE; c.lineWidth = R * .15;
    for (let k = 0; k < 3; k++) {
      const a0 = k * Math.PI * 2 / 3 + .35, a1 = a0 + 1.3, r = R * .54;
      c.beginPath(); c.arc(0, 0, r, -a0, -a1, true); c.stroke();
      const hx = Math.cos(-a1) * r, hy = Math.sin(-a1) * r, tx = Math.sin(-a1), ty = -Math.cos(-a1);
      c.beginPath(); c.moveTo(hx - tx * R * .24, hy - ty * R * .24); c.lineTo(hx + Math.cos(-a1) * R * .19, hy + Math.sin(-a1) * R * .19); c.lineTo(hx - Math.cos(-a1) * R * .19, hy - Math.sin(-a1) * R * .19); c.fill();
    }
    c.restore(); return;
  }
  if (name === 'give way') {
    // P 4: point down, the red border 100 mm of 900, a thin white rim, round corners.
    const a = W / 2, b = H / 2, side = Math.hypot(a, b * 2), i = side * .11, rim = side * .012;
    const tri = (inset: number): [number, number][] => [[-a + inset * 1.73, -b + inset], [a - inset * 1.73, -b + inset], [0, b - inset * 2]];
    c.fillStyle = WHITE; rounded(c, tri(0), s * .06); c.fill();
    c.fillStyle = RED; rounded(c, tri(rim), s * .055); c.fill();
    c.fillStyle = WHITE; rounded(c, tri(i), s * .025); c.fill();
    return;
  }
  if (name === 'stop') {
    const r = R / Math.cos(Math.PI / 8);
    const oct = (rr: number) => { c.beginPath(); for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + k * Math.PI / 4; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); };
    c.fillStyle = WHITE; oct(r); c.fill(); c.fillStyle = RED; oct(r * .95); c.fill();
    c.strokeStyle = WHITE; c.lineWidth = R * .03; oct(r * .9); c.stroke();
    text(c, 'STOP', 0, R * .06, R * .66, WHITE); return;
  }
  if (name === 'main road') {
    const a = W / 2;
    const dia = (rr: number) => { c.beginPath(); c.moveTo(0, -rr); c.lineTo(rr, 0); c.lineTo(0, rr); c.lineTo(-rr, 0); c.closePath(); };
    c.fillStyle = BLACK; dia(a); c.fill(); c.fillStyle = WHITE; dia(a * .965); c.fill(); c.fillStyle = YELLOW; dia(a * .64); c.fill(); return;
  }
  if (name === 'one way') { square(BLUE); arrow(c, 0, H * .38, H * .78, W * .2, 0, WHITE); return; }
  if (name === 'crossing' || name === 'crossing lit') {
    // IP 6: a white triangle on the blue, in it the man in a hat crossing the stripes.
    square(BLUE); const a = W / 2 * .86, top = -H / 2 * .8, bot = H / 2 * .76;
    c.fillStyle = WHITE; rounded(c, [[0, top], [a, bot], [-a, bot]], s * .02); c.fill();
    c.fillStyle = BLACK;
    for (let k = 0; k < 5; k++) { const x = -a * .62 + k * a * .31; c.beginPath(); c.moveTo(x - a * .08, bot - s * .015); c.lineTo(x + a * .12, bot - s * .015); c.lineTo(x + a * .09, bot - s * .065); c.lineTo(x - a * .05, bot - s * .065); c.fill(); }
    walker(c, -s * .01, bot - s * .075, s * .3, BLACK, false, true); return;
  }
  if (name === 'speed bump') {
    square(BLUE); c.fillStyle = WHITE; const a = W / 2 * .7;
    c.beginPath(); c.moveTo(-a, s * .1); c.bezierCurveTo(-a * .5, s * .1, -a * .35, -s * .14, 0, -s * .14); c.bezierCurveTo(a * .35, -s * .14, a * .5, s * .1, a, s * .1); c.closePath(); c.fill();
    c.fillRect(-a * 1.1, s * .12, a * 2.2, s * .035); return;
  }
  if ((m = name.match(/^zone (\d+)( end)?$/))) {
    // IZ 8a: a white plate, "ZÓNA" over the sign that holds in it; its end greyed and struck through.
    const end = !!m[2], ink = end ? FADED : BLACK;
    field(c, W, H, WHITE, ink, s * .025, s * .016);
    text(c, 'ZÓNA', 0, -H * .29, s * .15, ink);
    ring(c, 0, H * .12, W * .34, end ? FADED : RED);
    text(c, m[1], 0, H * .12 + W * .02, W * .34 * (m[1].length > 2 ? .82 : 1.05), ink);
    if (end) { c.save(); c.strokeStyle = BLACK; c.lineWidth = s * .04; c.beginPath(); c.moveTo(-W * .44, H * .44); c.lineTo(W * .44, -H * .44); c.stroke(); c.restore(); }
    return;
  }
  if ((m = name.match(/^living street( end)?$/))) {
    // IZ 5a (IP 26a): wide and blue: a house, a car, someone walking, a child at play.
    square(BLUE);
    c.fillStyle = WHITE; const gx = W * .3, gy = -H * .04;
    c.beginPath(); c.moveTo(gx - s * .08, gy); c.lineTo(gx - s * .08, gy - s * .1); c.lineTo(gx, gy - s * .17); c.lineTo(gx + s * .08, gy - s * .1); c.lineTo(gx + s * .08, gy); c.closePath(); c.fill();
    c.fillStyle = BLUE; c.fillRect(gx - s * .02, gy - s * .07, s * .035, s * .07); c.fillStyle = WHITE;
    car(c, W * .02, -H * .04, s * .26, WHITE);
    c.fillRect(-W * .4, H * .07, W * .8, s * .012);
    walker(c, -W * .3, H * .32, s * .2, WHITE);
    walker(c, W * .1, H * .32, s * .12, WHITE, true);
    c.beginPath(); c.arc(-W * .04, H * .3, s * .022, 0, Math.PI * 2); c.fill();
    if (m[1]) { c.save(); c.strokeStyle = RED; c.lineWidth = s * .05; c.beginPath(); c.moveTo(-W * .44, H * .42); c.lineTo(W * .44, -H * .42); c.stroke(); c.restore(); }
    return;
  }
  if ((m = name.match(/^pedestrian zone( end)?$/))) {
    // IZ 6a (IP 27a): a white plate, "PĚŠÍ ZÓNA" over the blue footway sign.
    const end = !!m[1], ink = end ? FADED : BLACK;
    field(c, W, H, WHITE, ink, s * .025, s * .016);
    fitText(c, 'PĚŠÍ ZÓNA', 0, -H * .35, s * .1, W * .84, ink, 'center');
    const r = W * .36, cy = H * .08;
    c.fillStyle = end ? FADED : BLUE; c.beginPath(); c.arc(0, cy, r, 0, Math.PI * 2); c.fill();
    walker(c, -r * .22, cy + r * .66, r * 1.2, WHITE); walker(c, r * .32, cy + r * .66, r * .78, WHITE, true);
    if (end) { c.save(); c.strokeStyle = BLACK; c.lineWidth = s * .04; c.beginPath(); c.moveTo(-W * .44, H * .44); c.lineTo(W * .44, -H * .44); c.stroke(); c.restore(); }
    return;
  }
  if ((m = name.match(/^parking (RES|MIX|VIS)$/))) {
    // IP 12 as Prague's paid zones put it up: the P and a car; "RÉSERVÉ" where only
    // residents may park, the parking meter where anyone may pay.
    square(BLUE);
    const res = m[1] === 'RES';
    c.save(); c.fillStyle = WHITE; c.font = `bold ${H * .78}px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillText('P', -W * .36, res ? H * .2 : H * .16); c.restore();
    car(c, W * .24, res ? H * .19 : H * .1, W * .4, WHITE);
    if (res) fitText(c, 'RÉSERVÉ', 0, H * .36, s * .1, W * .8, WHITE, 'center');
    else meter(c, W * .25, H * .3, W * .3);
    return;
  }
  if ((m = name.match(/^parking plate (RES|MIX|VIS)(?: (\S+))?$/))) {
    // E 13 under it: the hours, who may park, and the zone's colour (with its area).
    field(c, W, H, WHITE, BLACK, s * .02, s * .016);
    const lines = m[1] === 'VIS' ? ['PO–PÁ', '08–20 h', 'MAX. 2 h']
      : ['PO–PÁ', '08–20 h', m[1] === 'MIX' ? 'NEBO S PLATNÝM' : 'S PLATNÝM', 'PARKOVACÍM', 'OPRÁVNĚNÍM'];
    const band = s * .085, top = -H / 2 + s * .035, room = H - band - s * .07, gap = room / lines.length;
    const size = Math.min(gap * .86, s * (m[1] === 'VIS' ? .085 : .066));
    lines.forEach((l, k) => fitText(c, l, 0, top + gap * (k + .5), size, W * .82, BLACK, 'center'));
    c.fillStyle = ZONE_BAND[m[1]]; c.fillRect(-W / 2 + s * .04, H / 2 - s * .04 - band, W - s * .08, band);
    if (m[2]) fitText(c, `OBLAST ${m[2]}`, 0, H / 2 - s * .04 - band / 2, band * .8, W * .7, WHITE, 'center');
    return;
  }
  if (name === 'except access') {
    field(c, W, H, WHITE, BLACK, s * .015, s * .012);
    fitText(c, 'MIMO DOPRAVNÍ', 0, -H * .2, s * .07, W * .86, BLACK, 'center'); fitText(c, 'OBSLUHY', 0, H * .22, s * .07, W * .86, BLACK, 'center'); return;
  }
  field(c, W, H, GREY, null);
}

function drawAtlas(names: string[], cols: number, lit: boolean) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cols * CELL;
  const c = canvas.getContext('2d')!;
  c.fillStyle = lit ? '#000' : WHITE; c.fillRect(0, 0, canvas.width, canvas.height);
  if (!lit) { c.fillStyle = '#fff'; c.fillRect(0, 0, CELL, CELL); }
  names.forEach((name, k) => {
    const style = signStyle(name);
    if (!style || (lit && !name.endsWith(' lit'))) return;
    const r = cellRect(k + 1, cols, style);
    c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
    drawFace(c, name, style.w, style.h, r.scale);
    c.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

let material: THREE.MeshStandardMaterial | undefined, drawnFor: string[] | undefined, drawnCount = 0;
const meshes = new Set<THREE.Mesh>();
// The material of the signs: the atlas is drawn for the area's sign names, and again when
// the game has added some (signIndex: in cells kept free, so no mapping changes).
function signMaterial(signs: TrafficSigns) {
  const { names, cols } = signs;
  if (material && drawnFor === names && drawnCount === names.length) return material;
  const map = drawAtlas(names, cols, false), emissiveMap = drawAtlas(names, cols, true);
  if (material && drawnFor === names) {
    material.map!.dispose(); material.emissiveMap!.dispose();
    material.map = map; material.emissiveMap = emissiveMap; material.needsUpdate = true;
  } else {
    material?.map?.dispose(); material?.emissiveMap?.dispose();
    material = cutAway(new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: '#ffffff',
      emissiveIntensity: 0, vertexColors: true, roughness: .5, metalness: .15 }), 'furniture');
  }
  drawnFor = names; drawnCount = names.length;
  return material;
}

export function signMesh(arrays: SignArrays, signs: TrafficSigns) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arrays.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(arrays.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(arrays.uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(arrays.color, 3));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, signMaterial(signs));
  mesh.name = 'traffic signs'; mesh.castShadow = mesh.receiveShadow = true; mesh.userData.posts = arrays.posts; mesh.userData.mounts = arrays.mounts; mesh.userData.ranges = arrays.ranges;
  mesh.addEventListener('added', () => meshes.add(mesh));
  mesh.addEventListener('removed', () => meshes.delete(mesh));
  return mesh;
}

// The signs hung on house fronts, moved onto the walls as they are drawn: the worker hung
// them on the map's footprints, and the houses drawn (IPR's survey) can stand up to a
// metre or so in front of or behind those. From well out in front of each, a ray at the
// height of its arms along the way it faces the wall finds the first wall facing back
// along it, and the sign and its arms move by the difference (no more than REACH). Each
// `walls` is a tile's buildings' triangles, in the scene's frame.
const REACH = 1.4;
export function mountOnWalls(mesh: THREE.Mesh, walls: { position: Float32Array; normal: Float32Array }[]) {
  const mounts = mesh.userData.mounts as Float32Array | undefined;
  if (!mounts?.length || !walls.length) return 0;
  const pos = mesh.geometry.attributes.position.array as Float32Array;
  // (How far each has been moved already: a tile drawn again measures again.)
  const applied: Float32Array = mesh.userData.mounted ??= new Float32Array(mounts.length / 6);
  let moved = 0;
  for (let i = 0; i + 5 < mounts.length; i += 6) {
    const [x, y, z, angle, first, count] = Array.from(mounts.subarray(i, i + 6));
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const hits = [BOTTOM + .25, BOTTOM + .55].map(h => wallAlong(walls, x - dx * REACH, y - dy * REACH, z + h, dx, dy, REACH * 2));
    const found = hits.filter((d): d is number => d !== null).map(d => d - REACH);
    if (!found.length) continue;
    const d = Math.min(...found), step = d - applied[i / 6];
    if (Math.abs(step) < .005) continue;
    for (let v = first; v < first + count; v++) { pos[v * 3] += dx * step; pos[v * 3 + 2] -= dy * step; }
    applied[i / 6] = d; moved++;
  }
  if (moved) { mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.computeBoundingSphere(); }
  return moved;
}
// How far along (dx, dy) from (x, y) at height h the first wall facing back stands, within `far`.
function wallAlong(walls: { position: Float32Array; normal: Float32Array }[], x: number, y: number, h: number, dx: number, dy: number, far: number) {
  // In the scene's frame: (x, h, -y), going (dx, 0, -dy).
  const ox = x, oz = -y, vx = dx, vz = -dy;
  const minX = Math.min(ox, ox + vx * far) - .01, maxX = Math.max(ox, ox + vx * far) + .01;
  const minZ = Math.min(oz, oz + vz * far) - .01, maxZ = Math.max(oz, oz + vz * far) + .01;
  let best: number | null = null;
  for (const { position: p, normal: nrm } of walls) {
    for (let k = 0; k + 8 < p.length; k += 9) {
      const ax = p[k], ay = p[k + 1], az = p[k + 2], bx = p[k + 3], by = p[k + 4], bz = p[k + 5], cx = p[k + 6], cy = p[k + 7], cz = p[k + 8];
      if (Math.max(ax, bx, cx) < minX || Math.min(ax, bx, cx) > maxX || Math.max(az, bz, cz) < minZ || Math.min(az, bz, cz) > maxZ) continue;
      if (Math.max(ay, by, cy) < h || Math.min(ay, by, cy) > h) continue;
      // Möller–Trumbore, the ray level (direction (vx, 0, vz)).
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const px = -vz * e2y, py = vz * e2x - vx * e2z, pz = vx * e2y; // dir × e2
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det, tx = ox - ax, ty = h - ay, tz = oz - az;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (vx * qx + vz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < 0 || t > far || (best !== null && t >= best)) continue;
      // Only a wall's outside, facing back along the ray (not one it leaves a house through).
      if (nrm[k] * vx + nrm[k + 2] * vz > -.3) continue;
      best = t;
    }
  }
  return best;
}
// Every frame: the lit crossing boxes after dark (`night`: 0 by day, 1 at night).
export function lightSigns(night: number) {
  if (material) material.emissiveIntensity = Math.min(1, night * 2) * 1.6;
}

// For tests (scene.mjs, importing this module in the page): the sign meshes in the scene.
export const signAtlas = () => (material?.map?.image as HTMLCanvasElement | undefined)?.toDataURL('image/png') ?? null;
export const signsOnShow = () => ({ meshes: meshes.size, posts: [...meshes].flatMap(m => Array.from({ length: m.userData.posts.length / 4 }, (_, i) => Array.from(m.userData.posts.subarray(i * 4, i * 4 + 4) as Float32Array, v => Math.round(v * 10) / 10))), triangles: [...meshes].reduce((n, m) => n + m.geometry.attributes.position.count / 3, 0),
  names: drawnFor ?? [], lit: material?.emissiveIntensity ?? 0 });

// ---- Direction signs: each tile's plates and boards drawn onto a canvas of its own ----

const GREEN = '#0d7a3e';
const PLATE_INK: Record<PlateColour, [string, string]> = {
  green: [GREEN, WHITE], blue: [BLUE, WHITE], white: [WHITE, BLACK], brown: ['#7a4b2a', WHITE],
};
// A road number's badge, `h` px high with its left edge at x: red for motorways and the
// first-class roads (one or two digits), green for E roads, white with a black edge for the
// rest. Gives its width.
function badge(c: Ctx, ref: string, x: number, y: number, h: number) {
  const red = /^D\d/.test(ref) || /^\d{1,2}$/.test(ref), green = /^E\s?\d/.test(ref);
  c.save(); c.font = `bold ${h * .72}px ${FONT}`;
  const w = Math.max(h * 1.2, c.measureText(ref).width + h * .5);
  c.fillStyle = red ? RED : green ? GREEN : WHITE;
  c.beginPath(); c.roundRect(x, y - h / 2, w, h, h * .12); c.fill();
  c.strokeStyle = red || green ? WHITE : BLACK; c.lineWidth = h * .08; c.stroke();
  c.fillStyle = red || green ? WHITE : BLACK; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(ref, x + w / 2, y + h * .05); c.restore();
  return w;
}
// The airport symbol, `s` px across.
function plane(c: Ctx, x: number, y: number, s: number, colour: string) {
  c.save(); c.translate(x, y); c.rotate(-Math.PI / 4); c.fillStyle = colour;
  const p = [[0, -.5], [.07, -.1], [.45, .1], [.45, .18], [.07, .08], [.06, .34], [.17, .43], [.17, .5], [0, .45]];
  c.beginPath();
  for (const [px, py] of p) c.lineTo(px * s, py * s);
  for (const [px, py] of p.slice(1, -1).reverse()) c.lineTo(-px * s, py * s);
  c.closePath(); c.fill(); c.restore();
}
// Text no more than `room` px wide: narrowed to fit.
function fitText(c: Ctx, s: string, x: number, y: number, size: number, room: number, colour: string, align: 'left' | 'right' | 'center' = 'left') {
  c.save(); c.font = `bold ${size}px ${FONT}`; c.fillStyle = colour; c.textBaseline = 'middle';
  const w = c.measureText(s).width, k = w > room ? room / w : 1;
  const left = align === 'left' ? x : align === 'right' ? x - w * k : x - w * k / 2;
  c.translate(left, y); c.scale(k, 1); c.textAlign = 'left'; c.fillText(s, 0, 0); c.restore();
}
function drawPlate(c: Ctx, f: Face, r: Rect) {
  const b = f.branch!, [bg, ink] = PLATE_INK[b.colour], s = PX;
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  const ring = faceOutline(f);
  const path = (inset: number) => {
    c.beginPath();
    ring.forEach(([x, y], i) => {
      const px = x * s * (1 - inset / f.w * 2), py = -y * s * (1 - inset / f.h * 2);
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    });
    c.closePath();
  };
  c.fillStyle = bg; path(0); c.fill();
  c.strokeStyle = ink; c.lineWidth = s * .018; path(.03); c.stroke();
  // The text between the plate's square end and its point (or after the straight-on arrow).
  const a = f.w / 2 * s, hh = f.h / 2 * s;
  let left = -a + s * .09, right = a - s * .09;
  if (f.point > 0) right = a - hh - s * .02;
  else if (f.point < 0) left = -a + hh + s * .02;
  else { arrow(c, left + s * .1, hh * .7, hh * 1.4, s * .05, 0, ink); left += s * .26; }
  const lines = Math.max(1, f.places.length), gap = (hh * 2 - s * .06) / lines;
  for (let i = 0; i < lines; i++) {
    let x = left;
    const y = -hh + s * .03 + gap * (i + .5);
    if (i === 0) {
      for (const ref of f.refs) x += badge(c, ref, x, y, s * .17) + s * .04;
      if (b.symbol === 'airport') { plane(c, x + s * .1, y, s * .2, ink); x += s * .24; }
    }
    if (f.places[i]) fitText(c, f.places[i], x, y + s * .005, s * .15, right - x, ink);
  }
  c.restore();
}
function drawBoard(c: Ctx, f: Face, r: Rect) {
  const s = PX, a = f.w / 2 * s, hh = f.h / 2 * s, branches = f.sign.branches;
  const field = branches.every(b => b.colour === 'green') ? GREEN : BLUE;
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  c.fillStyle = field; c.fillRect(-a, -hh, a * 2, hh * 2);
  c.strokeStyle = WHITE; c.lineWidth = s * .03; c.strokeRect(-a + s * .04, -hh + s * .04, a * 2 - s * .08, hh * 2 - s * .08);
  // The junction: the stem from the bottom, then a line out along each branch with its head.
  const jy = hh * .25, len = s * .38, wide = s * .1;
  c.strokeStyle = WHITE; c.lineWidth = wide;
  c.beginPath(); c.moveTo(0, hh - s * .1); c.lineTo(0, jy); c.stroke();
  for (const b of branches) {
    const t = b.turn * Math.PI / 180, ux = -Math.sin(t), uy = -Math.cos(t);
    const ex = ux * len, ey = jy + uy * len;
    c.strokeStyle = c.fillStyle = WHITE;
    c.beginPath(); c.moveTo(0, jy); c.lineTo(ex, ey); c.stroke();
    c.beginPath(); c.moveTo(ex + ux * wide * 1.6, ey + uy * wide * 1.6); c.lineTo(ex - uy * wide * 1.1, ey + ux * wide * 1.1); c.lineTo(ex + uy * wide * 1.1, ey - ux * wide * 1.1); c.fill();
    // Its places by the head: left of a left branch, right of a right one, above straight on.
    const lines = b.places.slice(0, 3), lineH = s * .17, blockH = lineH * (Math.max(1, lines.length) + (b.refs.length ? 1 : 0));
    const side = Math.abs(b.turn) < 30 ? 0 : b.turn > 0 ? -1 : 1;
    const bw = side ? Math.max(s * .6, a - Math.abs(ex) - s * .16 - wide) : a * 1.1;
    let bx = side < 0 ? ex - wide * 2 - bw : side > 0 ? ex + wide * 2 : -bw / 2;
    let by = side ? ey - blockH / 2 : ey - wide * 2 - blockH;
    bx = Math.max(-a + s * .08, Math.min(a - s * .08 - bw, bx)); by = Math.max(-hh + s * .08, Math.min(hh - s * .08 - blockH, by));
    const [bg, ink] = PLATE_INK[b.colour];
    if (bg !== field) { c.fillStyle = bg; c.beginPath(); c.roundRect(bx - s * .03, by - s * .02, bw + s * .06, blockH + s * .04, s * .03); c.fill(); }
    let y = by + lineH / 2;
    if (b.refs.length) {
      let x = side < 0 ? bx + bw - b.refs.length * s * .3 : bx;
      for (const ref of b.refs) x += badge(c, ref, x, y, s * .15) + s * .04;
      y += lineH;
    }
    for (const place of lines) {
      fitText(c, place, side < 0 ? bx + bw : side > 0 ? bx : bx + bw / 2, y, s * .14, bw, ink, side < 0 ? 'right' : side > 0 ? 'left' : 'center');
      y += lineH;
    }
  }
  c.restore();
}
// A gantry's panel: its road numbers, its places, and an arrow over each of its lanes, down
// for straight on, up and out for a lane turning off.
function drawPanel(c: Ctx, f: Face, r: Rect) {
  const p = f.panel!, s = f.px, a = f.w / 2 * s, hh = f.h / 2 * s, [bg, ink] = PLATE_INK[p.colour];
  c.save(); c.translate(r.x + r.w / 2, r.y + r.h / 2);
  c.fillStyle = bg; c.fillRect(-a, -hh, a * 2, hh * 2);
  c.strokeStyle = ink; c.lineWidth = s * .05; c.strokeRect(-a + s * .08, -hh + s * .08, a * 2 - s * .16, hh * 2 - s * .16);
  let y = -hh + s * .25 + s * PANEL_LINE / 2;
  if (p.refs.length) {
    c.font = `bold ${s * .25}px ${FONT}`;
    const widths = p.refs.map(ref => Math.max(s * .42, c.measureText(ref).width + s * .18));
    let x = -(widths.reduce((t, w) => t + w + s * .1, 0) - s * .1) / 2;
    for (const ref of p.refs) x += badge(c, ref, x, y, s * .34) + s * .1;
    y += s * PANEL_LINE;
  }
  for (const place of f.places) {
    fitText(c, place, 0, y, s * .3, a * 2 - s * .4, ink, 'center');
    y += s * PANEL_LINE;
  }
  const lanes = p.last - p.first + 1, ay = hh - s * .32;
  for (let k = 0; k < lanes; k++) {
    const x = -a + (k + .5) * a * 2 / lanes, turn = p.turns[k] ?? 'through';
    const side = /right/.test(turn) ? 1 : /left/.test(turn) ? -1 : 0;
    // Down over a lane going on, up and to its side over a lane turning off.
    const ux = side * .7, uy = side ? -.7 : 1, len = s * .38, w = s * .07;
    c.save(); c.strokeStyle = c.fillStyle = ink; c.lineWidth = w;
    const x0 = x - ux * len / 2, y0 = ay - uy * len / 2, x1 = x + ux * len / 2, y1 = ay + uy * len / 2;
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1 - ux * w * 1.5, y1 - uy * w * 1.5); c.stroke();
    c.beginPath(); c.moveTo(x1 + ux * w * .6, y1 + uy * w * .6); c.lineTo(x1 - ux * w * 2 - uy * w * 1.6, y1 - uy * w * 2 + ux * w * 1.6);
    c.lineTo(x1 - ux * w * 2 + uy * w * 1.6, y1 - uy * w * 2 - ux * w * 1.6); c.fill(); c.restore();
  }
  c.restore();
}
// A tile's direction signs as a mesh, their faces drawn on a canvas of its own (laid out as
// map/directions.ts lays it out for the geometry). Its material and canvas are its own.
export function directionMesh(arrays: DirectionArrays, signs: DirectionSign[]) {
  const { faces, rects, width, height } = directionLayout(signs);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const c = canvas.getContext('2d')!;
  c.fillStyle = '#fff'; c.fillRect(0, 0, WHITE_CORNER, WHITE_CORNER);
  faces.forEach((f, i) => (f.kind === 'board' ? drawBoard : f.kind === 'panel' ? drawPanel : drawPlate)(c, f, rects[i]));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const g = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]] as const) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, cutAway(new THREE.MeshStandardMaterial({ map, vertexColors: true, roughness: .5, metalness: .15 }), 'furniture'));
  mesh.name = 'direction signs'; mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.posts = arrays.posts; mesh.userData.mounts = arrays.mounts; mesh.userData.ranges = arrays.ranges; mesh.userData.ownMaterial = true;
  mesh.addEventListener('added', () => meshes.add(mesh));
  mesh.addEventListener('removed', () => meshes.delete(mesh));
  return mesh;
}
// For tests: the direction signs' canvases in the scene, as PNGs.
export const directionCanvases = () => [...meshes].filter(m => m.userData.ownMaterial)
  .map(m => ((m.material as THREE.MeshStandardMaterial).map!.image as HTMLCanvasElement).toDataURL('image/png'));
