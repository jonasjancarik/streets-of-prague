// A tile's terrain heights (pipeline/ipr_terrain.py): n × n heights every `step` metres
// from the tile's south-west corner, as uint16 decimetres above 100 m a.s.l. Used on
// the main thread and in the tile workers alike.

// Heights in metres above `ref` (the game's y = 0). The top bit marks a point on water
// (see wetPoints).
export function decodeHeights(buffer: ArrayBuffer, n: number, ref: number) {
  const h = new Uint16Array(buffer), hm = new Float32Array(n * n);
  for (let i = 0; i < hm.length; i++) hm[i] = (h[i] & HEIGHT) / 10 + 100 - ref;
  return hm;
}
const HEIGHT = 0x7fff;

// Which of a tile's points are on water (1) and which on land (0), or null where the
// data doesn't say (pipeline/dtm_heights.py marks them). A bank is a step in the ground,
// often a wall: the height on either side of it is read from that side's points alone.
export function wetPoints(buffer: ArrayBuffer, n: number) {
  const h = new Uint16Array(buffer), wet = new Uint8Array(n * n);
  let any = false;
  for (let i = 0; i < wet.length; i++) if (h[i] > HEIGHT) { wet[i] = 1; any = true; }
  return any ? wet : null;
}

// A tile's bridge and tunnel levels (.levels.bin): `count` lattices one after another,
// in centimetres above 100 m a.s.l., with 0 away from the level: NaN here.
export function decodeLevels(buffer: ArrayBuffer, n: number, count: number, ref: number) {
  const h = new Uint16Array(buffer), out: Float32Array[] = [];
  for (let k = 0; k < count; k++) {
    const hm = new Float32Array(n * n), o = k * n * n;
    for (let i = 0; i < hm.length; i++) hm[i] = h[o + i] ? h[o + i] / 100 + 100 - ref : NaN;
    out.push(hm);
  }
  return out;
}

// Height at a point, bilinear and clamped to the tile (NaN next to a missing height).
// With `wet` (wetPoints), where a bank crosses the cell only the corners on one side of
// it count: the water's when asked for (`onWater`), otherwise the land's, so what stands
// by a quay wall stands on the quay.
export function heightSampler(hm: Float32Array, [bx, by]: [number, number] | [number, number, number, number], n: number, step: number, wet: Uint8Array | null = null) {
  return (x: number, y: number, onWater = false) => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx) / step)), v = Math.min(n - 1.001, Math.max(0, (y - by) / step));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const o = j * n + i;
    const a = hm[o], b = hm[o + 1], c = hm[o + n], d = hm[o + n + 1];
    if (wet) {
      const wa = wet[o], wb = wet[o + 1], wc = wet[o + n], wd = wet[o + n + 1], count = wa + wb + wc + wd;
      if (count > 0 && count < 4) {
        const side = onWater ? 1 : 0;
        const ka = wa === side ? (1 - fu) * (1 - fv) : 0, kb = wb === side ? fu * (1 - fv) : 0;
        const kc = wc === side ? (1 - fu) * fv : 0, kd = wd === side ? fu * fv : 0;
        const k = ka + kb + kc + kd;
        if (k > 1e-4) return (a * ka + b * kb + c * kc + d * kd) / k;
        // Right at a corner of the other side: the mean of this side's corners.
        const same = onWater ? count : 4 - count;
        return ((wa === side ? a : 0) + (wb === side ? b : 0) + (wc === side ? c : 0) + (wd === side ? d : 0)) / same;
      }
    }
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
}

// A tile's data file; `gz`: gzipped by the pipeline (index.json has "gzip"). A server
// may already have undone the gzip on the way, so it's only unpacked if it still
// starts with gzip's header (magic number, deflate).
export async function fetchBinary(url: string, gz = false) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  if (!gz || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
