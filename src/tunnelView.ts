// How much of a tunnel you see from above: the usual hole round you, a wider one, or
// one wide enough to show most of the tunnel's road (the setting "Tunnels").

export type TunnelView = 'normal' | 'wide' | 'full';
export const TUNNEL_VIEWS: TunnelView[] = ['normal', 'wide', 'full'];
const MAX: Record<TunnelView, number> = { normal: 45, wide: 90, full: 160 };

let mode: TunnelView = 'normal';
try {
  const saved = localStorage.getItem('tunnelView');
  if (saved === 'wide' || saved === 'full') mode = saved;
} catch { /* no storage: normal */ }

export const tunnelView = () => mode;
export const setTunnelView = (m: TunnelView) => {
  mode = m;
  try { localStorage.setItem('tunnelView', m); } catch { /* not saved */ }
};

// The radius of the hole for a tunnel `depth` m under the ground above.
export const tunnelHole = (depth: number) => {
  const k = mode === 'normal' ? 0.35 : 1;
  return Math.min(MAX[mode], (mode === 'normal' ? 14 : 30) + k * Math.max(0, depth));
};
