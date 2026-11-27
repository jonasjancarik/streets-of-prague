import type { Tier } from './graphics.ts';

// Street-level budgets scale work even at 1× resolution and inside an XR framebuffer.
// Instanced people and the regular car bodies fill in beyond the close-detail range.
// How far from a street-level camera (first or third person, or the tilted free camera)
// the detailed models take over, in metres:
// `avatarReach`: life-size people (rocketbox.ts), at most `avatars` of them;
// `carReach`: the close car bodies, with their wheels, lamps and cabins (car.ts);
// `wallReach`: façade walls with real window depth (streetFacades.ts), the nearest `walls` of them;
// `castings`: manhole lids and drain grates in relief (streetIronwork.ts);
// `fewReach`: how much further than on Medium the few large things in view switch to
// their street models: trams, boats, ferries, the funicular, helicopters and metro lanterns.
// Ultra reaches furthest, so a model changes where it is small on screen; High reaches a
// little further than Medium. Lower tiers keep the switch close, where it costs least.
export const STREET_TIERS = {
  lowest: { avatars: 2, avatarReach: 8, carReach: 12, walls: 0, wallReach: 0, castings: 0, fewReach: 1, treeWood: .5, vrScale: .45, groundFine: 4, groundFlat: 8 },
  low: { avatars: 6, avatarReach: 14, carReach: 16, walls: 8, wallReach: 20, castings: 9, fewReach: 1, treeWood: .5, vrScale: .55, groundFine: 4, groundFlat: 8 },
  medium: { avatars: 12, avatarReach: 22, carReach: 20, walls: 12, wallReach: 27, castings: 15, fewReach: 1, treeWood: .75, vrScale: .65, groundFine: 2, groundFlat: 8 },
  high: { avatars: 24, avatarReach: 36, carReach: 30, walls: 24, wallReach: 42, castings: 24, fewReach: 1.25, treeWood: 1, vrScale: .75, groundFine: 2, groundFlat: 8 },
  ultra: { avatars: 32, avatarReach: 45, carReach: 40, walls: 36, wallReach: 56, castings: 32, fewReach: 1.6, treeWood: 1, vrScale: .75, groundFine: 2, groundFlat: 8 },
  // Past Ultra, for Custom only (graphics.ts): half as far again, and more people up close.
  max: { avatars: 48, avatarReach: 65, carReach: 60, walls: 54, wallReach: 84, castings: 48, fewReach: 2.4, treeWood: 1, vrScale: .9, groundFine: 2, groundFlat: 8 },
} satisfies Record<Tier | 'max', object>;
export const STREET_QUALITY = { ...STREET_TIERS.high };
// The most life-size people any tier has at once (rocketbox.ts sizes its umbrellas by it).
export const MOST_AVATARS = Math.max(...Object.values(STREET_TIERS).map((t) => t.avatars));

// A model that has switched to its street version keeps it until it is this much further
// off than where it switched: standing or driving along near the line, it doesn't flicker
// between the two.
export const KEEP = 1.15;

// Whether one of the few large things (`fewReach`) that switches to its street model
// `reach` m from the camera on Medium should show it, `distance2` (m², the distance
// squared) away; `shown`: whether it shows it now.
export function streetNear(shown: boolean, distance2: number, reach: number) {
  const r = reach * STREET_QUALITY.fewReach * (shown ? KEEP : 1);
  return distance2 < r * r;
}
