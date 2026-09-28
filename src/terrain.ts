// A tile's terrain heights (pipeline/ipr_terrain.py): n × n heights every `step` metres
// from the tile's south-west corner, as uint16 decimetres above 100 m a.s.l. Used on
// the main thread and in the tile workers alike.

// Heights in metres above `ref` (the game's y = 0). A tile's bridge decks come on the
// same lattice, with 0 where there is no deck: NaN here.
import type { HeightSampler, Point } from './map/types.ts';

export function decodeHeights(buffer: ArrayBuffer, n: number, ref: number): Float32Array {
  const h = new Uint16Array(buffer), hm = new Float32Array(n * n);
  for (let i = 0; i < hm.length; i++) hm[i] = h[i] ? h[i] / 10 + 100 - ref : NaN;
  return hm;
}

// Height at a point, bilinear and clamped to the tile (NaN next to a missing height).
export function heightSampler(hm: Float32Array, [bx, by]: Point, n: number, step: number): HeightSampler {
  return (x: number, y: number): number => {
    const u = Math.min(n - 1.001, Math.max(0, (x - bx) / step)), v = Math.min(n - 1.001, Math.max(0, (y - by) / step));
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    const a = hm[j * n + i], b = hm[j * n + i + 1], c = hm[(j + 1) * n + i], d = hm[(j + 1) * n + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  };
}

// A tile's data file; `gz`: gzipped by the pipeline (index.json has "gzip"). A server
// may already have undone the gzip on the way, so it's only unpacked if it still
// starts with gzip's header (magic number, deflate).
export async function fetchBinary(url: string, gz = false): Promise<ArrayBuffer | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  if (!gz || b[0] !== 0x1f || b[1] !== 0x8b || b[2] !== 8) return buf;
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
