// Across each legal driving movement at a bridge end, measure the largest change
// in longitudinal pitch across 2 m, using a 4 m front-to-back span.
export function joinRides(atNode, height) {
  const rows = [];
  for (const [node, edges] of atNode) {
    const cars = edges.filter(e => e.net === 'drive');
    const bridges = cars.filter(e => e.bridge && e.level > 0);
    for (const bridge of bridges) for (const road of cars) {
      if (road.bridge || road.tunnel || (bridge.u === node) === (road.u === node)) continue;
      const a = samples(road, node, height), b = samples(bridge, node, height);
      const length = Math.min(a.length, b.length);
      if (length < 5) continue;
      let worst = 0;
      for (let lane = 0; lane < 3; lane++) {
        const z = [...a.slice(1, length).reverse().map(row => row[2 - lane]), ...b.slice(0, length).map(row => row[lane])];
        const pitch = z.slice(4).map((v, i) => Math.atan2(v - z[i], 4) * 180 / Math.PI);
        for (let i = 2; i < pitch.length; i++) worst = Math.max(worst, Math.abs(pitch[i] - pitch[i - 2]));
      }
      rows.push({ road: road.id, bridge: bridge.id, node, name: bridge.name, degrees: +worst.toFixed(2) });
    }
  }
  return rows.sort((a, b) => b.degrees - a.degrees);
}

function samples(edge, node, height) {
  const reverse = edge.v === node;
  const pts = reverse ? [...edge.pts].reverse() : edge.pts;
  const lengths = pts.slice(1).map(([x,y], i) => Math.hypot(x - pts[i][0], y - pts[i][1]));
  const total = lengths.reduce((a,b) => a+b, 0);
  const rows = [];
  let start = 0;
  for (let i = 0; i < lengths.length && rows.length <= 18; i++) {
    const d = lengths[i];
    if (!d) continue;
    const [ax,ay] = pts[i], dx = (pts[i+1][0]-ax)/d, dy = (pts[i+1][1]-ay)/d;
    for (let k = rows.length; k <= start+d && k <= 18; k++) {
      const s = reverse ? total-k : k;
      const level = edge.levels?.findLast(([from]) => from <= s)?.[1] ?? edge.level ?? 0;
      const x = ax + dx*(k-start), y = ay + dy*(k-start);
      rows.push([-.4,0,.4].map(f => height(x-dy*f*edge.width/2, y+dx*f*edge.width/2, level)));
    }
    start += d;
  }
  return rows;
}
