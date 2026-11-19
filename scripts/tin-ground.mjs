// The checks read the ground as the game does: from a tile's mesh where the map has one
// (index.json's "tin", src/tin.ts), else from the lattice. `--tin off` keeps the lattice.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { buildTin, decodeTin, tinSampler, TIN_FORMAT } from '../src/tin.ts';

export function meshGround(dir, index, args) {
  const listed = args.tin !== 'off' && index.tin?.format === TIN_FORMAT ? new Set(index.tin.tiles) : null;
  // The lattice sampler `base` for tile k, with the mesh in front of it where there is one.
  return (k, box, base, ref) => {
    const path = join(dir, 'tiles', `${k}.tin.bin.gz`);
    if (!listed?.has(k) || !existsSync(path)) return base;
    const raw = gunzipSync(readFileSync(path));
    const mesh = buildTin(decodeTin(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), box));
    return tinSampler(mesh, ref, base).sample;
  };
}
