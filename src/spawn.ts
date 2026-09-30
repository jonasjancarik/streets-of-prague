// A distribution belongs to one replenishment pass. Keeping the original selection
// arithmetic matters at exact boundaries and after floating-point subtraction.
export function preparePeople<E>(edges: E[], weight: (edge: E) => number) {
  let total = 0;
  const upTo = edges.map((edge) => (total += weight(edge)));
  return { edges, upTo, total };
}

export function pickPerson<E extends { path: { length: number; at(s: number): { x: number; y: number } } }>(
  sampler: ReturnType<typeof preparePeople<E>>, random: () => number,
  ok: ((x: number, y: number) => boolean) | null,
) {
  const { edges, upTo, total } = sampler;
  if (!edges.length) return null;
  for (let t = 0; t < 8; t++) {
    const x = random() * total;
    let lo = 0, hi = upTo.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (upTo[mid] < x) lo = mid + 1; else hi = mid; }
    const e = edges[lo], s = random() * e.path.length, at = e.path.at(s);
    if (!ok || ok(at.x, at.y)) return { e, s };
  }
  return null;
}

export function prepareTraffic<E>(edges: E[], weight: (edge: E) => number, ordinary: boolean) {
  const weights = edges.map(weight);
  // reduce starts at zero, as the original traffic selection did.
  const total = weights.reduce((sum, value) => sum + value, 0);
  return { edges, weights, total, ordinary };
}

export function pickTraffic<E>(sampler: ReturnType<typeof prepareTraffic<E>>, random: () => number): E | null {
  const { edges, weights, total } = sampler;
  if (!edges.length) return null;
  let x = random() * total, edge = edges[0];
  for (let i = 0; i < edges.length; i++) if ((x -= weights[i]) < 0) { edge = edges[i]; break; }
  return edge;
}
