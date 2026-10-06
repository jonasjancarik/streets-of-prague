import { apart, dropOff, goTo, pickUp, putOut, serve } from './missions.ts';
import type { MissionDef } from './missions.ts';

// The odd jobs: repeatable work made up from the map, each picking its places when it
// is offered. Everything about a job is here as data (who offers it, what they say,
// what it needs, what it pays); the steps themselves are in missions.ts.
//
// The names are made up (Fofr, like Zipp and Hopla among the taxi apps). All the text
// is English here and Czech in cs.ts.

// What things pay, in Kč, and how long you get. A distance is as the crow flies; the
// way through the streets is taken to be 1.3 times that.
const STREETS = 1.3;
const RATES = {
  // A parcel: on foot, by bike or by car, so the time allows for a bike.
  courier: { base: 90, perKm: 220, bonus: 0.5, speed: 3.5, slack: 60 },
  // Prague's regulated street-taxi fare (the same as a street taxi charges you), and a tip for a quick ride.
  taxi: { base: 60, perKm: 36, tip: 80, speed: 6, slack: 45 },
  ambulance: { base: 250, perKm: 120, bonus: 0.5, speed: 7, slack: 40 },
  tram: { stops: 5, perStop: 60, perHead: 6, limit: 150 },
  fire: { base: 400, bonus: 300, speed: 6, slack: 40 },
};

const tens = (n: number) => Math.round(n / 10) * 10;
// Seconds to get `d` m through the streets at `speed` m/s, with `slack` on top.
const allow = (d: number, speed: number, slack: number) => Math.round(slack + (d * STREETS) / speed);

export const JOBS: MissionDef[] = [
  {
    id: 'courier',
    title: 'Courier run',
    from: { who: 'courier', name: 'Fofr dispatch' },
    offer: 'A parcel is waiting at {from}. It has to be at {to} within {min} min.',
    brief: [
      'New here? Doesn’t matter. Fofr delivers anything, anywhere, and nobody asks how.',
      'Pick the parcel up at {from} and get it to {to}. On foot, by bike, by car: your business. Late is ours.',
    ],
    faction: 'couriers', rep: 4,
    unprompted: 420,
    plan: (w, pick) => {
      const r = RATES.courier, me = w.me();
      const a = pick.spot(me, 120, 500), b = a && pick.spot(a, 350, 1200, [a.name]);
      if (!a || !b) return null;
      const d = apart(a, b), limit = allow(d, r.speed, r.slack), pay = tens(r.base + (d * STREETS / 1000) * r.perKm);
      return {
        vars: { from: a.name, to: b.name, min: Math.ceil(limit / 60) }, pay, bonus: tens(pay * r.bonus),
        steps: [
          goTo(a, { goal: ['Pick up the parcel at {name}', { name: a.name }], limit: allow(apart(me, a), r.speed, 90), carry: '#f2a51a' }),
          goTo(b, { goal: ['Bring the parcel to {name}', { name: b.name }], limit, carry: null }),
        ],
      };
    },
  },
  {
    id: 'taxi',
    title: 'Taxi fare',
    from: { who: 'driver', name: 'Taxi dispatch' },
    offer: 'Someone at {from} wants a ride to {to}.',
    brief: [
      'So you’ve got one of our cars. Fine. Then you drive for us.',
      'Pick the fare up at {from} and take them to {to}. What the meter says is yours. Most of it.',
    ],
    needs: 'taxi',
    faction: 'taxis', rep: 4,
    again: true,
    plan: (w, pick) => {
      const r = RATES.taxi, me = w.me();
      const a = pick.spot(me, 120, 450), b = a && pick.spot(a, 400, 1500, [a.name]);
      if (!a || !b) return null;
      const d = apart(a, b);
      return {
        vars: { from: a.name, to: b.name }, pay: tens(r.base + (d * STREETS / 1000) * r.perKm), bonus: r.tip,
        steps: [
          pickUp(a, { goal: ['Pick up your fare at {name}', { name: a.name }], limit: allow(apart(me, a), r.speed, 60) }),
          dropOff(b, { goal: ['Drive your fare to {name}', { name: b.name }], limit: allow(d, r.speed, r.slack) }),
        ],
      };
    },
  },
  {
    id: 'ambulance',
    title: 'Patient run',
    from: { who: 'paramedic-f', name: 'Ambulance control' },
    offer: 'A patient is waiting at {from} and has to get to {to}.',
    brief: [
      'I won’t ask how you came by that ambulance. I have a patient and no crew.',
      'Pick them up at {from} and get them to {to}. Gently, if you can.',
    ],
    needs: 'ambulance',
    again: true,
    plan: (w, pick) => {
      const r = RATES.ambulance, me = w.me();
      const a = pick.spot(me, 150, 600);
      const b = a && (pick.nearest(a, w.hospitals().filter((h) => apart(h, a) > 150)) ?? pick.spot(a, 400, 1500, [a.name]));
      if (!a || !b) return null;
      const d = apart(a, b), pay = tens(r.base + (d * STREETS / 1000) * r.perKm);
      return {
        vars: { from: a.name, to: b.name }, pay, bonus: tens(pay * r.bonus),
        steps: [
          pickUp(a, { goal: ['Pick up the patient at {name}', { name: a.name }], limit: allow(apart(me, a), r.speed, 60) }),
          dropOff(b, { goal: ['Take the patient to {name}', { name: b.name }], limit: allow(d, r.speed, r.slack), r: 30 }),
        ],
      };
    },
  },
  {
    id: 'tram',
    title: 'Tram shift',
    from: { who: 'conductor', name: 'Tram control' },
    offer: 'Since you’re in the cab anyway: serve the next {n} stops. Stop at each one and open the doors.',
    brief: [
      'That tram has passengers and a timetable, whoever is driving it.',
      'Stop at every stop, open the doors, wait for people to get on and off. {n} stops and we’ll call it a shift.',
    ],
    needs: 'tram',
    again: true,
    plan: (w) => {
      const r = RATES.tram;
      if (!w.tram()) return null;
      return { vars: { n: r.stops }, pay: 0, bonus: 0, steps: [serve(r.stops, { perStop: r.perStop, perHead: r.perHead, limit: r.limit })] };
    },
  },
  {
    id: 'fire',
    title: 'Fire call',
    from: { who: 'foreman', name: 'Fire control' },
    offer: 'A car is on fire near {at}. Get there and put it out before it blows up.',
    brief: [
      'You’ve got our engine, and every other one is out. So it’s you.',
      'A car is burning near {at}. Drive there and put it out with the water cannon before it goes up.',
    ],
    needs: 'fire',
    again: true,
    plan: (w, pick) => {
      const r = RATES.fire, me = w.me();
      const at = pick.spot(me, 300, 800);
      if (!at) return null;
      return {
        vars: { at: at.name }, pay: r.base, bonus: r.bonus,
        steps: [putOut(at, {
          goal: ['Drive to the fire near {name}', { name: at.name }], near: ['Put the fire out with the water cannon'],
          limit: allow(apart(me, at), r.speed, r.slack),
        })],
      };
    },
  },
];
