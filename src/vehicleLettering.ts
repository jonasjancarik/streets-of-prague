import * as THREE from 'three';

// Painted lettering on service vehicles and river craft. Accented letters have an extra row.
export const GLYPHS: Record<string, string[]> = {
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  Á: ['00010', '01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  Ž: ['01010', '11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  É: ['00010', '11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Č: ['01010', '01110', '10001', '10000', '10000', '10000', '10001', '01110'],
};

// Flat painted lettering. Each uninterrupted row of ink is a pair of triangles.
export function letteringGeometry(lines: string[], px: number) {
  const ink: number[] = [];
  lines.forEach((word, line) => [...word].forEach((ch, i) => {
    const rows = GLYPHS[ch];
    rows.forEach((row, j) => {
      const y = (rows.length - j - 1 - line * 10) * px;
      for (const run of row.matchAll(/1+/g)) {
        const x = (i * 6 + run.index - (word.length * 6 - 1) / 2) * px;
        const right = x + run[0].length * px, top = y + px;
        ink.push(x, y, 0, right, y, 0, right, top, 0, x, y, 0, right, top, 0, x, top, 0);
      }
    });
  }));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(ink, 3));
  g.computeVertexNormals();
  return g;
}
