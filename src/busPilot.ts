import type { BusLine, BusRun } from './buses.ts';
import type { Point2 } from './map/geo.ts';
import { Polyline } from './network.ts';

type Visit = [distance: number, name: string, platform: string, arrival: number, departure: number];
export interface BusPilotData {
  shapes: Record<string, Point2[]>;
  trips: [id: string, shape: string, destination: string, days: string[], visits: Visit[]][];
}
interface Trip {
  id: string;
  line: BusLine;
  days: string[];
  visits: Visit[];
}
interface TripState { run?: BusRun; delay: number; along: number; finished?: boolean }

const DAY = 86400;
const WEEK = 7 * DAY;
const kind = (day: number) => (day + 7) % 7 === 5 ? 'saturday' : (day + 7) % 7 === 6 ? 'sunday' : 'weekday';

// A trip has a position on its shape even when there is no vehicle on the road.
export class BusPilot {
  readonly trips: Trip[];
  private states = new Map<string, TripState>();
  private last = -Infinity;

  constructor(data?: BusPilotData | null) {
    const paths = new Map(Object.entries(data?.shapes ?? {}).map(([id, pts]) => [id, new Polyline(pts)]));
    this.trips = (data?.trips ?? []).flatMap(([id, shape, to, days, visits]) => {
      const path = paths.get(shape);
      return path ? [{ id, days, visits, line: { ref: '227', to, path, stops: visits.map(([at, name, stop]) => [at, name, stop]) } }] : [];
    });
  }

  update(now: number, active: ReadonlySet<BusRun>, near: (x: number, y: number) => boolean, waitingPlatform: string | undefined,
    spawn: (line: BusLine, along: number, max: number, schedule: NonNullable<BusRun['schedule']>) => BusRun | undefined) {
    // A seek or the weekly clock rollover starts a new timetable lookup. Active
    // vehicles remain in the traffic graph and reserve their existing trip IDs.
    if (Math.abs(now - this.last) > 3) {
      this.states.clear();
      for (const run of active) if (run.schedule) {
        if (this.last >= WEEK - 3 && this.last < WEEK && now < 3) run.schedule.start -= WEEK;
        else run.schedule.followClock = false;
        this.states.set(run.schedule.key, { run, delay: 0, along: run.along });
      }
    }
    this.last = now;
    const day = Math.floor(now / DAY);
    for (const [key, state] of this.states) {
      const run = state.run;
      if (!run || active.has(run)) continue;
      if (!run.schedule?.followClock) {
        this.states.delete(key);
        continue;
      }
      state.along = run.along;
      state.finished = run.stop >= run.line.stops.length;
      const schedule = run.schedule;
      // Time at the last observed position, interpolated between its surrounding calls.
      const index = Math.min(run.stop, schedule.arrivals.length - 1);
      const prev = Math.max(0, index - 1);
      const from = run.line.stops[prev][0], to = run.line.stops[index][0];
      const fraction = to > from ? Math.max(0, Math.min(1, (run.along - from) / (to - from))) : 0;
      const planned = schedule.departures[prev] + fraction * (schedule.arrivals[index] - schedule.departures[prev]);
      state.delay = Math.max(state.delay, now - schedule.start - planned);
      state.run = undefined;
    }

    for (let service = day - 1; service <= day; service++) {
      const start = service * DAY;
      for (const trip of this.trips) {
        if (!trip.days.includes(kind(service))) continue;
        const key = `${(service + 7) % 7}:${trip.id}`;
        const state = this.states.get(key);
        if (state?.run || state?.finished) continue;
        const relative = now - start - (state?.delay ?? 0);
        const visits = trip.visits;
        if (relative < visits[0][4] || relative > visits.at(-1)![4]) continue;
        const pickup = waitingPlatform ? visits.findIndex(([at, , platform, arrival], i) =>
          i > 0 && platform === waitingPlatform && at > (state?.along ?? -Infinity) + 18
          && relative >= arrival - 45 && relative <= arrival + 45) : -1;
        const next = pickup >= 0 ? pickup : visits.findIndex((visit, i) => i > 0 && visit[4] >= relative);
        if (next < 1) continue;
        const [from, , , , departure] = visits[next - 1];
        const [to, , , arrival] = visits[next];
        if (to - from < 35) continue;
        const fraction = Math.max(0, Math.min(1, (relative - departure) / Math.max(1, arrival - departure)));
        const max = to - 18;
        const nominal = Math.min(max - 12, from + (to - from) * fraction);
        const along = Math.max(state?.along ?? 0, nominal);
        if (along >= max) continue;
        const point = trip.line.path.at(along);
        if (!near(point.x, point.y)) continue;
        const schedule = { key, trip: trip.id, start, followClock: true,
          arrivals: visits.map((v) => v[3]), departures: visits.map((v) => v[4]) };
        const upstream = Math.max(state?.along ?? 0, from, max - 150);
        const run = spawn(trip.line, along, max, schedule)
          ?? (pickup >= 0 && upstream < along ? spawn(trip.line, upstream, Math.min(max, along), schedule) : undefined);
        if (run) this.states.set(key, { run, delay: state?.delay ?? 0, along: run.along });
      }
    }
  }
}
