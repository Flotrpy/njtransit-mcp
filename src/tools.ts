// The MCP tools: what Claude can ask this server, and how answers are worded.

import { matchesLine, matchesText, resolveStation, searchStations, StationNotFound } from "./match.ts";
import { NjtError } from "./njt.ts";
import { etParts, etWallToEpoch, formatClock, formatDayClock, formatDuration, parseNjtTime, relativeMinutes } from "./time.ts";
import type { Capacity, RailSource, ScheduleItem, Station, Stop, TrainStopList } from "./types.ts";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  source: RailSource;
  now: () => number;
  /** Saved commute stations (COMMUTE_HOME / COMMUTE_AWAY), as typed. */
  commute?: { home?: string; away?: string };
}

/** Thrown for bad input; turned into a tool error the model can read and fix. */
export class InputError extends Error {}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---------- helpers ----------

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError(`Missing "${key}".`);
    return undefined;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new InputError(`"${key}" must be text.`);
  return String(v).trim();
}

function int(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new InputError(`"${key}" must be a number.`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

function footer(source: RailSource, now: number): string {
  const base = `As of ${formatDayClock(now)} ET.`;
  return source.mode === "mock"
    ? `${base} SAMPLE DATA: no NJ Transit account is connected yet, so these trains are made up for testing.`
    : `${base} Data from NJ Transit; it may not be real time.`;
}

function text(body: string, structured?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: body }], structuredContent: structured };
}

function secLate(item: { SEC_LATE?: string }): number {
  const n = Number(item.SEC_LATE);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isCancelled(status?: string): boolean {
  return /cancel/i.test(status ?? "");
}

/** "On time", "6 min late", "Cancelled", or NJ Transit's own status when it says more. */
function statusText(item: ScheduleItem): string {
  if (isCancelled(item.STATUS)) return "Cancelled";
  const late = Math.round(secLate(item) / 60);
  const own = (item.STATUS ?? "").trim();
  const lateText = late >= 1 ? `${late} min late` : "On time";
  // Keep NJ Transit's boarding words ("All Aboard", "Boarding") next to our delay text.
  if (own && !/^(on ?time|late|in \d+ min)$/i.test(own)) return `${own} · ${lateText}`;
  return lateText;
}

interface Departure {
  trainId: string;
  line: string;
  destination: string;
  track: string | null;
  scheduled: string | null; // "2:15 PM"
  expected: string | null;
  minutesLate: number;
  cancelled: boolean;
  status: string;
  crowdingPercent: number | null;
  note: string | null;
}

function crowding(cap?: { CUR_PERCENTAGE?: string }[]): number | null {
  const vals = (cap ?? []).map((c) => Number(c.CUR_PERCENTAGE)).filter((n) => Number.isFinite(n) && n >= 0);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function crowdingWord(pct: number | null): string {
  if (pct == null) return "";
  if (pct < 40) return "plenty of seats";
  if (pct < 75) return "some seats";
  return "crowded";
}

function toDeparture(item: ScheduleItem): Departure & { schedMs?: number; expMs?: number } {
  const schedMs = parseNjtTime(item.SCHED_DEP_DATE);
  const lateSec = secLate(item);
  const expMs = schedMs !== undefined ? schedMs + lateSec * 1000 : undefined;
  return {
    trainId: item.TRAIN_ID,
    line: item.LINE ?? item.LINEABBREVIATION ?? "",
    destination: (item.DESTINATION ?? "").replace(/\s*-?SEC\s*$/i, "").trim() || item.DESTINATION,
    track: item.TRACK?.trim() || null,
    scheduled: schedMs !== undefined ? formatClock(schedMs) : item.SCHED_DEP_DATE ?? null,
    expected: expMs !== undefined ? formatClock(expMs) : null,
    minutesLate: Math.round(lateSec / 60),
    cancelled: isCancelled(item.STATUS),
    status: statusText(item),
    crowdingPercent: crowding(item.CAPACITY),
    note: item.INLINEMSG?.trim() || null,
    schedMs,
    expMs,
  };
}

function departureLine(d: ReturnType<typeof toDeparture>, now: number, i: number): string {
  const when =
    d.schedMs === undefined
      ? d.scheduled ?? "?"
      : d.minutesLate >= 1 && !d.cancelled
        ? `${d.scheduled} → ${d.expected} (${relativeMinutes(d.expMs!, now)})`
        : `${d.scheduled} (${relativeMinutes(d.schedMs, now)})`;
  const parts = [
    `${i}. ${when}`,
    `Train ${d.trainId} to ${d.destination}`,
    d.line,
    d.track ? `Track ${d.track}` : "Track not posted yet",
    d.status,
  ];
  const crowd = crowdingWord(d.crowdingPercent);
  if (crowd && !d.cancelled) parts.push(crowd);
  let line = parts.filter(Boolean).join(" · ");
  if (d.note) line += `\n   Note: ${d.note}`;
  return line;
}

function stripInternal<T extends { schedMs?: number; expMs?: number }>(d: T): Omit<T, "schedMs" | "expMs"> {
  const { schedMs: _s, expMs: _e, ...rest } = d;
  return rest;
}

async function station(ctx: ToolContext, query: string) {
  return resolveStation(await ctx.source.stations(), query);
}

// ---------- tools ----------

const findStation: ToolDef = {
  name: "find_station",
  title: "Find an NJ Transit station",
  description:
    "Look up NJ Transit rail stations by name and get their 2-letter station codes. Understands nicknames " +
    '("Penn Station", "Secaucus", "EWR", "Princeton Junction"). Use this when a station name is ambiguous; ' +
    "the other tools also accept plain station names.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: 'Part of a station name or a code, e.g. "metropark" or "NP".' },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const query = str(args, "query", true);
    const matches = searchStations(await ctx.source.stations(), query, 8);
    if (!matches.length) return text(`No NJ Transit station matches "${query}".`, { matches: [] });
    const lines = matches.map((m) => `- ${m.station.STATIONNAME} (code ${m.station.STATION_2CHAR})`);
    return text(`Stations matching "${query}":\n${lines.join("\n")}`, {
      matches: matches.map((m) => ({ code: m.station.STATION_2CHAR, name: m.station.STATIONNAME, score: m.score })),
    });
  },
};

const nextDepartures: ToolDef = {
  name: "next_departures",
  title: "Next NJ Transit trains from a station",
  description:
    "Live departure board for an NJ Transit rail station: the next trains with scheduled and expected times " +
    "(Eastern), track, delay, cancellations and how crowded the train is when NJ Transit reports it. " +
    "Optionally filter by line (e.g. \"Northeast Corridor\", \"Coast\", \"Morristown\") or destination.",
  inputSchema: {
    type: "object",
    properties: {
      station: { type: "string", description: 'Station name or 2-letter code, e.g. "New York Penn" or "NY".' },
      line: { type: "string", description: 'Only trains on this line, e.g. "NEC", "North Jersey Coast", "Raritan Valley".' },
      destination: { type: "string", description: 'Only trains whose final stop matches this, e.g. "Trenton".' },
      limit: { type: "integer", minimum: 1, maximum: 19, description: "How many trains to show (default 8)." },
    },
    required: ["station"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const st = await station(ctx, str(args, "station", true));
    const line = str(args, "line");
    const dest = str(args, "destination");
    const limit = int(args, "limit", 8, 1, 19);
    const board = await ctx.source.departures(st.STATION_2CHAR);
    const now = ctx.now();
    const items = (board.ITEMS ?? [])
      .filter((it) => !line || matchesLine(it, line))
      .filter((it) => !dest || matchesText(it.DESTINATION, dest))
      .slice(0, limit)
      .map(toDeparture);

    const filters = [line && `on ${line}`, dest && `to ${dest}`].filter(Boolean).join(" ");
    const header = `Next trains from ${st.STATIONNAME} (${st.STATION_2CHAR})${filters ? ` ${filters}` : ""}:`;
    const body = items.length
      ? items.map((d, i) => departureLine(d, now, i + 1)).join("\n")
      : "No upcoming departures found" + (filters ? " with those filters." : ".");
    const msgs = (board.STATIONMSGS ?? []).map((m) => m.MSG_TEXT).filter(Boolean);
    const alertText = msgs.length ? `\n\nStation alerts:\n${msgs.map((m) => `- ${m}`).join("\n")}` : "";
    return text(`${header}\n${body}${alertText}\n\n${footer(ctx.source, now)}`, {
      station: { code: st.STATION_2CHAR, name: st.STATIONNAME },
      departures: items.map(stripInternal),
      alerts: msgs,
      sampleData: ctx.source.mode === "mock",
    });
  },
};

interface DirectTrip {
  dep: ReturnType<typeof toDeparture>;
  depart?: number;
  arrive?: number;
}

/**
 * Trains on a departure board that run from one station to another without a change.
 * Some boards come without stop lists; those trains are looked up one by one (a few at most).
 */
async function directTrips(
  ctx: ToolContext,
  items: ScheduleItem[],
  fromCode: string,
  toCode: string,
  maxTrips: number,
): Promise<DirectTrip[]> {
  let lookups = 0;
  const trips: DirectTrip[] = [];
  for (const item of items) {
    if (trips.length >= maxTrips) break;
    let stops: Stop[] | null | undefined = item.STOPS;
    if (!stops?.length) {
      if (lookups >= 12) continue;
      lookups++;
      try {
        stops = (await ctx.source.trainStops(item.TRAIN_ID)).STOPS;
      } catch {
        continue;
      }
    }
    if (!stops?.length) continue;
    const iFrom = stops.findIndex((s) => s.STATION_2CHAR === fromCode);
    const iTo = stops.findIndex((s, i) => i > iFrom && s.STATION_2CHAR === toCode);
    if (iFrom < 0 || iTo < 0) continue;
    if (/^n/i.test(stops[iTo].DROPOFF ?? "")) continue; // doesn't let people off there
    const dep = toDeparture(item);
    trips.push({ dep, depart: stopTime(stops[iFrom]) ?? dep.expMs, arrive: stopTime(stops[iTo]) });
  }
  return trips;
}

function tripLine(t: DirectTrip, now: number, label: string): string {
  const d = t.dep;
  const leave = t.depart !== undefined ? `${formatClock(t.depart)} (${relativeMinutes(t.depart, now)})` : d.scheduled;
  const arrive = t.arrive !== undefined ? formatClock(t.arrive) : "arrival time not listed";
  const dur = t.depart !== undefined && t.arrive !== undefined ? ` · ${formatDuration(t.arrive - t.depart)}` : "";
  return `${label}Leave ${leave} → arrive ${arrive}${dur} · Train ${d.trainId} (${d.line}) · ${d.track ? `Track ${d.track}` : "Track not posted yet"} · ${d.status}`;
}

function tripData(t: DirectTrip) {
  return {
    ...stripInternal(t.dep),
    departs: t.depart !== undefined ? formatClock(t.depart) : null,
    arrives: t.arrive !== undefined ? formatClock(t.arrive) : null,
    minutes: t.depart !== undefined && t.arrive !== undefined ? Math.round((t.arrive - t.depart) / 60000) : null,
  };
}

/** Where people usually change trains, with the least time to allow for the change. */
const TRANSFER_HUBS: { code: string; minChangeMin: number }[] = [
  { code: "SE", minChangeMin: 5 },
  { code: "NP", minChangeMin: 4 },
];
/** Don't suggest a change that leaves someone waiting longer than this. */
const MAX_CONNECTION_MIN = 60;

type TimedTrip = DirectTrip & { depart: number; arrive: number };

interface TransferTrip {
  hub: Station;
  first: TimedTrip;
  second: TimedTrip;
  depart: number;
  arrive: number;
  connectionMin: number;
}

function timed(t: DirectTrip): t is TimedTrip {
  return !t.dep.cancelled && t.depart !== undefined && t.arrive !== undefined;
}

/**
 * Two-train trips via Secaucus or Newark Penn, for when no train goes all the way.
 * Uses one extra board per hub (cached), so it stays light on NJ Transit's limits.
 */
async function transferTrips(
  ctx: ToolContext,
  fromItems: ScheduleItem[],
  stations: Station[],
  fromCode: string,
  toCode: string,
  maxTrips: number,
): Promise<TransferTrip[]> {
  const found: TransferTrip[] = [];
  for (const h of TRANSFER_HUBS) {
    if (h.code === fromCode || h.code === toCode) continue;
    const hub = stations.find((s) => s.STATION_2CHAR === h.code);
    if (!hub) continue;
    const firsts = (await directTrips(ctx, fromItems, fromCode, h.code, 4)).filter(timed);
    if (!firsts.length) continue;
    let hubItems: ScheduleItem[];
    try {
      hubItems = (await ctx.source.boardWithStops(h.code)).ITEMS ?? [];
    } catch {
      continue;
    }
    const minChange = h.minChangeMin * 60_000;
    const earliest = Math.min(...firsts.map((f) => f.arrive)) + minChange;
    // Only trains leaving the hub after the first possible connection.
    const later = hubItems.filter((it) => {
      const at = parseNjtTime(it.SCHED_DEP_DATE);
      return at === undefined || at + secLate(it) * 1000 >= earliest;
    });
    const seconds = (await directTrips(ctx, later, h.code, toCode, 8)).filter(timed);
    for (const first of firsts) {
      const second = seconds.find(
        (s) =>
          s.dep.trainId !== first.dep.trainId &&
          s.depart >= first.arrive + minChange &&
          s.depart - first.arrive <= MAX_CONNECTION_MIN * 60_000,
      );
      if (!second) continue;
      found.push({
        hub,
        first,
        second,
        depart: first.depart,
        arrive: second.arrive,
        connectionMin: Math.round((second.depart - first.arrive) / 60_000),
      });
    }
  }
  // Several first trains can feed the same second train: keep the one that leaves latest (least waiting).
  const best = new Map<string, TransferTrip>();
  for (const t of found) {
    const key = t.second.dep.trainId;
    const cur = best.get(key);
    if (!cur || t.depart > cur.depart || (t.depart === cur.depart && t.arrive < cur.arrive)) best.set(key, t);
  }
  return [...best.values()].sort((a, b) => a.arrive - b.arrive || b.depart - a.depart).slice(0, maxTrips);
}

function transferLine(t: TransferTrip, now: number, label: string): string {
  const f = t.first;
  const s = t.second;
  const head =
    `${label}Leave ${formatClock(t.depart)} (${relativeMinutes(t.depart, now)}) → arrive ${formatClock(t.arrive)}` +
    ` · ${formatDuration(t.arrive - t.depart)} · change at ${t.hub.STATIONNAME} (${t.hub.STATION_2CHAR}), ${t.connectionMin} min to connect`;
  const leg1 = `Train ${f.dep.trainId} (${f.dep.line}) · ${f.dep.track ? `Track ${f.dep.track}` : "Track not posted yet"} · ${f.dep.status} · gets to ${t.hub.STATION_2CHAR} ${formatClock(f.arrive)}`;
  const leg2 = `then Train ${s.dep.trainId} (${s.dep.line}) at ${formatClock(s.depart)} · ${s.dep.status}`;
  return `${head}\n   ${leg1}\n   ${leg2}`;
}

const planTrip: ToolDef = {
  name: "plan_trip",
  title: "Direct NJ Transit trains between two stations",
  description:
    "Find the next direct NJ Transit trains from one station to another, with departure and arrival times " +
    "(Eastern), trip length, track and delays. Use for questions like \"when's the next train from Metropark " +
    "to New York?\". Lists one-seat rides; when none run, it plans trips with one change at Secaucus or " +
    "Newark Penn, with the connection time.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Starting station name or code." },
      to: { type: "string", description: "Destination station name or code." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "How many trains to show (default 5)." },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const stations = await ctx.source.stations();
    const from = resolveStation(stations, str(args, "from", true));
    const to = resolveStation(stations, str(args, "to", true));
    const limit = int(args, "limit", 5, 1, 10);
    if (from.STATION_2CHAR === to.STATION_2CHAR) throw new InputError("The start and end stations are the same.");
    const plan = await planBetween(ctx, stations, from, to, limit);
    return text(`${plan.header}\n${plan.body}\n\n${footer(ctx.source, ctx.now())}`, {
      ...plan.data,
      sampleData: ctx.source.mode === "mock",
    });
  },
};

interface Plan {
  header: string;
  body: string;
  data: Record<string, unknown>;
}

/** Direct trains from one station to another, or trips with one change when none run. */
async function planBetween(ctx: ToolContext, stations: Station[], from: Station, to: Station, limit: number): Promise<Plan> {
  const board = await ctx.source.boardWithStops(from.STATION_2CHAR);
  const now = ctx.now();
  const items = board.ITEMS ?? [];
  const ends = {
    from: { code: from.STATION_2CHAR, name: from.STATIONNAME },
    to: { code: to.STATION_2CHAR, name: to.STATIONNAME },
  };
  const header = `Direct trains from ${from.STATIONNAME} (${from.STATION_2CHAR}) to ${to.STATIONNAME} (${to.STATION_2CHAR}):`;

  const trips = await directTrips(ctx, items, from.STATION_2CHAR, to.STATION_2CHAR, limit);
  if (trips.length) {
    return { header, body: trips.map((t, i) => tripLine(t, now, `${i + 1}. `)).join("\n"), data: { ...ends, trips: trips.map(tripData) } };
  }
  const none = `No direct trains found in the next ${items.length} departures from ${from.STATIONNAME}.`;
  const transfers = await transferTrips(ctx, items, stations, from.STATION_2CHAR, to.STATION_2CHAR, Math.min(limit, 3));
  if (!transfers.length) {
    return {
      header,
      body: `${none} No trip with one change at Secaucus (SE) or Newark Penn (NP) turned up either.`,
      data: { ...ends, trips: [], transfers: [] },
    };
  }
  const tlines = transfers.map((t, i) => transferLine(t, now, `${i + 1}. `));
  return {
    header,
    body: `${none}\n\nTrips with one change:\n${tlines.join("\n")}`,
    data: {
      ...ends,
      trips: [],
      transfers: transfers.map((t) => ({
        change: { code: t.hub.STATION_2CHAR, name: t.hub.STATIONNAME },
        departs: formatClock(t.depart),
        arrives: formatClock(t.arrive),
        minutes: Math.round((t.arrive - t.depart) / 60000),
        connectionMinutes: t.connectionMin,
        legs: [tripData(t.first), tripData(t.second)],
      })),
    },
  };
}

const myCommute: ToolDef = {
  name: "my_commute",
  title: "My NJ Transit commute, both ways",
  description:
    "The next NJ Transit trains for the person's regular commute, both directions in one answer: from home to " +
    "their usual destination and back (times in Eastern). Uses the home and destination stations saved on the " +
    "server (COMMUTE_HOME and COMMUTE_AWAY); pass home and away to use other stations. In the morning the " +
    "trip away from home comes first; after noon the trip home comes first.",
  inputSchema: {
    type: "object",
    properties: {
      home: { type: "string", description: "Home station name or code. Defaults to the saved home station." },
      away: { type: "string", description: "Destination station (school, work). Defaults to the saved one." },
      limit: { type: "integer", minimum: 1, maximum: 5, description: "Trains to show each way (default 3)." },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const homeQ = str(args, "home") ?? ctx.commute?.home;
    const awayQ = str(args, "away") ?? ctx.commute?.away;
    if (!homeQ || !awayQ) {
      const missing = [!homeQ && "home", !awayQ && "away"].filter(Boolean).join(" and ");
      throw new InputError(
        `The commute needs a ${missing} station. Pass ${missing} (station names), or set COMMUTE_HOME and ` +
          "COMMUTE_AWAY on the server.",
      );
    }
    const limit = int(args, "limit", 3, 1, 5);
    const stations = await ctx.source.stations();
    const home = resolveStation(stations, homeQ);
    const away = resolveStation(stations, awayQ);
    if (home.STATION_2CHAR === away.STATION_2CHAR) throw new InputError("The home and away stations are the same.");

    const now = ctx.now();
    const homeFirst = etParts(now).hour >= 12;
    const [outbound, inbound] = await Promise.all([
      planBetween(ctx, stations, home, away, limit),
      planBetween(ctx, stations, away, home, limit),
    ]);
    const sections = [
      { title: `To ${away.STATIONNAME} (from ${home.STATIONNAME}):`, plan: outbound },
      { title: `Home to ${home.STATIONNAME} (from ${away.STATIONNAME}):`, plan: inbound },
    ];
    if (homeFirst) sections.reverse();
    const body = sections.map((s) => `${s.title}\n${s.plan.body}`).join("\n\n");
    return text(`Your commute, ${home.STATIONNAME} ⇄ ${away.STATIONNAME}\n\n${body}\n\n${footer(ctx.source, now)}`, {
      home: { code: home.STATION_2CHAR, name: home.STATIONNAME },
      away: { code: away.STATION_2CHAR, name: away.STATIONNAME },
      homeFirst,
      toAway: outbound.data,
      toHome: inbound.data,
      sampleData: ctx.source.mode === "mock",
    });
  },
};

function stopTime(s: Stop): number | undefined {
  return parseNjtTime(s.TIME_UTC_FORMAT) ?? parseNjtTime(s.DEP_TIME) ?? parseNjtTime(s.TIME);
}

/**
 * End of tonight's service day: 3:00 AM Eastern. Before 3 AM that's today's 3 AM;
 * otherwise tomorrow's. Also returns 11 PM tonight, used to tell whether NJ Transit's
 * board reaches far enough into the evening to trust it.
 */
export function tonightWindow(now: number): { cutoff: number; lateEvening: number } {
  const p = etParts(now);
  const at = (dayOffset: number, hour: number) =>
    etWallToEpoch({ year: p.year, month: p.month, day: p.day + dayOffset, hour, minute: 0, second: 0 });
  if (p.hour < 3) return { cutoff: at(0, 3), lateEvening: now };
  return { cutoff: at(1, 3), lateEvening: Math.max(now, at(0, 23)) };
}

const lastTrain: ToolDef = {
  name: "last_train",
  title: "Last NJ Transit train tonight",
  description:
    "The last direct NJ Transit train tonight from one station to another (service until about 3 AM Eastern), " +
    "with the two before it as backups. Use for \"what's the last train home from Penn Station?\". " +
    "Skips cancelled trains. If NJ Transit's board doesn't reach late enough yet, it says later trains may exist.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "Starting station name or code." },
      to: { type: "string", description: "Destination station name or code." },
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const stations = await ctx.source.stations();
    const from = resolveStation(stations, str(args, "from", true));
    const to = resolveStation(stations, str(args, "to", true));
    if (from.STATION_2CHAR === to.STATION_2CHAR) throw new InputError("The start and end stations are the same.");

    const now = ctx.now();
    const { cutoff, lateEvening } = tonightWindow(now);
    const board = await ctx.source.boardWithStops(from.STATION_2CHAR);
    const timed = (board.ITEMS ?? [])
      .map((item) => ({ item, at: parseNjtTime(item.SCHED_DEP_DATE) }))
      .filter((x): x is { item: ScheduleItem; at: number } => x.at !== undefined);
    // Latest expected departure on the board (scheduled time plus any delay).
    const lastListed = timed.reduce((m, x) => Math.max(m, x.at + secLate(x.item) * 1000), 0);
    const tonight = timed.filter((x) => x.at < cutoff).sort((a, b) => b.at - a.at); // latest first

    // Scan from the latest train backwards so stop-list lookups go to the trains that matter.
    const found = await directTrips(ctx, tonight.map((x) => x.item), from.STATION_2CHAR, to.STATION_2CHAR, 8);
    const cancelled = found.filter((t) => t.dep.cancelled);
    const usable = found.filter((t) => !t.dep.cancelled).slice(0, 3);
    const boardTooShort = lastListed > 0 && lastListed < cutoff && lastListed < lateEvening;

    const header = `Last direct train tonight from ${from.STATIONNAME} (${from.STATION_2CHAR}) to ${to.STATIONNAME} (${to.STATION_2CHAR}):`;
    const lines: string[] = [];
    if (!usable.length) {
      lines.push(
        boardTooShort
          ? `No direct trains found in what NJ Transit lists right now (through ${formatClock(lastListed)}).`
          : "No more direct trains tonight.",
      );
    } else {
      lines.push(tripLine(usable[0], now, ""));
      if (usable.length > 1) {
        lines.push("", "Earlier options:");
        for (const t of usable.slice(1)) lines.push(tripLine(t, now, "- "));
      }
    }
    const lastUsable = usable[0]?.depart ?? 0;
    const laterCancelled = cancelled.filter((t) => (t.depart ?? 0) > lastUsable);
    if (laterCancelled.length) {
      lines.push("", `Cancelled: ${laterCancelled.map((t) => `Train ${t.dep.trainId} at ${t.dep.scheduled}`).join(", ")}.`);
    }
    if (boardTooShort) {
      lines.push(
        "",
        `NJ Transit's board only lists trains through ${formatClock(lastListed)} right now, so there may be later ones. Ask again this evening for the real last train.`,
      );
    }
    return text(`${header}\n${lines.join("\n")}\n\n${footer(ctx.source, now)}`, {
      from: { code: from.STATION_2CHAR, name: from.STATIONNAME },
      to: { code: to.STATION_2CHAR, name: to.STATIONNAME },
      lastTrain: usable[0] ? tripData(usable[0]) : null,
      earlier: usable.slice(1).map(tripData),
      cancelled: laterCancelled.map((t) => t.dep.trainId),
      mayBeLaterTrains: boardTooShort,
      boardListsThrough: lastListed ? formatClock(lastListed) : null,
      sampleData: ctx.source.mode === "mock",
    });
  },
};

const SECTION_NAMES = ["front", "middle", "back"] as const;
type SectionName = (typeof SECTION_NAMES)[number];

function sectionName(pos: string | number | undefined): SectionName | null {
  if (pos === undefined || pos === null) return null;
  const s = String(pos).trim().toLowerCase();
  if (s === "0" || s.startsWith("front") || s.startsWith("first")) return "front";
  if (s === "1" || s.startsWith("mid")) return "middle";
  if (s === "2" || s.startsWith("back") || s.startsWith("rear") || s.startsWith("last")) return "back";
  return null;
}

function pctOf(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

interface CarCrowding {
  sections: { section: SectionName; percent: number }[];
  emptiest: SectionName | null;
  /** True when the ends differ by less than 10 points, so it doesn't matter where you board. */
  even: boolean;
  emptiestCars: { position: number; percent: number }[];
  restroomCars: number[];
}

/**
 * Which part of the train is emptiest, from NJ Transit's per-section and per-car counts.
 * Returns null when NJ Transit doesn't report sections for this train.
 */
export function carCrowding(cap?: Capacity[]): CarCrowding | null {
  const sectionsRaw = (cap ?? []).flatMap((c) => c.SECTIONS ?? []);
  if (!sectionsRaw.length) return null;
  const bySection = new Map<SectionName, number[]>();
  const cars: { position: number; percent: number | null; restroom: boolean }[] = [];
  for (const sec of sectionsRaw) {
    const name = sectionName(sec.SECTION_POSITION);
    const carList = sec.CARS ?? [];
    const carPcts = carList.map((c) => pctOf(c.CUR_PERCENTAGE)).filter((n): n is number => n !== null);
    const pct = pctOf(sec.CUR_PERCENTAGE) ?? (carPcts.length ? Math.round(carPcts.reduce((a, b) => a + b, 0) / carPcts.length) : null);
    if (name && pct !== null) bySection.set(name, [...(bySection.get(name) ?? []), pct]);
    for (const c of carList) {
      const position = Number(c.CAR_POSITION);
      if (!Number.isFinite(position)) continue;
      cars.push({ position, percent: pctOf(c.CUR_PERCENTAGE), restroom: c.CAR_REST === true || /^(y|yes|true|1)$/i.test(String(c.CAR_REST ?? "")) });
    }
  }
  const sections = SECTION_NAMES.filter((n) => bySection.has(n)).map((n) => {
    const v = bySection.get(n)!;
    return { section: n, percent: Math.round(v.reduce((a, b) => a + b, 0) / v.length) };
  });
  if (!sections.length && !cars.length) return null;
  const sorted = [...sections].sort((a, b) => a.percent - b.percent);
  const even = sorted.length < 2 || sorted[sorted.length - 1].percent - sorted[0].percent < 10;
  const emptiestCars = cars
    .filter((c): c is { position: number; percent: number; restroom: boolean } => c.percent !== null)
    .sort((a, b) => a.percent - b.percent || a.position - b.position)
    .slice(0, 2)
    .map(({ position, percent }) => ({ position, percent }));
  return {
    sections,
    emptiest: sorted.length ? sorted[0].section : null,
    even,
    emptiestCars,
    restroomCars: cars.filter((c) => c.restroom).map((c) => c.position).sort((a, b) => a - b),
  };
}

function carCrowdingText(c: CarCrowding): string {
  const parts: string[] = [];
  if (c.sections.length >= 2) {
    const others = c.sections.filter((s) => s.section !== c.emptiest).map((s) => `${s.section} ${s.percent}%`).join(", ");
    const best = c.sections.find((s) => s.section === c.emptiest)!;
    parts.push(
      c.even
        ? `About evenly full along the train (${c.sections.map((s) => `${s.section} ${s.percent}%`).join(", ")}).`
        : `Emptiest at the ${best.section} of the train (about ${best.percent}% full; ${others}).`,
    );
  }
  if (c.emptiestCars.length) {
    parts.push(
      `Emptiest cars, counting from the front: ${c.emptiestCars.map((x) => `car ${x.position} (${x.percent}%)`).join(", ")}.`,
    );
  }
  if (c.restroomCars.length) parts.push(`Restrooms in car${c.restroomCars.length > 1 ? "s" : ""} ${c.restroomCars.join(", ")}.`);
  return parts.join(" ");
}

const trainStatus: ToolDef = {
  name: "train_status",
  title: "Where is my NJ Transit train?",
  description:
    "Track one NJ Transit train by its number: every stop with times (Eastern), which stops it has already " +
    "left, where it is now, whether it's late or cancelled, and how crowded it is when reported, including " +
    "which end of the train has the most empty seats. " +
    "Get the train number from next_departures or plan_trip.",
  inputSchema: {
    type: "object",
    properties: {
      train_id: { type: "string", description: 'Train number, e.g. "3847".' },
    },
    required: ["train_id"],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const id = str(args, "train_id", true).replace(/^#?train\s*/i, "").replace(/^#/, "");
    if (!/^[A-Za-z0-9]{1,8}$/.test(id)) throw new InputError(`"${id}" doesn't look like a train number.`);
    let t: TrainStopList;
    try {
      t = await ctx.source.trainStops(id);
    } catch (e) {
      if (e instanceof NjtError) throw e;
      throw new InputError(`Couldn't find train ${id}. ${(e as Error).message}`);
    }
    const now = ctx.now();
    const stops = t.STOPS ?? [];
    if (!stops.length) return text(`NJ Transit has no stop list for train ${id} right now.\n\n${footer(ctx.source, now)}`);

    const cancelled = stops.every((s) => isCancelled(s.STOP_STATUS));
    const lastDeparted = stops.map((s) => /^y/i.test(s.DEPARTED ?? "")).lastIndexOf(true);
    const next = stops[lastDeparted + 1];
    const late = stops.some((s) => /late/i.test(s.STOP_STATUS ?? ""));
    const pct = crowding(t.CAPACITY);
    const byCar = cancelled ? null : carCrowding(t.CAPACITY);

    let where: string;
    if (cancelled) where = "This train is cancelled.";
    else if (lastDeparted < 0) where = `Hasn't left ${stops[0].STATIONNAME} yet.`;
    else if (!next) where = `Has finished its trip at ${stops[stops.length - 1].STATIONNAME}.`;
    else {
      const nt = stopTime(next);
      where = `Left ${stops[lastDeparted].STATIONNAME}; next stop ${next.STATIONNAME}${nt !== undefined ? ` at ${formatClock(nt)} (${relativeMinutes(nt, now)})` : ""}.`;
    }
    const summary = [
      `Train ${t.TRAIN_ID}${t.DESTINATION ? ` to ${t.DESTINATION}` : ""}${t.LINECODE ? ` (${t.LINECODE})` : ""}`,
      where,
      !cancelled ? (late ? "Running late." : "Running on time.") : "",
      pct != null ? `Crowding: about ${pct}% full (${crowdingWord(pct)}).` : "",
      byCar ? carCrowdingText(byCar) : "",
    ].filter(Boolean);

    const stopLines = stops.map((s, i) => {
      const tm = stopTime(s);
      const mark = /^y/i.test(s.DEPARTED ?? "") ? "[left]" : i === lastDeparted + 1 && !cancelled ? "[next]" : "      ";
      const status = s.STOP_STATUS && !/on ?time/i.test(s.STOP_STATUS) ? ` · ${s.STOP_STATUS}` : "";
      return `${mark} ${tm !== undefined ? formatClock(tm).padStart(8) : "    ?   "}  ${s.STATIONNAME}${status}`;
    });

    return text(`${summary.join("\n")}\n\nStops:\n${stopLines.join("\n")}\n\n${footer(ctx.source, now)}`, {
      trainId: t.TRAIN_ID,
      destination: t.DESTINATION ?? null,
      cancelled,
      late,
      crowdingPercent: pct,
      crowdingByCar: byCar,
      nextStop: next ? next.STATIONNAME : null,
      stops: stops.map((s) => {
        const tm = stopTime(s);
        return {
          code: s.STATION_2CHAR,
          name: s.STATIONNAME,
          time: tm !== undefined ? formatClock(tm) : null,
          departed: /^y/i.test(s.DEPARTED ?? ""),
          status: s.STOP_STATUS ?? null,
        };
      }),
      sampleData: ctx.source.mode === "mock",
    });
  },
};

const serviceAlerts: ToolDef = {
  name: "service_alerts",
  title: "NJ Transit rail service alerts",
  description:
    "Current NJ Transit rail alerts and delays: system-wide, or for one station and/or line " +
    "(e.g. \"Northeast Corridor delays\", \"anything wrong at Secaucus?\").",
  inputSchema: {
    type: "object",
    properties: {
      station: { type: "string", description: "Only alerts for this station (name or code)." },
      line: { type: "string", description: 'Only alerts for this line, e.g. "NEC" or "Morristown".' },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY,
  async run(args, ctx) {
    const stQuery = str(args, "station");
    const line = str(args, "line");
    const st = stQuery ? await station(ctx, stQuery) : undefined;
    const now = ctx.now();
    const all = await ctx.source.alerts(st?.STATION_2CHAR);
    const msgs = all
      .filter((m) => m.MSG_TEXT?.trim())
      .filter((m) => !line || !m.MSG_LINE_SCOPE || matchesLine({ LINE: m.MSG_LINE_SCOPE }, line))
      .map((m) => ({ ...m, t: parseNjtTime(m.MSG_PUBDATE_UTC) ?? parseNjtTime(m.MSG_PUBDATE) }))
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    // NJ Transit repeats some alerts per station; show each text once.
    const seen = new Set<string>();
    const unique = msgs.filter((m) => (seen.has(m.MSG_TEXT) ? false : (seen.add(m.MSG_TEXT), true)));

    const scope = [st && `at ${st.STATIONNAME}`, line && `on ${line}`].filter(Boolean).join(" ");
    const header = `NJ Transit rail alerts${scope ? ` ${scope}` : ""}:`;
    const body = unique.length
      ? unique
          .map((m) => `- ${m.MSG_TEXT.trim()}${m.t !== undefined ? ` (posted ${formatDayClock(m.t)})` : ""}`)
          .join("\n")
      : "No active alerts.";
    return text(`${header}\n${body}\n\n${footer(ctx.source, now)}`, {
      alerts: unique.map((m) => ({
        text: m.MSG_TEXT.trim(),
        posted: m.t !== undefined ? formatDayClock(m.t) : null,
        station: m.MSG_STATION_SCOPE ?? null,
        line: m.MSG_LINE_SCOPE ?? null,
      })),
      sampleData: ctx.source.mode === "mock",
    });
  },
};

export const TOOLS: ToolDef[] = [nextDepartures, planTrip, myCommute, lastTrain, trainStatus, serviceAlerts, findStation];

/** Run a tool by name, turning expected problems into readable tool errors. */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool "${name}".` }] };
  try {
    return await tool.run(args ?? {}, ctx);
  } catch (e) {
    if (e instanceof InputError || e instanceof StationNotFound || e instanceof NjtError) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
    return { isError: true, content: [{ type: "text", text: `Something went wrong: ${(e as Error).message}` }] };
  }
}
