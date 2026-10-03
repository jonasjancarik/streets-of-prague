// The game's date: a day of the year, which sets how far out the leaves are, where the
// sun stands (sky.ts) and which weather is likely (weather.ts). It starts at today's
// date in Prague, or at ?date=MM-DD or ?season=spring|summer|autumn|winter (a typical
// date of that season), is kept in a saved game, and stays: it doesn't pass with the
// clock, which runs through a week over and over.
//
// The year is read through a few values from 0 to 1 that change smoothly from day to
// day, so the start of October and the middle of November differ.

export type SeasonName = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: SeasonName[] = ['spring', 'summer', 'autumn', 'winter'];
// A typical day of each: 20 April, 15 July, 20 October, 15 January.
const TYPICAL: Record<SeasonName, number> = { spring: 110, summer: 196, autumn: 293, winter: 15 };

const BEFORE = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // days before each month
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (month: number, date: number) => BEFORE[month - 1] + date;

// The day of the year in Prague right now (1–365).
export function pragueToday() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  return Math.min(365, dayOf(+parts.month, +parts.day));
}

export const seasonOfDay = (day: number): SeasonName => day < 60 || day >= 335 ? 'winter' : day < 152 ? 'spring' : day < 244 ? 'summer' : 'autumn';
// The current season's start-screen button means today; the others are typical dates.
export const seasonStartDay = (name: SeasonName, today = pragueToday()) => name === seasonOfDay(today) ? today : TYPICAL[name];

// A date as the game takes it: a season's name, MM-DD, or a day of the year.
export function parseDay(text: string | number | null): number | null {
  if (text === null || text === '') return null;
  if (typeof text === 'string' && text in TYPICAL) return TYPICAL[text as SeasonName];
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(text));
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return Math.min(365, dayOf(+m[1], +m[2]));
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : null;
}

const ramp = (d: number, from: number, to: number) => {
  const t = Math.min(1, Math.max(0, (d - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

export class Season {
  day: number;

  constructor(params: URLSearchParams) {
    this.day = parseDay(params.get('date')) ?? parseDay(params.get('season')) ?? pragueToday();
  }

  set(day: number) { this.day = Math.min(365, Math.max(1, Math.round(day))); }

  get name(): SeasonName { return seasonOfDay(this.day); }

  // "10-02", as ?date= takes it.
  get date() {
    let m = 11;
    while (BEFORE[m] >= this.day) m--;
    return `${String(m + 1).padStart(2, '0')}-${String(this.day - BEFORE[m]).padStart(2, '0')}`;
  }

  // "2 Oct".
  label() {
    const [m, d] = this.date.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]}`;
  }

  // How far the broadleaf trees' leaves are out: none until late March, all by the
  // middle of May, falling from the middle of October to the end of November.
  get leaf() { return ramp(this.day, 85, 135) * (1 - ramp(this.day, 288, 330)); }
  // How far the leaves have turned: from the middle of September to early November.
  get turn() { return ramp(this.day, 258, 309); }
  // Fruit trees in flower: the second half of April and early May.
  get blossom() { return ramp(this.day, 103, 113) * (1 - ramp(this.day, 124, 136)); }
  // The light green of new leaves and spring grass: gone by July.
  get fresh() { return ramp(this.day, 80, 100) * (1 - ramp(this.day, 140, 190)); }
  // Parched grass: through July and August, gone by October.
  get dry() { return ramp(this.day, 182, 235) * (1 - ramp(this.day, 245, 275)); }
  // Winter's dull grass and silence: December to February, fading at both ends.
  get cold() { return Math.max(ramp(this.day, 305, 335), 1 - ramp(this.day, 59, 85)); }

  // How much of each season this day is, between the middles of the two nearest
  // (the weather's chances are blended by it).
  shares(): Record<SeasonName, number> {
    const mid: [SeasonName, number][] = [['winter', 15], ['spring', 106], ['summer', 197], ['autumn', 288], ['winter', 380]];
    const d = this.day < 15 ? this.day + 365 : this.day;
    const out = { spring: 0, summer: 0, autumn: 0, winter: 0 };
    for (let i = 0; i < 4; i++) {
      const [a, from] = mid[i], [b, to] = mid[i + 1];
      if (d >= from && d < to) { const t = (d - from) / (to - from); out[a] += 1 - t; out[b] += t; }
    }
    return out;
  }
}
