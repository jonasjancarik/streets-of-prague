// A neighbourhood delivery follows connected, loaded streets. The two contacts
// stand back from traffic, on the same side of the route a walker can reach.
import { project } from './assist.ts';
import type { WalkEdge } from './network.ts';
import type { Footpaths } from './walkingDirections.ts';
import type { Spot } from './missions.ts';

export interface CourierWalk { sender: Spot; recipient: Spot; distance: number }

export function courierWalk(paths: Footpaths, me: { x: number; y: number }, street: (x: number, y: number) => string | null, random: () => number): CourierWalk | null {
  const ground = (e: WalkEdge) => !e.level && !e.bridge && !e.tunnel && !e.levels?.some(([, l]) => l !== 0) && e.path.length > 1;
  const starts = [...new Set(paths.near(me.x, me.y, 30))].filter(ground)
    .map(e => ({ e, ...project(e.path, me.x, me.y) })).filter(p => p.d < 30).sort((a, b) => a.d - b.d);
  const start = starts.find(p => {
    const q = p.e.path.at(p.s);
    return paths.accessible?.([me.x, me.y], [q.x, q.y], 0) ?? true;
  });
  if (!start) return null;
  const contact = (e: WalkEdge, s: number): Spot | null => {
    const p = e.path.at(s), offset = e.side || Math.min(1, e.width / 4);
    for (const side of [1, -1]) {
      const x = p.x + side * Math.sin(p.ang) * offset, y = p.y - side * Math.cos(p.ang) * offset;
      const clear = paths.accessible;
      // Leave standing room around the person. A single line to the kerb can
      // graze a shop wall and strand the handoff on its very edge.
      if (clear && (!clear([p.x, p.y], [x, y], 0) ||
          !clear([x - .7, y], [x + .7, y], 0) || !clear([x, y - .7], [x, y + .7], 0))) continue;
      return { x, y, name: e.name || street(x, y) || 'the marked footpath' };
    }
    return null;
  };
  const deliveryDistance = 85 + random() * 55;
  const firstDirection = random() < .5;
  for (let attempt = 0; attempt < 4; attempt++) {
    let { e, s } = start, forward = attempt % 2 === 0 ? firstDirection : !firstDirection;
    let travelled = 0, sender: Spot | null = null, collectedAt = 0;
    const seen = new Set<WalkEdge>();
    while (!seen.has(e) && travelled < 210 && seen.size < 64) {
      seen.add(e);
      const length = forward ? e.path.length - s : s;
      // Keep doorways and junctions clear. Try another spot if the pavement is blocked.
      for (let d = 2; d < length - 1; d += 7) {
        const total = travelled + d;
        if (total < 12 || (sender && total - collectedAt < deliveryDistance)) continue;
        if (total > 200 || (!sender && total > 50)) break;
        const person = contact(e, s + (forward ? d : -d));
        if (!person) continue;
        if (!sender) { sender = person; collectedAt = total; }
        else if (Math.hypot(person.x - sender.x, person.y - sender.y) > 58) return { sender, recipient: person, distance: total - collectedAt };
      }
      travelled += length;
      const onward = paths.graph.adj.get(forward ? e.v : e.u)?.filter(n => !seen.has(n.e) && ground(n.e));
      if (!onward?.length || (!sender && travelled > 50)) break;
      const foot = onward.filter(n => !n.e.side);
      const choices = foot.length ? foot : onward;
      const next = choices[Math.floor(random() * choices.length)];
      e = next.e; forward = next.fwd; s = forward ? 0 : e.path.length;
    }
  }
  return null;
}
