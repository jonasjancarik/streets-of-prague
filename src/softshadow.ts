// The sun's shadows with edges that widen with distance from what casts them
// (webgpu/shadows.ts): sharp at the foot of a wall, soft across the street from a tall
// house. Ultra's (graphics.ts); ?softshadows=on|off overrides the tier for one visit.
const asked = new URLSearchParams(globalThis.location?.search ?? '').get('softshadows');
export const SOFT_SHADOWS = {
  // Whether the tier wants them.
  tier: 0,
  get value() { return asked === 'on' ? 1 : asked === 'off' ? 0 : this.tier; },
};
// The filter itself, once the WebGPU side has made it: main.ts gives it to the sun's shadow.
export const SHADOW_FILTER: { value: unknown } = { value: null };
