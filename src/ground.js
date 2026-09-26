import { fillPolys, strokeLines, rng } from '../geo.js';
import { offsetLine, segDist } from './network.js';

// Present-day ground: asphalt and granite setts, Prague mosaic pavements, car parks,
// lane markings and zebra crossings. Same canvas layout as ../ground.js.

const C = {
  pavement: '#c9c3b8',
  square: '#cdc6b8',
  path: '#d2ccc0',
  dirt: '#c2ab82',
  park: '#8dac5f',
  wood: '#5d7e43',
  orchard: '#9bb26a',
  pitch: '#6f9f57',
  water: '#4d7680',
  asphalt: '#5f6266',
  sett: '#8a847a',
  parking: '#6b6d70',
  bridge: '#65686b',
  trackbed: '#7a7a76',
  steel: '#3c3d3f',
  paint: 'rgba(240,238,228,0.9)',
};

function noise(base, spread, n, size = 128, seed = 7, blob = 1.4) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const l = (r() - 0.5) * spread;
    ctx.fillStyle = l > 0 ? `rgba(255,255,250,${l})` : `rgba(20,20,20,${-l})`;
    const s = 0.5 + r() * blob;
    ctx.fillRect(r() * size, r() * size, s, s);
  }
  return c;
}

// Rows of small blocks: granite setts on roads, mosaic on pavements, slabs on squares.
function blocks(base, cell, spread, seed, size = 96) {
  const c = noise(base, spread * 0.8, 600, size, seed, 1);
  const ctx = c.getContext('2d');
  const r = rng(seed + 1);
  for (let y = 0; y < size; y += cell) {
    const off = (y / cell) % 2 ? cell / 2 : 0;
    for (let x = -cell; x < size; x += cell) {
      const l = (r() - 0.5) * spread;
      ctx.fillStyle = l > 0 ? `rgba(255,255,245,${l})` : `rgba(25,25,25,${-l})`;
      ctx.fillRect(x + off, y, cell - 0.7, cell - 0.7);
    }
  }
  return c;
}

export function paintGroundNow(geo, traffic, pxW = 4096) {
  const d = geo.data;
  const s = pxW / geo.W;
  const c = document.createElement('canvas');
  c.width = pxW;
  c.height = Math.round(geo.H * s);
  const ctx = c.getContext('2d');
  const pat = (canvas) => ctx.createPattern(canvas, 'repeat');

  ctx.fillStyle = pat(blocks(C.pavement, 3, 0.12, 1, 96));
  ctx.fillRect(0, 0, c.width, c.height);

  const A = d.areas, R = d.roads;
  const layer = (polys, fill, stroke, lw = 2) => {
    if (!polys) return;
    ctx.fillStyle = fill;
    fillPolys(ctx, geo, polys, s);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  };

  layer(A.park, pat(noise(C.park, 0.35, 6000, 256, 2, 2.2)), 'rgba(50,70,35,0.35)');
  layer(A.orchard, pat(noise(C.orchard, 0.35, 5000, 256, 3, 2.2)), 'rgba(50,70,35,0.35)');
  layer(A.wood, pat(noise(C.wood, 0.45, 7000, 256, 5, 2.8)), 'rgba(35,50,25,0.4)');
  layer(A.pitch, pat(noise(C.pitch, 0.18, 2000, 256, 4)), 'rgba(250,250,245,0.8)', 3);
  layer(A.square, pat(blocks(C.square, 6, 0.1, 6, 96)), 'rgba(90,85,75,0.35)', 1.5);
  layer(A.parking, pat(noise(C.parking, 0.22, 2500, 128, 7, 1)), 'rgba(235,235,225,0.7)', 1.6);

  if (A.water) {
    ctx.save();
    ctx.fillStyle = pat(noise(C.water, 0.12, 1500, 256, 11, 3));
    fillPolys(ctx, geo, A.water, s);
    ctx.clip('evenodd');
    ctx.filter = `blur(${Math.round(2 * s)}px)`;
    ctx.strokeStyle = 'rgba(20,40,45,0.45)';
    ctx.lineWidth = 5 * s;
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = 'rgba(70,68,62,0.85)';
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  if (d.weirs?.length) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.filter = `blur(${Math.round(2.5 * s)}px)`;
    ctx.strokeStyle = 'rgba(235,242,240,0.55)';
    ctx.lineWidth = 9 * s;
    ctx.translate(0, -3 * s);
    strokeLines(ctx, geo, d.weirs, s);
    ctx.restore();
    ctx.strokeStyle = '#8c8a82';
    ctx.lineWidth = 2.2 * s;
    strokeLines(ctx, geo, d.weirs, s);
  }

  layer(R.dirt, pat(noise(C.dirt, 0.3, 2500, 128, 8)), 'rgba(110,90,60,0.25)', 1.6);
  layer(R.path, pat(blocks(C.path, 2, 0.16, 9, 64)), 'rgba(95,90,80,0.35)', 1.6);
  layer(R.sett, pat(blocks(C.sett, 2.6, 0.22, 10, 96)), 'rgba(60,58,54,0.6)', 1.8);
  layer(R.road, pat(noise(C.asphalt, 0.16, 5000, 128, 12, 1)), 'rgba(45,46,48,0.7)', 1.8);

  const bridges = [...(A.bridge || []), ...(R.bridge || [])];
  if (bridges.length) {
    ctx.save();
    ctx.shadowColor = 'rgba(10,20,25,0.6)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetX = 10;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = pat(noise(C.bridge, 0.16, 5000, 128, 13, 1));
    fillPolys(ctx, geo, bridges, s);
    ctx.restore();
    ctx.strokeStyle = 'rgba(70,68,62,0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // Tram tracks: a concrete track bed with two steel rails, standard gauge.
  const trams = d.rails.filter((r) => r.kind === 'tram').map((r) => r.pts);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = C.trackbed;
  ctx.lineWidth = 2.4 * s;
  strokeLines(ctx, geo, trams, s);
  ctx.strokeStyle = C.steel;
  ctx.lineWidth = Math.max(1, 0.12 * s);
  strokeLines(ctx, geo, trams.flatMap((pts) => [offsetLine(pts, 0.72), offsetLine(pts, -0.72)]), s);
  const fun = d.rails.filter((r) => r.kind === 'funicular').map((r) => r.pts);
  ctx.strokeStyle = 'rgba(95,90,82,0.9)';
  ctx.lineWidth = 3 * s;
  strokeLines(ctx, geo, fun, s);

  // Dashed centre line on two-way asphalt streets, except where trams run down the middle.
  const railSegs = [];
  for (const pts of trams) for (let i = 0; i < pts.length - 1; i++) railSegs.push([pts[i], pts[i + 1]]);
  const nearRail = ([x, y]) => railSegs.some(([a, b]) => segDist(x, y, a, b) < 3);
  const cobbled = new Set(['sett', 'cobblestone', 'unhewn_cobblestone', 'paving_stones']);
  const centre = [];
  for (const e of traffic.drive.edges) {
    if (e.oneway || e.u > e.v || cobbled.has(e.surface)) continue;
    if (!['primary', 'secondary', 'tertiary', 'tertiary_link'].includes(e.hw)) continue;
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    if (nearRail(mid) || nearRail(e.pts[0]) || nearRail(e.pts[e.pts.length - 1])) continue;
    centre.push(e.pts);
  }
  ctx.strokeStyle = C.paint;
  ctx.lineWidth = Math.max(1, 0.13 * s);
  ctx.setLineDash([3 * s, 6 * s]);
  strokeLines(ctx, geo, centre, s);
  ctx.setLineDash([]);

  // Zebra crossings: bars along the walking direction, alternating along the road.
  ctx.fillStyle = C.paint;
  for (const pts of d.crossings || []) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      const ux = (bx - ax) / len, uy = (by - ay) / len, vx = -uy, vy = ux;
      for (let o = -1.75; o <= 1.76; o += 1) {
        const q = [[ax + vx * o, ay + vy * o], [bx + vx * o, by + vy * o], [bx + vx * (o + 0.5), by + vy * (o + 0.5)], [ax + vx * (o + 0.5), ay + vy * (o + 0.5)]];
        ctx.beginPath();
        q.forEach(([x, y], k) => { const [u, v] = geo.px(x, y, s); k ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
        ctx.fill();
      }
    }
  }

  // Soft contact shadow around buildings.
  const ao = document.createElement('canvas');
  ao.width = c.width;
  ao.height = c.height;
  const actx = ao.getContext('2d');
  actx.fillStyle = 'rgba(30,30,30,0.5)';
  fillPolys(actx, geo, d.buildings.map((b) => b.rings), s);
  ctx.save();
  ctx.filter = `blur(${Math.round(1.2 * s)}px)`;
  ctx.drawImage(ao, 0, 0);
  ctx.restore();

  // Gentle large-scale variation so big areas don't look flat.
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  const r = rng(99);
  for (let i = 0; i < 120; i++) {
    const x = r() * c.width, y = r() * c.height, rad = 60 + r() * 240;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, r() > 0.5 ? 'rgba(255,250,240,0.25)' : 'rgba(30,30,30,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  ctx.restore();
  return c;
}
