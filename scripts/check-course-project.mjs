#!/usr/bin/env node
// Course.project's `within` shortcut (src/river.ts) against the plain scan of every
// piece: the same place along the line and the same distance wherever the line is
// within reach, and a distance beyond the reach wherever it isn't.
// node scripts/check-course-project.mjs   (uses the built map's fairway when it is there)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Course } from '../src/river.ts';

const file = new URL('../public/data/praha_now/river.json', import.meta.url);
// (Without the map: a meander of 3000 points, about as long as the Vltava in Prague.)
const meander = () => [{ pts: Array.from({ length: 3000 }, (_, i) => [Math.sin(i / 90) * 2500 + Math.sin(i / 7) * 30, i * 12, 40]) }];
const reaches = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).fairway : meander();
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let asked = 0, inReach = 0, plain = 0, quick = 0;
for (const reach of reaches) {
  const course = new Course(reach.pts);
  const xs = reach.pts.map((p) => p[0]), ys = reach.pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  // Half the places anywhere within 3 km of the reach, half within 500 m of one of its points.
  const places = Array.from({ length: 20000 }, (_, i) => {
    const p = reach.pts[Math.floor(random() * reach.pts.length)];
    return i % 2 ? [p[0] + (random() - 0.5) * 1000, p[1] + (random() - 0.5) * 1000] : [x0 - 3000 + random() * (x1 - x0 + 6000), y0 - 3000 + random() * (y1 - y0 + 6000)];
  });
  for (const within of [60, 420, 5000]) {
    let t = performance.now();
    const whole = places.map(([x, y]) => course.project(x, y));
    plain += performance.now() - t;
    t = performance.now();
    const boxed = places.map(([x, y]) => course.project(x, y, undefined, undefined, within));
    quick += performance.now() - t;
    places.forEach((place, i) => {
      asked++;
      if (whole[i].d <= within) { inReach++; assert.deepEqual(boxed[i], whole[i], `at ${place} within ${within}`); }
      else assert(boxed[i].d > within, `at ${place}: ${boxed[i].d} should be beyond ${within}`);
    });
  }
}
assert(inReach > asked / 10, 'too few places within reach to mean anything');
console.log(`Course.project: ${asked} places, ${inReach} within reach, all the same; every piece ${plain.toFixed(0)} ms, with boxes ${quick.toFixed(0)} ms`);
