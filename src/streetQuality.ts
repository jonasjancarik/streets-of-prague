import type { Tier } from './graphics.ts';

// Street-level budgets scale work even at 1× resolution and inside an XR framebuffer.
// Instanced people and the regular car bodies fill in beyond the close-detail range.
export const STREET_TIERS = {
  lowest: { avatars: 2, avatarReach: 8, carReach: 12, treeWood: .5, vrScale: .45 },
  low: { avatars: 6, avatarReach: 14, carReach: 16, treeWood: .5, vrScale: .55 },
  medium: { avatars: 12, avatarReach: 22, carReach: 20, treeWood: .75, vrScale: .65 },
  high: { avatars: 24, avatarReach: 30, carReach: 24, treeWood: 1, vrScale: .75 },
  ultra: { avatars: 24, avatarReach: 30, carReach: 24, treeWood: 1, vrScale: .75 },
} satisfies Record<Tier, object>;
export const STREET_QUALITY = { ...STREET_TIERS.high };
