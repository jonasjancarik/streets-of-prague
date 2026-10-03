import type { TileJSON } from './contracts.ts';

export type TileBinaryKind = 'height' | 'bare' | 'levels' | 'ipr';

// Check decoded bytes before a required tile fetch can fulfill or reach workers.
// Optional files are selected by the caller; legacy label/material omissions stay valid.
export function validateTileBinary(kind: TileBinaryKind, buffer: ArrayBuffer, context: {
  key: string; url: string; n?: number; tile: Pick<TileJSON, 'structures' | 'ipr'>;
}) {
  const fail = (expected: string): never => {
    throw new Error(`Tile ${context.key}: invalid ${kind} data (expected ${expected}; got ${buffer.byteLength} decoded bytes; ${context.url})`);
  };
  const length = (allowed: number[]) => {
    if (!allowed.every(Number.isSafeInteger)) fail('a safe integer payload size');
    if (!allowed.includes(buffer.byteLength)) fail(`${allowed.join(' or ')} decoded bytes`);
  };
  if (kind === 'ipr') {
    if (buffer.byteLength < 8) fail('at least an 8-byte IPR header');
    const header = new DataView(buffer), triangles = header.getUint32(0, true), buildings = header.getUint32(4, true);
    const colours = Math.ceil((8 + 18 * triangles) / 4) * 4;
    length(triangles ? [colours + 3 * triangles, colours + 4 * triangles] : [8]);
    const counts = context.tile.ipr as Record<string, unknown> | undefined;
    for (const [name, actual] of [['triangles', triangles], ['buildings', buildings]] as const) {
      const promised = counts?.[name];
      if (promised !== undefined && (typeof promised !== 'number' || !Number.isSafeInteger(promised) || promised < 0 || promised !== actual)) {
        fail(`IPR header ${name} matching tile metadata ${String(promised)} (header has ${actual})`);
      }
    }
    return;
  }
  const n = context.n;
  if (n === undefined || !Number.isSafeInteger(n) || n < 2) return fail('an integer terrain grid size of at least 2');
  const points = n * n;
  if (!Number.isSafeInteger(points)) fail('a safe integer terrain grid size');
  if (kind === 'height') length([2 * points, 3 * points]);
  else if (kind === 'bare') length([2 * points]);
  else {
    const structures = context.tile.structures;
    if (!Array.isArray(structures) || !structures.length) return fail('a nonempty structures array for requested levels');
    length([2 * points * structures.length]);
  }
}
