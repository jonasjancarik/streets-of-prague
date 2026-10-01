import { getLang } from './i18n.ts';

// The player's money: it starts at 10 000 Kč and only goes on taxis, PID tickets and
// shared bikes. It never goes below zero (save.ts keeps it between visits).

export const START_MONEY = 10000;
// PID's time tickets for an adult in Prague from 1 January 2026, at the app's price
// (valid from the moment you buy one, on trams, the metro and the Petřín funicular).
export interface TicketKind { minutes: number; price: number }
export const TICKETS: TicketKind[] = [{ minutes: 30, price: 36 }, { minutes: 90, price: 46 }, { minutes: 1440, price: 140 }, { minutes: 4320, price: 340 }];
export const TICKET = TICKETS[1]; // the one you get when you don't pick: 90 minutes
// How long a ticket is valid, as short text: 30 min, 90 min, 24 h.
export const validity = (minutes: number) => (minutes < 180 ? `${minutes} min` : `${Math.round(minutes / 60)} h`);
export const GRACE = 10; // s (real time) after boarding a tram to buy a ticket
export const FINE = 1200; // Kč, ticket inspection
export const FINE_LATE = 1500; // Kč, when the inspector had to phone the police
export const CHECK_STOP = 0.05; // chance of an inspection at each tram or funicular stop you ride to without a ticket
export const CHECK_METRO = 0.15; // chance of an inspection at the end of a metro ride without a ticket
export const DECIDE = 5; // s to pay or run when inspected

const WEEK = 7 * 86400;

// (One formatter a language: making one is slow, and the HUD shows money every frame.)
const formats = new Map<string, Intl.NumberFormat>();
export function kc(n: number) {
  const locale = getLang() === 'cs' ? 'cs-CZ' : 'en-GB';
  let f = formats.get(locale);
  if (!f) formats.set(locale, (f = new Intl.NumberFormat(locale)));
  return `${f.format(Math.round(n))} Kč`;
}

export class Wallet {
  balance: number;
  paid = 0; // the last payment, shown for a moment
  paidT = 0; // seconds left of showing it
  private ticket: { from: number; minutes: number } | null = null;
  // Told what money went on, each time some does (main.ts counts it for the statistics).
  onSpend: ((what: string, amount: number) => void) | null = null;

  constructor(params: URLSearchParams) {
    const n = Number(params.get('money'));
    this.balance = params.has('money') && params.get('money') !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : START_MONEY;
  }

  has(n: number) { return this.balance >= n; }

  // Takes up to n, and returns what was actually taken. `what` names what it went on.
  take(n: number, what: string) {
    const got = Math.max(0, Math.min(this.balance, Math.round(n)));
    this.balance -= got;
    if (got > 0) { this.paid = got; this.paidT = 3; this.onSpend?.(what, got); }
    return got;
  }

  // Seconds left on the ticket you hold (0 if none).
  ticketLeft(now: number) {
    if (!this.ticket) return 0;
    const used = (((now - this.ticket.from) % WEEK) + WEEK) % WEEK;
    return Math.max(0, this.ticket.minutes * 60 - used);
  }

  hasTicket(now: number) { return this.ticketLeft(now) > 0; }

  // The ticket you hold, as data for a saved game.
  get held() { return this.ticket && { ...this.ticket }; }
  set held(t: { from: number; minutes: number } | null) { this.ticket = t && { ...t }; }

  buyTicket(now: number, kind: TicketKind = TICKET) {
    if (!this.has(kind.price)) return false;
    this.take(kind.price, 'ticket');
    this.ticket = { from: now, minutes: kind.minutes };
    return true;
  }

  update(dt: number) { if (this.paidT > 0) this.paidT = Math.max(0, this.paidT - dt); }
}

export type PidState = 'ticket' | 'grace' | 'dodging' | 'checked' | null;

// One ride on PID transport (a tram or funicular; the metro has its own ticket screen
// and only reports `dodging`): whether you have a ticket, are still allowed to buy one,
// or are riding without.
export class PidRide {
  state: PidState = null;
  left = 0; // real seconds of the grace period
  constructor(private wallet: Wallet) {}

  get on() { return this.state !== null; }

  board(now: number) {
    if (this.wallet.hasTicket(now)) { this.state = null; return; }
    this.state = 'grace';
    this.left = GRACE;
  }

  buy(now: number, kind: TicketKind = TICKET) {
    if (this.state !== 'grace' && this.state !== 'dodging') return false;
    if (!this.wallet.buyTicket(now, kind)) return false;
    this.state = null;
    return true;
  }

  update(realDt: number) {
    if (this.state !== 'grace') return;
    this.left -= realDt;
    if (this.left <= 0) this.state = 'dodging';
  }

  // At a stop: whether there's an inspection (roll is a random number in 0..1).
  check(chance: number, roll: number) {
    if (this.state !== 'grace' && this.state !== 'dodging') return false;
    if (roll >= chance) return false;
    this.state = 'checked';
    return true;
  }

  leave() { this.state = null; }
}
