// The game's clock: the day of the week and the time of day, which set how often the
// trams run (their timetables, in lines.json). It starts at the time in Prague now,
// or at ?time=HH:MM and ?day=mon…sun (?night alone starts at half past one), runs at
// real speed, and faster while you fast-forward.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEK = 7 * 86400;

// The day (0 = Monday) and the seconds since midnight in Prague right now.
function pragueNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Prague', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: DAYS.indexOf(parts.weekday), sec: +parts.hour * 3600 + +parts.minute * 60 + +parts.second };
}

export class Clock {
  t: number;

  constructor(params: URLSearchParams) {
    let { day, sec } = pragueNow();
    if (params.has('night') && !params.has('time')) sec = 1.5 * 3600;
    const t = (params.get('time') || '').match(/^(\d{1,2})[:.](\d{2})$/);
    if (t) sec = (+t[1] % 24) * 3600 + +t[2] * 60;
    const d = DAYS.findIndex((x) => x.toLowerCase() === (params.get('day') || '').slice(0, 3).toLowerCase());
    if (d >= 0) day = d;
    this.t = day * 86400 + sec;
  }

  // Seconds into today in Prague, as it reads now.
  static nowLabel() {
    const s = pragueNow().sec;
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
  }

  // The time of day set (the start screen), on the same day.
  setTime(sec: number) { this.t = this.day * 86400 + sec; }

  advance(dt: number) { this.t = (((this.t + dt) % WEEK) + WEEK) % WEEK; }
  get day() { return Math.floor(this.t / 86400); }
  get hour() { return Math.floor((this.t % 86400) / 3600); }
  // Which timetable applies: weekday, saturday or sunday.
  get kind() { return this.day === 5 ? 'saturday' : this.day === 6 ? 'sunday' : 'weekday'; }
  // Night for the parked cars: from 10 in the evening to 6 in the morning.
  get night() { return this.hour >= 22 || this.hour < 6; }
  label() {
    const m = Math.floor((this.t % 3600) / 60);
    return `${DAYS[this.day]} ${String(this.hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
