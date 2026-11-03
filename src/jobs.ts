import { apart, bringCar, dropOff, goTo, lose, pass, pickUp, putOut, serve, takeCar, wreck } from './missions.ts';
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
  tram: { stops: 5, perStop: 60, perHead: 6, limit: 240 },
  fire: { base: 400, bonus: 300, speed: 6, slack: 40 },
  // A car taken from where it's parked to a yard: the more of it arrives, the more it pays.
  fetch: { base: 350, perKm: 160, bonus: 0.4, speed: 6, slack: 60 },
  // A car someone wants burnt out: a flat fee and a bit for being quick.
  wreck: { base: 600, bonus: 250, speed: 5, slack: 150 },
  // Driving somebody away from the police: more with more stars.
  getaway: { base: 300, perStar: 250, stars: 2, bonus: 200, speed: 6, slack: 60 },
  // Three sights and back where they started: a tourist pays a fixed price.
  tour: { base: 500, perSight: 150, tip: 200, sights: 3, speed: 5, slack: 180 },
};

// Sights a tourist wants to drive past, [name, lon, lat], each from a street a car can
// use (the Castle and the Old Town Square from the nearest drivable street).
export const SIGHTS: [string, number, number][] = [
  ['Pražský hrad', 14.4012, 50.0922],
  ['Karlův most', 14.4136, 50.0863],
  ['Staroměstské náměstí', 14.4199, 50.0882],
  ['Národní muzeum', 14.4307, 50.0790],
  ['Tančící dům', 14.4141, 50.0755],
  ['Národní divadlo', 14.4134, 50.0810],
  ['Rudolfinum', 14.4155, 50.0899],
  ['Obecní dům', 14.4280, 50.0875],
  ['Malostranské náměstí', 14.4034, 50.0880],
  ['Vyšehrad', 14.4178, 50.0644],
  ['Žižkovská věž', 14.4513, 50.0809],
  ['Strahovský klášter', 14.3893, 50.0861],
  ['Výstaviště', 14.4302, 50.1062],
];

const tens = (n: number) => Math.round(n / 10) * 10;
// Seconds to get `d` m through the streets at `speed` m/s, with `slack` on top.
const allow = (d: number, speed: number, slack: number) => Math.round(slack + (d * STREETS) / speed);

// The nearest-first round from `from` through `n` of `among`, each at least 250 m from
// the last; fewer when there aren't that many.
function round(from: { x: number; y: number }, among: { name: string; x: number; y: number }[], n: number, reach: number) {
  const out: typeof among = [];
  let at = from;
  const left = among.filter((s) => apart(s, from) < reach && apart(s, from) > 150);
  while (out.length < n) {
    const next = left.filter((s) => !out.includes(s) && apart(s, at) > 250).sort((a, b) => apart(a, at) - apart(b, at))[0];
    if (!next) break;
    out.push(next);
    at = next;
  }
  return out;
}

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
  {
    id: 'tour',
    title: 'Sightseeing tour',
    from: { who: 'driver', name: 'Taxi dispatch' },
    offer: 'A tourist at {from} wants to see {a}, {b} and {c} from a car, and be brought back.',
    brief: [
      'Tourists. They pay in euros and they want to see everything without getting out.',
      'Pick them up at {from}, drive past {a}, {b} and {c}, and bring them back. Slowly past the sights, if you can.',
    ],
    faction: 'taxis', rep: 3,
    plan: (w, pick) => {
      const r = RATES.tour, me = w.me();
      const a = pick.spot(me, 100, 450);
      const sights = a ? round(a, w.sights(), r.sights, 2600) : [];
      if (!a || sights.length < r.sights) return null;
      let d = 0, at: { x: number; y: number } = a;
      for (const s of [...sights, a]) { d += apart(at, s); at = s; }
      return {
        vars: { from: a.name, a: sights[0].name, b: sights[1].name, c: sights[2].name },
        pay: r.base + r.perSight * sights.length, bonus: r.tip,
        steps: [
          pickUp(a, { goal: ['Pick up the tourist at {name}', { name: a.name }], limit: allow(apart(me, a), r.speed, 90) }),
          ...sights.map((s, i) => pass(s, { goal: ['Drive past {name} ({n} of {of})', { name: s.name, n: i + 1, of: sights.length }] })),
          dropOff(a, { goal: ['Bring the tourist back to {name}', { name: a.name }], limit: allow(d, r.speed, r.slack) }),
        ],
      };
    },
  },
  {
    id: 'fetch',
    title: 'Bring a car',
    from: { who: 'mechanic', name: 'Jarka’s cousin Láďa' },
    offer: 'There’s a car near {from} that Láďa wants in his yard at {to}. In one piece, if possible.',
    brief: [
      'Jarka says you drive. Good. I need a car, and the owner doesn’t need to know yet.',
      'It’s parked near {from}. Bring it to my yard at {to}. Every dent comes off your pay.',
    ],
    faction: 'pubs', rep: 4,
    plan: (w, pick) => {
      const r = RATES.fetch, me = w.me();
      const a = pick.spot(me, 150, 600), b = a && pick.spot(a, 500, 1600, [a.name]);
      if (!a || !b) return null;
      const d = apart(a, b), pay = tens(r.base + (d * STREETS / 1000) * r.perKm);
      return {
        vars: { from: a.name, to: b.name }, pay, bonus: tens(pay * r.bonus),
        steps: [
          takeCar(a, { goal: ['Find the car near {name}', { name: a.name }], near: ['Get into the marked car'], type: 'sedan', limit: allow(apart(me, a), 3.5, 120) }),
          bringCar(b, { goal: ['Bring the car to the yard at {name}', { name: b.name }], limit: allow(d, r.speed, r.slack) }),
        ],
      };
    },
  },
  {
    id: 'wreck',
    title: 'Settle a debt',
    from: { who: 'barmaid', name: 'Jarka' },
    offer: 'Someone who owes Jarka parks near {at}. She wants the car on fire. Not the owner: the car.',
    brief: [
      'He’s owed me for the tab since spring. Talking didn’t help.',
      'His car stands near {at}. Ram it till it catches fire, whatever it takes: I want to hear it’s burning. And nobody gets hurt, understood?',
    ],
    faction: 'pubs', rep: 5, minRep: 4,
    plan: (w, pick) => {
      const r = RATES.wreck, me = w.me();
      const at = pick.spot(me, 250, 900);
      if (!at) return null;
      return {
        vars: { at: at.name }, pay: r.base, bonus: r.bonus,
        steps: [wreck(at, {
          goal: ['Find the debtor’s car near {name}', { name: at.name }], near: ['Wreck the marked car: ram it until it catches fire'],
          type: 'suv', limit: allow(apart(me, at), r.speed, r.slack),
        })],
      };
    },
  },
  {
    id: 'getaway',
    title: 'Getaway',
    from: { who: 'bouncer', name: 'Venca from the Regulars' },
    offer: 'Venca needs picking up at {from}, with the police right behind him. Lose them, then drop him at {to}.',
    brief: [
      'Bit of a misunderstanding at the bar. The police didn’t see the funny side.',
      'Pick me up at {from}. They’ll be on us straight away: lose them, then drop me at {to}. Not before.',
    ],
    faction: 'pubs', rep: 8, minRep: 8,
    plan: (w, pick) => {
      const r = RATES.getaway, me = w.me();
      const a = pick.spot(me, 150, 500), b = a && pick.spot(a, 600, 2000, [a.name]);
      if (!a || !b) return null;
      return {
        vars: { from: a.name, to: b.name }, pay: r.base + r.perStar * r.stars, bonus: r.bonus,
        steps: [
          pickUp(a, { goal: ['Pick up Venca at {name}', { name: a.name }], limit: allow(apart(me, a), r.speed, 60) }),
          lose(r.stars, { goal: ['Lose the police'] }),
          dropOff(b, { goal: ['Drop Venca at {name}', { name: b.name }], limit: allow(apart(a, b), r.speed, r.slack) }),
        ],
      };
    },
  },
];
