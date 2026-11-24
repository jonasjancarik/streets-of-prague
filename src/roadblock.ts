import { turnOf } from './assist.ts';
import type { Car } from './car.ts';
import type { Polyline } from './network.ts';

// Roadblocks, from three stars: police cars parked across the road ahead of you, on the
// way you're likely to drive, their noses together in a V that points at you, with a gap
// between the noses a careful driver can just get through. Officers stand behind the cars
// and shoot as you come. Ram them and you're through, but it costs you speed and damage:
// parked with the handbrake on, they're harder to shift than a moving car. A wide street
// takes more cars, parked straight across beyond the V's arms. The block is cleared once
// you're past it or far away, or the chase is over.
//
// This file works out where (`ahead`) and how the cars stand (`layout`); police.ts sets
// them up, looks after them and clears them away.

// A street as the police's network has it (police.ts's Way), and a way on from a junction.
export interface BlockStreet {
  u: string; v: string; mid?: Polyline; width: number; kerb?: [number | null, number | null];
  bridge?: boolean; tunnel?: boolean; twin?: unknown;
}
export interface BlockLink { e: BlockStreet; back: boolean; foot: boolean }

// A place ahead: the street's middle there, the way you'd be heading, the metres from it to
// the kerb on your right and on your left, and how far it is along the way from you.
export interface Spot { x: number; y: number; ang: number; right: number; left: number; d: number }
// Where a car of the block stands, and which way it faces.
export interface Placed { x: number; y: number; h: number }

export interface Roadblock {
  x: number; y: number; ang: number; cars: Car[];
  // Seconds since it was set up; whether it's being cleared away.
  t: number; done: boolean;
}

const STEP = 10; // m between the places looked at
const JUNCTION = 14; // m: not this near a street's end, where it meets others
const STRAIGHT = 0.8; // rad: at a junction where every way turns more than this, you could take any

// Places along the way you're likely to drive, every STEP m from `near` to `far` m ahead:
// from `s` along street `e` (`fwd`: the way it was drawn), straight on at each junction
// (the way that turns least), up to a junction where every way turns sharply. Not on
// bridges or in tunnels, nor near the ends of a street. Into `out`, which it returns.
export function ahead(e: BlockStreet, s: number, fwd: boolean, links: Map<string, BlockLink[]>, near: number, far: number, out: Spot[] = []) {
  out.length = 0;
  let street = e, back = !fwd, at = s, d = 0;
  for (let n = 0; n < 40 && d < far; n++) {
    const mid = street.mid;
    if (!mid) break;
    const len = mid.length, rest = back ? at : len - at;
    if (!street.bridge && !street.tunnel) {
      // (The kerbs as drawn are right and left of the street's own direction.)
      const kr = street.kerb?.[0] ?? street.width / 2, kl = street.kerb?.[1] ?? street.width / 2;
      for (let k = 0; k < rest && d + k <= far; k += STEP) {
        const sp = back ? at - k : at + k;
        if (d + k < near || sp < JUNCTION || sp > len - JUNCTION) continue;
        const p = mid.at(sp);
        out.push({ x: p.x, y: p.y, ang: back ? p.ang + Math.PI : p.ang, right: back ? kl : kr, left: back ? kr : kl, d: d + k });
      }
    }
    d += rest;
    const node = back ? street.u : street.v, heading = back ? mid.at(0).ang + Math.PI : mid.at(len).ang;
    let best: BlockLink | null = null, least = STRAIGHT;
    for (const l of links.get(node) ?? []) {
      const m = l.e.mid;
      if (l.foot || !m || l.e === street || l.e === street.twin) continue;
      const a = l.back ? m.at(m.length - Math.min(8, m.length)).ang + Math.PI : m.at(Math.min(8, m.length)).ang;
      const t = Math.abs(turnOf(heading, a));
      if (t < least) { least = t; best = l; }
    }
    if (!best?.e.mid) break;
    street = best.e;
    back = best.back;
    at = back ? best.e.mid.length : 0;
  }
  return out;
}

// How far across a car of length L and width W reaches, turned θ from straight across.
const span = (L: number, W: number, th: number) => L * Math.cos(th) + W * Math.sin(th);
const STEEPEST = 1.4; // rad: an arm of the V no closer than this to the street's own line
const SIDE_GAP = 1.2; // m left open at a kerb at most (a car doesn't get through that)

// The turn from straight across that makes a car reach `s` across, between `from` and `to`
// (as near as it gets).
function turnFor(s: number, L: number, W: number, from: number, to: number) {
  let lo = from, hi = to;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (span(L, W, m) > s) lo = m; else hi = m; }
  return lo;
}

// The cars of a roadblock at `spot`, for a street open `right` and `left` m from the spot
// each side: two nose to nose in a V, `gap` m between the noses, turned as near straight
// across as the width wants. A wider street takes more (`most` cars in all), one more each
// side at a time, beyond the V's arms and turned the same way, as far round as fills it.
// Null where `most` cars can't close it, or it's too narrow for the V.
export function layout(spot: Spot, right: number, left: number, gap: number, most: number, L: number, W: number, out: Placed[] = []) {
  out.length = 0;
  // (Along the street from the spot, `a`, and across it to the left, `c`, the gap in the
  // middle of the open width.)
  const c0 = (left - right) / 2, arm = (left + right) / 2 - gap / 2;
  const widest = Math.atan2(W, L), wide = span(L, W, widest);
  let k = 0;
  while (arm - k * (wide + 0.3) > wide + SIDE_GAP) if (2 + 2 * ++k > most) return null;
  const each = k ? Math.max(W, Math.min(wide, (arm - wide) / k - 0.3)) : 0;
  const reach = k ? arm - k * (each + 0.3) : arm;
  if (reach < span(L, W, STEEPEST)) return null;
  const th = turnFor(reach, L, W, widest, STEEPEST), ph = k ? turnFor(each, L, W, widest, Math.PI / 2) : 0;
  const ca = Math.cos(spot.ang), sa = Math.sin(spot.ang);
  // A car at `c` across, turned `t`, its nose toward the gap (`side` -1 on your right),
  // drawn back from it so the corner nearest you is level with the spot.
  const put = (c: number, t: number, side: number) => {
    const a = -(W / 2) * Math.cos(t) + (L / 2) * Math.sin(t);
    out.push({ x: spot.x + a * ca - c * sa, y: spot.y + a * sa + c * ca, h: spot.ang - side * (Math.PI / 2 + t) });
  };
  let c = gap / 2 + span(L, W, th) / 2;
  for (let i = 0; i <= k; i++) {
    const t = i ? ph : th;
    put(c0 - c, t, -1);
    put(c0 + c, t, 1);
    c += span(L, W, t) / 2 + 0.3 + span(L, W, ph) / 2;
  }
  return out;
}
