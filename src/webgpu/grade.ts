// The tone curve and grade of ../grade.ts in TSL, and the same undone, for what is
// blended before the curve but meant as a colour on the screen (rain, smoke, mist).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Fn, vec3, dot, mix, clamp, max, sqrt, select, toneMappingExposure } from 'three/tsl';
import { GRADE } from '../grade.ts';
import type { N } from './common.ts';

const LUMA: N = vec3(0.2126, 0.7152, 0.0722);

// The whole grade: `exposure` below zero means the curve is off and the colour only scaled.
export const gradeCurve = Fn(([color, exposure]: N[]) => {
  const { a, b, c, d, e } = GRADE;
  const x: N = max(color.mul(exposure), 0).toVar();
  const y: N = clamp(x.mul(x.mul(a).add(b)).div(x.mul(x.mul(c).add(d)).add(e)), 0, 1).toVar();
  y.assign(clamp(mix(vec3(dot(y, LUMA)), y, GRADE.sat), 0, 1));
  return select(exposure.lessThan(0), color.mul(exposure.negate()), y);
}).setLayout({ name: 'customToneMapping', type: 'vec3', inputs: [{ name: 'color', type: 'vec3' }, { name: 'exposure', type: 'float' }] });

// What goes in before the curve to come out as `seen` (linear light, 0 to 1).
export const ungrade = (seen: N): N => Fn(() => {
  const { a, b, c, d, e } = GRADE;
  const ex: N = toneMappingExposure;
  const s: N = clamp(vec3(seen), 0, 1).toVar();
  const luma: N = dot(s, LUMA);
  const y: N = clamp(s.sub(luma).div(GRADE.sat).add(luma), 0, 0.999).toVar();
  const A = y.mul(-c).add(a), B = y.mul(-d).add(b);
  const x = B.negate().add(sqrt(B.mul(B).add(A.mul(y).mul(4 * e)))).div(A.mul(2));
  return select(ex.lessThan(0), s.div(max(ex.negate(), 0.001)), x.div(max(ex, 0.001)));
})();
