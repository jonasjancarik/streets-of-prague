import type { Scenario } from '../src/testkit.ts';
import type { Walker } from '../src/people.ts';
import type { TileWorld } from '../src/tiles.ts';
import type { Chopper } from '../src/helicopter.ts';

export default {
  title: 'Jump a bridge parapet, land a helicopter on a roof and steer a parachute off it',
  async run(t) {
    const d = (globalThis as unknown as { __drive: {
      world: TileWorld; walker: Walker; addChopper(): boolean; choppers: Chopper[]; enterOrExit(): void;
    } }).__drive;
    const { world, walker } = d;
    await t.go([50.0813, 14.4125]);
    const [x, y] = t.toLocal([50.0813, 14.4125]);
    const deck = world.below(x, y, Infinity);
    let lip = y;
    while (lip < y + 40 && Number.isFinite(world.levelAt(x, lip + 0.25, deck.level))) lip += 0.25;
    Object.assign(walker, { x, y: lip - 1, _tx: x, _ty: lip - 1, level: deck.level, gz: deck.h, h: Math.PI / 2 });
    await t.wait(0.7, { move: 1 });
    t.check('walking stops at the parapet', walker.level === deck.level && !walker.flight && deck.level > 0);
    const edge = walker.y;
    await t.wait(1 / 60, { jump: true, move: 1 });
    await t.wait(0.65, { move: 1 });
    t.check('a tap clears the bridge and falls without a canopy', !!walker.flight && !walker.flight.open && walker.y > edge);
    await t.wait(4);
    t.check('splash returns you to the deck', !walker.flight && walker.level === deck.level && Math.abs(walker.y - edge) < 1);

    await t.go([50.0838, 14.4085]);
    const quay = t.stepEdge({ water: true, drop: 3, r: 300, back: 5 });
    if (!t.check('a high quay wall on Kampa', !!quay) || !quay) return;
    await t.go(quay.from, { heading: quay.heading });
    await t.wait(3, { move: 1 });
    await t.wait(1 / 60, { jump: true, move: 1, brake: true });
    await t.wait(0.72, { move: 1, brake: true });
    t.check('the same jump opens a parachute off a quay', !!walker.flight?.open && t.pastEdge(quay) > 0);
    await t.wait(4);

    await t.go([50.0832, 14.4078]);
    const terrace = t.stepEdge({ water: false, drop: 2, r: 25, back: 5 });
    if (!t.check('a terrace above dry ground', !!terrace) || !terrace) return;
    await t.go(terrace.from, { heading: terrace.heading });
    await t.wait(3, { move: 1 });
    const top = t.groundHere();
    await t.wait(1 / 60, { jump: true, move: 1 });
    await t.wait(0.6, { move: 1 });
    t.check('jump clears the retaining wall', !!walker.flight && t.pastEdge(terrace) > 0);
    await t.wait(2);
    t.check('landed on the lower terrace', !walker.flight && top - t.groundHere() > 1.5);

    await t.go('staromak');
    if (!t.check('a helicopter is available', d.addChopper())) return;
    const c = d.choppers.at(-1)!;
    Object.assign(walker, { x: c.x + 2, y: c.y });
    walker.sync();
    d.enterOrExit();
    // A south-facing eave by the Old Town Square, with an open street below.
    const eave = { x: -3290.46, y: 3095.49, h: world.rooftopAt(-3290.46, 3095.49) };
    if (!t.check('a roof above the street', eave.h > world.terrainAt(eave.x, eave.y) + 10)) return;
    Object.assign(c, { x: eave.x, y: eave.y + 3, z: eave.h + 8, vx: 0, vy: 0, vz: 0, h: 0 });
    await t.wait(4, { run: true });
    d.enterOrExit();
    t.check('a pitched roof refuses landing and exit', !c.landed && t.where().mode === 'helicopter');
    const flat = world.rooftopAt(-3340, 3078);
    Object.assign(c, { x: -3340, y: 3078, z: flat + 8, vx: 0, vy: 0, vz: 0 });
    await t.wait(4, { run: true });
    t.check('skids settle at roof height', c.landed && Math.abs(c.z - world.rooftopAt(c.x, c.y)) < 0.6);
    d.enterOrExit();
    t.check('getting out leaves you standing on the roof', t.where().mode === 'foot' && walker.onRoof);
    d.enterOrExit();
    t.check('you can board again on the roof', t.where().mode !== 'foot');
    d.enterOrExit();
    Object.assign(walker, { x: eave.x, y: eave.y + 1.4, h: -Math.PI / 2 });
    Object.assign(walker, { level: c.level, gz: world.rooftopAt(walker.x, walker.y), _tx: walker.x, _ty: walker.y });
    walker.sync();
    await t.wait(1 / 60, { jump: true, move: 1, brake: true });
    await t.wait(0.9, { move: 1, brake: true });
    if (!t.check('holding jump opens the canopy past the eave', !!walker.flight?.open)) return;
    const heading = walker.h, altitude = walker.mesh.position.y;
    await t.wait(0.5, { turn: 1 });
    t.check('the open canopy turns gently after Space is released', !!walker.flight?.open && walker.h > heading + 0.2 && walker.h < heading + 0.7 && walker.mesh.position.y < altitude);
    await t.shot('rooftop-parachute');
    await t.wait(24);
    t.check('landed and ready to walk again', !walker.flight && walker.z === 0 && walker.mesh.position.y < altitude);
  },
} satisfies Scenario;
