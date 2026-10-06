import type { Contact } from './missions.ts';

// The factions: who they are, where they're at home and whom they can't stand, as data.
// Doing a faction's job raises your name with it and lowers it with its rivals. The
// names are made up and the tone is satire of Prague life; another set of factions is
// another list here.
//
// Built so far: your standing with each (saved with the game), and whose part of town
// you're in. Not built: their people and cars in the streets, hostile members, turf
// that changes hands (plans/004-missions-and-factions.md).

export interface Faction {
  id: string;
  name: string;
  colour: string;
  boss: Contact;
  contacts: string[]; // portrait ids (public/portraits/cast.json)
  home: string[]; // parts of town, as districts.json names them
  rivals: string[];
}

export const FACTIONS: Faction[] = [
  {
    id: 'taxis', name: 'The Rank', colour: '#ffd23a',
    boss: { who: 'boss', name: 'Mr Kadlec' }, contacts: ['driver'],
    home: ['Staré Město', 'Josefov'], rivals: ['couriers'],
  },
  {
    id: 'couriers', name: 'Fofr', colour: '#f2a51a',
    boss: { who: 'hacker', name: 'The Fofr app' }, contacts: ['courier', 'student'],
    home: ['Karlín', 'Holešovice'], rivals: ['taxis'],
  },
  {
    id: 'pubs', name: 'The Regulars', colour: '#b5482f',
    boss: { who: 'barmaid', name: 'Jarka' }, contacts: ['punk', 'rocker', 'bouncer', 'tattooed'],
    home: ['Žižkov'], rivals: [],
  },
];

export const MIN = -100, MAX = 100;
// Rivals lose this share of what a faction gains.
const SPITE = 0.5;

// How you stand with a faction, in words.
export const LEVELS: [number, string][] = [[-100, 'hated'], [-40, 'disliked'], [-10, 'unknown'], [10, 'known'], [40, 'trusted'], [75, 'one of them']];
export const level = (n: number) => LEVELS.filter(([from]) => n >= from).pop()![1];

export class Standing {
  rep: Record<string, number> = {};

  constructor(public factions: Faction[] = FACTIONS) {}

  of(id: string) { return this.rep[id] ?? 0; }

  private set(id: string, n: number) { this.rep[id] = Math.max(MIN, Math.min(MAX, Math.round(n))); }

  // Your name with a faction goes up (or down), and the other way with its rivals.
  add(id: string, n: number) {
    const f = this.factions.find((k) => k.id === id);
    if (!f || !n) return;
    this.set(id, this.of(id) + n);
    for (const r of f.rivals) this.set(r, this.of(r) - n * SPITE);
  }

  // Whose part of town this is, if anybody's.
  owner(district: string | null | undefined) {
    return district ? this.factions.find((f) => f.home.includes(district)) ?? null : null;
  }

  // For a saved game: only the factions there are now, within range.
  get saved() { return { ...this.rep }; }
  set saved(rep: Record<string, number>) {
    this.rep = {};
    for (const f of this.factions) if (typeof rep[f.id] === 'number' && Number.isFinite(rep[f.id])) this.set(f.id, rep[f.id]);
  }
}
