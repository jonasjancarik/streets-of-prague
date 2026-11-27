import * as THREE from 'three';
import type { Bounds, Point2 } from './map/geo.ts';
import type { Bridge } from './statues.ts';
import type { GroundLayer } from './surface.ts';

// Endpoints of a parapet's centreline, at deck height, in the map's x/y metres.
export type RailSegment = [number, number, number, number, number, number];

function parameter(x: number, y: number, ax: number, ay: number, dx: number, dy: number) {
  return Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx*dx + dy*dy || 1)));
}

function onCharles(x: number, y: number, ex: number, ey: number, guides: [Point2, Point2][]) {
  for (const [a,b] of guides) {
    const dx = b[0]-a[0], dy = b[1]-a[1];
    // The stairs off the bridge and its end walls run across the parapet.
    if ((ex*dx + ey*dy)**2 < .65 * (ex*ex + ey*ey) * (dx*dx + dy*dy)) continue;
    const t = parameter(x,y,a[0],a[1],dx,dy);
    if ((x - a[0] - t*dx)**2 + (y - a[1] - t*dy)**2 < 2.5**2) return true;
  }
  return false;
}

// The deck worker emits each plain wall as its outside, inside and cap, four
// vertices each. The cap already follows the clipped tile geometry and terrain.
// The surveyed pier lines identify Charles Bridge among the city's other slabs.
export function finishBridgeStone(layers: GroundLayer[], bridge: Bridge, box: Bounds): RailSegment[] {
  const bounds = bridge.bounds;
  if (!bounds || box[0] > bounds[2] || box[2] < bounds[0] || box[1] > bounds[3] || box[3] < bounds[1]) return [];
  const guides: [Point2, Point2][] = [];
  for (const { line } of bridge.parapets) for (let i = 1; i < line.length; i++) {
    const a = line[i-1], b = line[i];
    if (Math.max(a[0],b[0]) >= box[0]-3 && Math.min(a[0],b[0]) <= box[2]+3 &&
        Math.max(a[1],b[1]) >= box[1]-3 && Math.min(a[1],b[1]) <= box[3]+3) guides.push([a,b]);
  }
  if (!guides.length) return [];
  const rails: RailSegment[] = [];
  const byLevel = new Map<number, RailSegment[]>();
  for (const layer of layers) {
    if (layer.parapetStart === undefined) continue;
    const p = layer.geometry.position;
    for (let i = layer.parapetStart; i+11 < p.length/3; i+=12) {
      const cap = (i+8)*3;
      const ax = (p[cap]+p[cap+9])*.5, ay = -(p[cap+2]+p[cap+11])*.5;
      const bx = (p[cap+3]+p[cap+6])*.5, by = -(p[cap+5]+p[cap+8])*.5;
      if (!onCharles((ax+bx)*.5,(ay+by)*.5,bx-ax,by-ay,guides)) continue;
      // Outside bottom y is 1.2 m below the walk. Inside bottom y is the walk.
      const ah = p[(i+5)*3+1], bh = p[(i+4)*3+1];
      const rail: RailSegment = [ax,ay,ah,bx,by,bh];
      rails.push(rail);
      if (layer.level !== undefined) {
        const sections = byLevel.get(layer.level);
        if (sections) sections.push(rail); else byLevel.set(layer.level, [rail]);
      }
      layer.charlesStone = true;
      const uv = layer.geometry.uv ??= new Float32Array(p.length/3*2);
      for (let j = 0; j < 12; j++) {
        const vertex = i + j, pos = vertex*3;
        // The bridge runs east-south-east. A fixed station keeps the individual
        // blocks continuous through tile seams and small bends in the wall.
        uv[vertex*2] = (p[pos]*.966 + p[pos+2]*.259) / 5.8;
        const height = j === 0 || j === 3 || j === 5 || j === 6 ? ah : bh;
        uv[vertex*2+1] = j >= 8 ? (j < 10 ? .803 : .978)
          : .070 + THREE.MathUtils.clamp((p[pos+1]-height+1.2)/2.2,0,1)*.691;
      }
    }
  }
  // A footbridge has no vehicle edges in the driving graph and otherwise
  // receives the generic asphalt deck. Only recolour triangles on this walk;
  // another structure can share its level in the same tile.
  for (const layer of layers) {
    if (!layer.deck || layer.order !== -599 || layer.pattern !== 'asphalt' || layer.level === undefined) continue;
    const sections = byLevel.get(layer.level);
    if (!sections) continue;
    const { position: p, index } = layer.geometry, walk: number[] = [], other: number[] = [];
    for (let i = 0; i < index.length; i += 3) {
      const a = 3*index[i], b = 3*index[i+1], c = 3*index[i+2];
      const x = (p[a]+p[b]+p[c])/3, y = -(p[a+2]+p[b+2]+p[c+2])/3;
      const belongs = sections.some(([ax,ay,,bx,by]) => {
        const dx = bx-ax, dy = by-ay, t = parameter(x,y,ax,ay,dx,dy);
        return (ax+t*dx-x)**2 + (ay+t*dy-y)**2 < 12**2;
      });
      (belongs ? walk : other).push(index[i],index[i+1],index[i+2]);
    }
    if (walk.length) {
      layer.charlesSetts = walk.length;
      // The setts run with the bridge (east-south-east, as its parapet stones: laying.ts).
      layer.geometry.lay = new Float32Array(p.length / 3).fill(Math.atan2(-.259, .966));
      if (other.length) { index.set(walk); index.set(other,walk.length); }
    }
  }
  return rails;
}

export function nearestRailFoot(x: number, y: number, rails: Iterable<RailSegment[]>) {
  let best = 1.6**2;
  let foot: [number, number, number] | undefined;
  for (const sections of rails) for (const [ax,ay,ah,bx,by,bh] of sections) {
    const dx = bx-ax, dy = by-ay, t = parameter(x,y,ax,ay,dx,dy);
    const px = ax+t*dx, py = ay+t*dy, d = (px-x)**2 + (py-y)**2;
    if (d < best) { best = d; foot = [px, py, ah+t*(bh-ah)]; }
  }
  return foot;
}

let stone: THREE.Texture | undefined;
export function bridgeStoneMap() {
  if (stone) return stone;
  const initial = document.createElement('canvas');
  // Keep the allocation the same size through the first GPU upload. Some
  // WebGPU backends retain a one-pixel allocation when only the image changes.
  initial.width = 1024; initial.height = 512;
  const ctx = initial.getContext('2d')!;
  ctx.fillStyle = '#8e8b84'; ctx.fillRect(0,0,initial.width,initial.height);
  const texture: THREE.Texture = new THREE.Texture(initial);
  stone = texture;
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  new THREE.ImageLoader().load(import.meta.env.BASE_URL + 'charles-sandstone.webp', image => {
    ctx.drawImage(image, 0, 0); texture.needsUpdate = true;
  });
  return texture;
}
