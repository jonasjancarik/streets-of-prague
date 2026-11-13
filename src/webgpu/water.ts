// The river and ponds, seen from above: wind ripples over a slow swell that tilt the
// surface, so it catches the sun and the sky's light unevenly (the tilted normal goes to
// the material's ordinary lighting, shadows included), mirrors more of the sky where it
// leans away from you, glitters towards the sun or the moon, and breaks up the lamps'
// light at night. Rain rings it and makes it choppier. A setting (WATER in shading.ts,
// Graphics.water); without it the water is the plain mottled colour.
// Per pixel: 4 noise reads for the waves, 2 more close up for the glitter.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  Fn, If, float, vec2, vec3, uniform, renderGroup, cameraPosition, normalize, reflect, dot, pow, max, floor, fract, length, abs, smoothstep, mix,
} from 'three/tsl';
import { skyAt } from './dome.ts';
import { WATER, SUN_DIR, SUN_LIGHT } from '../shading.ts';
import { type N, follow, followColor, uRain, hash12, vnoise, detail } from './common.ts';

export const uWater = follow(WATER);
const uSunLight: N = followColor(SUN_LIGHT);
const uSunDir: N = (() => {
  const u = uniform(SUN_DIR.value.clone()).setGroup(renderGroup);
  u.onRenderUpdate(() => { u.value.copy(SUN_DIR.value); return u.value; });
  return u;
})();

const SWELL = 0.3, RIPPLE = 0.16; // how steep the two layers get
const SKY = 5.3;                  // SKY_REF is 0.06 of the sky's light; a mirror shows about a third of it
const FLAT_MIRROR = 0.2;          // from how much of a mirror the water reads the real sky
const BANK = 0.3;                 // how dark the far bank's band is in it

// How much of a mirror still water is from here (0.05 from straight above, 0.95 along it):
// that much less of its own colour shows (webgpu.ts, pWater).
export const flatMirror = (w: N): N => pow(float(1).sub(max(normalize(cameraPosition.sub(w)).y, 0)), 3).mul(0.9).add(0.05);

// Rings spreading from a drop in each cell (the puddles' and the water's).
export function ripples(p0: N, time: N) {
  const p = p0.mul(2.5), i = floor(p), f = fract(p);
  const t = fract(time.mul(1.1).add(hash12(i)));
  const c = vec2(hash12(i.add(1.7)), hash12(i.add(4.3))).mul(0.6).add(0.2);
  return t.oneMinus().mul(smoothstep(0, 0.07, abs(length(f.sub(c)).sub(t.mul(0.45)))).oneMinus());
}

// The map turned by an angle, so that the noise's square lattice doesn't line up with the screen.
const turned = (p: N, a: number) => vec2(p.x.mul(Math.cos(a)).sub(p.y.mul(Math.sin(a))), p.x.mul(Math.sin(a)).add(p.y.mul(Math.cos(a))));

// The slope of the surface at a point of the map (x east, y north); none with the water off.
export const waves = (p: N, time: N): N => Fn(() => {
  const s = vec2(0).toVar();
  If(uWater.greaterThan(0.5), () => {
    const a = turned(p, 0.5).mul(vec2(0.13, 0.21)).add(vec2(time.mul(0.06), time.mul(0.1)));
    const b = turned(p, -0.9).mul(vec2(1.1, 0.62)).add(vec2(time.mul(-0.4), time.mul(0.27)));
    s.assign(vec2(vnoise(a), vnoise(a.add(37.2))).sub(0.5).mul(SWELL).add(vec2(vnoise(b), vnoise(b.add(19.4))).sub(0.5).mul(RIPPLE)));
    s.mulAssign(uRain.mul(0.6).add(1));
  });
  return s;
})();
// (The map's north is the world's −z.)
export const waveNormal = (s: N) => normalize(vec3(s.x.negate(), 1, s.y));

// The light the surface mirrors: the sky, the sun's glitter and the lamps (`lamps`: their
// light there, read a little aside by the slope so that it wavers).
export function waterShine(w: N, p: N, s: N, time: N, skyRef: N, lamps: N) {
  const out = vec3(0).toVar();
  const near = detail(p, 0.5); // (derivatives outside the branch)
  If(uWater.greaterThan(0.5), () => {
    const v = normalize(cameraPosition.sub(w)).toVar(), n = waveNormal(s).toVar();
    const r = reflect(v.negate(), n);
    // More of a mirror the more it leans away, and the sky is lighter towards the horizon.
    const mirror = pow(float(1).sub(max(dot(n, v), 0)), 3).mul(0.9).add(0.05).toVar();
    out.assign(skyRef.mul(SKY).mul(float(1.5).sub(r.y.mul(0.5))).mul(mirror));
    // Seen at a slant (from the street, a bridge, a boat) it is a real mirror: the sky in the
    // direction it reflects, clouds, the sun's glow and its disc broken up by the ripples, and
    // low down a darker band for the far bank. From above the slant never gets this far, and
    // the sky is not read (webgpu/dome.ts: eight noise reads).
    If(mirror.greaterThan(FLAT_MIRROR), () => {
      const up: N = vec3(r.x, max(r.y, 0.03), r.z);
      const seen: N = skyAt(up, w.xz).rgb.mul(mix(BANK, 1, smoothstep(0.03, 0.14, up.y)));
      out.assign(mix(out, seen.mul(mirror), smoothstep(FLAT_MIRROR, FLAT_MIRROR + 0.15, mirror)));
    });
    // Only the facets that lean catch a lamp: broken streaks, not a lit sheet.
    out.addAssign(lamps.mul(smoothstep(0.05, 0.2, length(s)).mul(0.45)));
    If(near.greaterThan(0), () => {
      // Small steep facets flash the sun, the more the closer they lean towards it.
      const q = turned(p, 1.9).mul(vec2(3.7, 2.3)).add(vec2(time.mul(-0.9), time.mul(0.7)));
      const f = s.mul(2).add(vec2(vnoise(q), vnoise(q.add(7.7))).sub(0.5).mul(0.7));
      const glint = pow(max(dot(reflect(v.negate(), waveNormal(f)), uSunDir), 0), 160);
      out.addAssign(uSunLight.mul(glint).mul(0.22).mul(near));
      If(uRain.greaterThan(0.01), () => { out.addAssign(skyRef.mul(SKY).mul(ripples(p, time)).mul(uRain).mul(0.22).mul(near)); });
    });
  });
  return out;
}

