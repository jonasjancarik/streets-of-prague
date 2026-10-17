#!/usr/bin/env node
// Wallet expiry and real metro ticket-button dispatch, without a map or renderer.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import * as THREE from 'three';

globalThis.location = { search: '?lang=en' };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.document = { querySelectorAll: () => [], documentElement: {} };
globalThis.Element = class {
  constructor(act) { this.dataset = { act }; }
  closest() { return this; }
};
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false } });
try {
  const { Wallet, PidRide, TICKETS, GRACE } = await server.ssrLoadModule('/src/money.ts');
  const { Clock } = await server.ssrLoadModule('/src/clock.ts');
  const { Metro } = await server.ssrLoadModule('/src/metro.ts');
  const WEEK = 7 * 86400;
  const wallet = money => new Wallet(new URLSearchParams(`money=${money}`));

  const ordinary = wallet(10000), clock = new Clock(new URLSearchParams('day=mon&time=12:00'));
  const boughtAt = clock.t;
  assert.ok(ordinary.buyTicket(clock.t));
  for (let minute = 1; minute <= WEEK / 60 + 1; minute++) {
    clock.advance(60);
    const left = ordinary.ticketLeft(clock.t);
    if (minute < TICKETS[1].minutes) assert.ok(left > 0);
    else assert.equal(left, 0, 'expired ticket stays invalid throughout the next weekly clock cycle');
  }
  assert.equal(ordinary.held, null, 'expiry discards the saved ticket too');
  assert.equal(ordinary.balance, 10000 - TICKETS[1].price, 'expiry does not charge again');
  assert.ok(clock.t > boughtAt);

  for (const kind of TICKETS) {
    const across = wallet(10000), sunday = new Clock(new URLSearchParams('day=sun&time=23:50'));
    assert.ok(across.buyTicket(sunday.t, kind));
    sunday.advance(20 * 60);
    assert.equal(across.ticketLeft(sunday.t), (kind.minutes - 20) * 60, 'valid ticket survives Sunday/Monday rollover');
    sunday.advance((kind.minutes - 20) * 60);
    assert.equal(across.ticketLeft(sunday.t), 0, 'each ticket expires at its exact duration');
    assert.equal(across.held, null);
  }
  const restored = wallet(1000);
  restored.held = JSON.parse(JSON.stringify({ from: 3600, minutes: 30 }));
  assert.equal(restored.hasTicket(7200), false, 'an expired legacy saved ticket is rejected on restoration');
  assert.equal(restored.held, null);
  assert.equal(restored.hasTicket(3600), false, 'returning the weekly clock to its purchase time cannot revive it');
  restored.held = { from: WEEK - 600, minutes: 30 };
  assert.equal(restored.ticketLeft(600), 600, 'legacy active ticket restores across the weekly rollover');
  const snapshot = restored.held;
  snapshot.minutes = 999;
  assert.equal(restored.held.minutes, 30, 'save snapshots do not mutate the wallet');

  const short = wallet(35), ride = new PidRide(short);
  ride.board(0);
  assert.equal(ride.state, 'grace');
  assert.equal(ride.buy(0, TICKETS[0]), false);
  assert.equal(short.balance, 35, 'failed purchase leaves the balance intact');
  assert.equal(short.held, null);
  ride.update(GRACE);
  assert.equal(ride.state, 'dodging');
  short.balance = TICKETS[0].price;
  assert.equal(ride.buy(100, TICKETS[0]), true);
  assert.equal(short.balance, 0, 'exact funds buy a ticket');
  assert.equal(ride.state, null);
  assert.equal(ride.buy(100, TICKETS[0]), false, 'repeated purchase on a paid ride cannot charge twice');
  assert.equal(short.balance, 0);

  const screen = funds => {
    const paid = wallet(funds), listeners = {};
    const panel = { addEventListener: (type, listener) => { listeners[type] = listener; }, querySelector: () => null, classList: { add() {} } };
    const at = new Clock(new URLSearchParams('day=mon&time=12:00'));
    const metro = new Metro({ lines: [] }, new THREE.Scene(), panel, {
      clock: at, fares: { valid: () => paid.hasTicket(at.t), afford: kind => paid.has(kind.price), buy: kind => paid.buyTicket(at.t, kind) },
      inMap: () => true, ready: () => true, terrain: () => 0, standAt: (x, y) => [x, y], onArrive() {}, onStation() {},
    });
    metro.phase = 'ticket';
    return { metro, paid, at, point(act) { listeners.pointerdown({ target: new Element(act), preventDefault() {}, stopPropagation() {} }); } };
  };
  for (const [i, kind] of TICKETS.entries()) {
    const pointer = screen(10000), keyboard = screen(10000);
    pointer.point(`buy:${i}`);
    keyboard.metro.key(`Digit${i + 1}`);
    assert.equal(pointer.metro.phase, 'pick', `ticket button ${i + 1} continues to station selection`);
    assert.equal(pointer.paid.balance, 10000 - kind.price);
    assert.equal(pointer.paid.ticketLeft(pointer.at.t), kind.minutes * 60);
    assert.deepEqual(pointer.paid.held, keyboard.paid.held, 'pointer and keyboard purchase the same ticket');
    pointer.point(`buy:${i}`);
    assert.equal(pointer.paid.balance, 10000 - kind.price, 'old ticket button cannot charge again after the screen changes');
    const poor = screen(kind.price - 1);
    poor.point(`buy:${i}`);
    assert.equal(poor.metro.phase, 'ticket');
    assert.equal(poor.paid.balance, kind.price - 1);
    assert.equal(poor.paid.held, null);
  }
  const noTicket = screen(0);
  noTicket.point('nobuy');
  assert.equal(noTicket.metro.phase, 'pick');
  assert.equal(noTicket.metro.dodging, true, 'declining a ticket still risks inspection');
  assert.equal(noTicket.paid.balance, 0);

  const interchange = (funds, running) => {
    const fixture = screen(funds), { metro } = fixture;
    const lines = running.map((open, i) => ({
      ref: String(i), stations: [{ name: 'Origin', t: 0 }, { name: `Destination ${i}`, t: 300 }],
      perHour: { weekday: Array(24).fill(open ? 8 : 0) },
    }));
    const from = { name: 'Origin', lines: lines.map(line => ({ line, i: 0 })) };
    metro.lines = lines;
    for (const line of lines) metro.stations.set(line.stations[1].name, { name: line.stations[1].name, onMap: true, lines: [{ line, i: 1 }] });
    metro.render = () => {}; // only fare/route state, without drawing station menus
    metro.open(from);
    return fixture;
  };
  for (const running of [[true, true], [true, false], [false, true]]) {
    for (const funds of [0, 1000]) {
      const fixture = interchange(funds, running), { metro, paid } = fixture;
      assert.equal(metro.phase, 'ticket', 'any operating line requires the normal ticket decision');
      assert.equal(metro.note, '', 'a running interchange does not claim the whole metro is closed');
      fixture.point('buy:0');
      if (funds) {
        assert.equal(metro.phase, 'pick');
        assert.equal(paid.balance, funds - TICKETS[0].price);
        assert.equal(metro.dodging, false);
      } else {
        assert.equal(metro.phase, 'ticket', 'an unaffordable ticket keeps the fare screen open');
        fixture.point('nobuy');
        assert.equal(metro.dodging, true, 'declining a ticket at a partly running interchange risks inspection');
      }
      metro.go(`Destination ${running.indexOf(true)}`);
      assert.equal(metro.phase, 'ride', 'an operating line remains usable');
    }
  }
  const closed = interchange(1000, [false, false]);
  assert.equal(closed.metro.phase, 'pick', 'all closed lines show the timetable note before charging');
  assert.ok(closed.metro.note);
  closed.metro.go('Destination 0');
  assert.equal(closed.metro.phase, 'pick', 'a closed route cannot depart');
  assert.equal(closed.paid.balance, 1000);
  assert.equal(closed.paid.held, null);
  console.log('Money: week rollover and permanent expiry, legacy restoration, ticket payments, all metro pointer choices, and partly/fully closed interchanges passed.');
} finally { await server.close(); }
