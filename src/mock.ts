// Built-in sample data so the server works with no NJ Transit account.
// Trains are generated around the current time, so the tools behave like the
// live ones. Station codes and lines here are a small, made-up-but-plausible
// sample; the live API is the source of truth.

import { formatNjtTime } from "./time.ts";
import type {
  CapacitySection,
  RailSource,
  ScheduleItem,
  Station,
  StationBoard,
  StationMessage,
  Stop,
  TrainStopList,
} from "./types.ts";

interface MockLine {
  name: string;
  abbr: string;
  code: string;
  color: string;
  baseId: number;
  headwayMin: number;
  stops: [code: string, name: string, minutesFromStart: number][];
}

const LINES: MockLine[] = [
  {
    name: "Northeast Corrdr",
    abbr: "NEC",
    code: "NE",
    color: "#F7505E",
    baseId: 3800,
    headwayMin: 20,
    stops: [
      ["NY", "New York Penn Station", 0],
      ["SE", "Secaucus Upper Lvl", 9],
      ["NP", "Newark Penn Station", 18],
      ["NA", "Newark Airport", 23],
      ["EZ", "Elizabeth", 28],
      ["RH", "Rahway", 37],
      ["MP", "Metropark", 43],
      ["ED", "Edison", 50],
      ["NB", "New Brunswick", 55],
      ["PJ", "Princeton Junction", 68],
      ["HL", "Hamilton", 76],
      ["TR", "Trenton", 82],
    ],
  },
  {
    name: "No Jersey Coast",
    abbr: "NJCL",
    code: "NC",
    color: "#00A4E4",
    baseId: 3200,
    headwayMin: 40,
    stops: [
      ["NY", "New York Penn Station", 0],
      ["SE", "Secaucus Upper Lvl", 9],
      ["NP", "Newark Penn Station", 18],
      ["NA", "Newark Airport", 23],
      ["EZ", "Elizabeth", 28],
      ["RH", "Rahway", 37],
      ["PE", "Perth Amboy", 47],
      ["AM", "Aberdeen-Matawan", 60],
      ["RB", "Red Bank", 70],
      ["LB", "Long Branch", 80],
    ],
  },
  {
    name: "Morristown Line",
    abbr: "M&E",
    code: "ME",
    color: "#00A94F",
    baseId: 6600,
    headwayMin: 30,
    stops: [
      ["NY", "New York Penn Station", 0],
      ["SE", "Secaucus Upper Lvl", 9],
      ["ND", "Newark Broad Street", 17],
      ["ST", "Summit", 35],
      ["MR", "Morristown", 50],
      ["DO", "Dover", 70],
    ],
  },
];

interface Trip {
  id: string;
  line: MockLine;
  outbound: boolean; // true = leaving New York
  stops: { code: string; name: string; at: number }[]; // scheduled epoch ms
  delayMin: number;
  cancelled: boolean;
  track: string;
  crowding: number; // percent
}

/** Small deterministic hash so the same train always gets the same delay. */
function hash(n: number): number {
  let x = (n ^ 0x5bd1e995) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0;
  x = Math.imul(x ^ (x >>> 12), 0x297a2d39) >>> 0;
  return (x ^ (x >>> 15)) >>> 0;
}

/**
 * Per-car crowding for a sample train: 8 cars (front 1-3, middle 4-5, back 6-8).
 * Crowding leans toward one end, like real trains near the station exits.
 */
function mockSections(trip: Trip): CapacitySection[] {
  const h = hash(Number(trip.id) * 31 + trip.stops[0].at / 60_000);
  const fullEnd = h % 2 === 0 ? 1 : 8; // the car nearest the busy end
  const spread = 20 + (h % 30);
  const groups: [string, number[]][] = [["Front", [1, 2, 3]], ["Middle", [4, 5]], ["Back", [6, 7, 8]]];
  return groups.map(([name, nums]) => {
    const cars = nums.map((n) => {
      const lean = spread * (1 - Math.abs(n - fullEnd) / 7) - spread / 2;
      const pct = Math.max(3, Math.min(100, Math.round(trip.crowding + lean + ((h >> n) % 7) - 3)));
      return { CAR_NO: String(7000 + ((h + n * 13) % 900)), CAR_POSITION: String(n), CAR_REST: n === 2 || n === 6 ? "Y" : "N", CUR_PERCENTAGE: String(pct) };
    });
    const avg = Math.round(cars.reduce((a, c) => a + Number(c.CUR_PERCENTAGE), 0) / cars.length);
    return { SECTION_POSITION: name, CUR_PERCENTAGE: String(avg), CARS: cars };
  });
}

export class MockSource implements RailSource {
  readonly mode = "mock" as const;
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private trips(): Trip[] {
    const now = this.now();
    const from = now - 2 * 3600_000;
    const to = now + 4 * 3600_000;
    const out: Trip[] = [];
    for (const line of LINES) {
      const head = line.headwayMin * 60_000;
      const total = line.stops[line.stops.length - 1][2] * 60_000;
      for (const outbound of [true, false]) {
        // Offset inbound trains so they don't mirror outbound ones exactly.
        const offset = outbound ? 0 : Math.floor(head / 2);
        let start = Math.floor((from - total - offset) / head) * head + offset;
        for (; start <= to; start += head) {
          const slot = Math.floor((start - offset) / head);
          const num = line.baseId + ((slot % 50) + 50) % 50 * 2 + (outbound ? 1 : 0);
          const ordered = outbound ? line.stops : [...line.stops].reverse();
          const stops = ordered.map(([code, name, m]) => ({
            code,
            name,
            at: start + (outbound ? m : line.stops[line.stops.length - 1][2] - m) * 60_000,
          }));
          if (stops[stops.length - 1].at < from || stops[0].at > to) continue;
          const h = hash(slot * 7 + line.baseId + (outbound ? 1 : 0));
          const r = h % 100;
          out.push({
            id: String(num),
            line,
            outbound,
            stops,
            cancelled: r < 4,
            delayMin: r < 4 ? 0 : r < 30 ? 2 + (h % 11) : 0,
            track: String(1 + (h % 12)),
            crowding: 15 + (h % 80),
          });
        }
      }
    }
    return out;
  }

  async stations(): Promise<Station[]> {
    const seen = new Map<string, string>();
    for (const line of LINES) for (const [code, name] of line.stops) seen.set(code, name);
    return [...seen].map(([STATION_2CHAR, STATIONNAME]) => ({ STATION_2CHAR, STATIONNAME }));
  }

  private stationName(code: string): string | undefined {
    for (const line of LINES) for (const [c, n] of line.stops) if (c === code) return n;
    return undefined;
  }

  private toStops(trip: Trip): Stop[] {
    const now = this.now();
    return trip.stops.map((s) => {
      const actual = s.at + trip.delayMin * 60_000;
      return {
        STATION_2CHAR: s.code,
        STATIONNAME: s.name,
        TIME: formatNjtTime(actual),
        DEP_TIME: formatNjtTime(actual),
        PICKUP: "",
        DROPOFF: "",
        DEPARTED: !trip.cancelled && actual < now ? "YES" : "NO",
        STOP_STATUS: trip.cancelled ? "Cancelled" : trip.delayMin > 0 ? "Late" : "OnTime",
        STOP_LINES: [{ LINE_CODE: trip.line.code, LINE_NAME: trip.line.name, LINE_COLOR: trip.line.color }],
      };
    });
  }

  private board(code: string, withStops: boolean, limit: number): StationBoard {
    const name = this.stationName(code);
    if (!name) throw new Error(`Unknown station code ${code}.`);
    const now = this.now();
    const items: { at: number; item: ScheduleItem }[] = [];
    for (const trip of this.trips()) {
      const idx = trip.stops.findIndex((s) => s.code === code);
      if (idx < 0 || idx === trip.stops.length - 1) continue; // no departures from the last stop
      const sched = trip.stops[idx].at;
      const actual = sched + trip.delayMin * 60_000;
      if (actual < now - 60_000) continue;
      const minsAway = (actual - now) / 60_000;
      const status = trip.cancelled
        ? "Cancelled"
        : minsAway <= 2
          ? "All Aboard"
          : trip.delayMin > 0
            ? "Late"
            : minsAway <= 15
              ? `in ${Math.max(1, Math.round(minsAway))} Min`
              : "On Time";
      items.push({
        at: sched,
        item: {
          SCHED_DEP_DATE: formatNjtTime(sched),
          DESTINATION: trip.stops[trip.stops.length - 1].name,
          TRACK: minsAway <= 15 && !trip.cancelled ? trip.track : "",
          LINE: trip.line.name,
          LINECODE: trip.line.code,
          LINEABBREVIATION: trip.line.abbr,
          DIRECTION: trip.outbound ? "Westbound" : "Eastbound",
          TRAIN_ID: trip.id,
          STATUS: status,
          SEC_LATE: String(trip.delayMin * 60),
          LAST_MODIFIED: formatNjtTime(now),
          STATION_POSITION: String(idx),
          CAPACITY: [{ CUR_PERCENTAGE: String(trip.crowding), VEHICLE_TYPE: "Multilevel" }],
          STOPS: withStops ? this.toStops(trip) : null,
        },
      });
    }
    items.sort((a, b) => a.at - b.at);
    return {
      STATION_2CHAR: code,
      STATIONNAME: name,
      STATIONMSGS: [],
      ITEMS: items.slice(0, limit).map((x) => x.item),
    };
  }

  async departures(station: string): Promise<StationBoard> {
    return this.board(station, false, 19);
  }

  async boardWithStops(station: string): Promise<StationBoard> {
    return this.board(station, true, 40);
  }

  async trainStops(trainId: string): Promise<TrainStopList> {
    const now = this.now();
    // Several trips can share a number across the day; pick the one running now or next.
    const matches = this.trips().filter((t) => t.id === trainId);
    if (!matches.length) throw new Error(`No train ${trainId} found in the sample data.`);
    matches.sort((a, b) => Math.abs(a.stops[0].at - now) - Math.abs(b.stops[0].at - now));
    const trip = matches[0];
    return {
      TRAIN_ID: trip.id,
      LINECODE: trip.line.code,
      DESTINATION: trip.stops[trip.stops.length - 1].name,
      STOPS: this.toStops(trip),
      CAPACITY: [{ CUR_PERCENTAGE: String(trip.crowding), VEHICLE_TYPE: "Multilevel", SECTIONS: mockSections(trip) }],
    };
  }

  async alerts(station?: string): Promise<StationMessage[]> {
    const pub = formatNjtTime(this.now() - 25 * 60_000);
    const all: StationMessage[] = [
      {
        MSG_TYPE: "banner",
        MSG_TEXT: "SAMPLE ALERT: Northeast Corridor trains are subject to up to 10 minute delays near Newark Penn Station due to signal work.",
        MSG_PUBDATE: pub,
        MSG_ID: "sample-1",
        MSG_AGENCY: "NJT",
        MSG_SOURCE: "sample",
        MSG_STATION_SCOPE: "NP",
        MSG_LINE_SCOPE: "Northeast Corrdr",
      },
      {
        MSG_TYPE: "banner",
        MSG_TEXT: "SAMPLE ALERT: Elevator out of service at Secaucus Junction, upper level. Use the elevator at the east end.",
        MSG_PUBDATE: pub,
        MSG_ID: "sample-2",
        MSG_AGENCY: "NJT",
        MSG_SOURCE: "sample",
        MSG_STATION_SCOPE: "SE",
        MSG_LINE_SCOPE: "",
      },
    ];
    return station ? all.filter((m) => !m.MSG_STATION_SCOPE || m.MSG_STATION_SCOPE.includes(station)) : all;
  }
}
