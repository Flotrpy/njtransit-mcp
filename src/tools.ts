// The MCP tools: what Claude can ask this server, and how answers are worded.

import { matchesLine, matchesText, resolveStation, searchStations, StationNotFound } from "./match.ts";
import { NjtError } from "./njt.ts";
import { etParts, etWallToEpoch, formatClock, formatDayClock, formatDuration, parseNjtTime, relativeMinutes } from "./time.ts";
import type { RailSource, ScheduleItem, Stop, TrainStopList } from "./types.ts";

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

const planTrip: ToolDef = {
  name: "plan_trip",
  title: "Direct NJ Transit trains between two stations",
  description:
    "Find the next direct NJ Transit trains from one station to another, with departure and arrival times " +
    "(Eastern), trip length, track and delays. Use for questions like \"when's the next train from Metropark " +
    "to New York?\". Only lists one-seat rides; if none run, it says so and suggests a transfer point.",
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

    const board = await ctx.source.boardWithStops(from.STATION_2CHAR);
    const now = ctx.now();
    const items = board.ITEMS ?? [];

    const trips = await directTrips(ctx, items, from.STATION_2CHAR, to.STATION_2CHAR, limit);

    const header = `Direct trains from ${from.STATIONNAME} (${from.STATION_2CHAR}) to ${to.STATIONNAME} (${to.STATION_2CHAR}):`;
    if (!trips.length) {
      const hub = ["SE", "NP", "NY"].filter((c) => c !== from.STATION_2CHAR && c !== to.STATION_2CHAR);
      const hint = hub.length ? ` You may need to change trains; Secaucus (SE) and Newark Penn (NP) are the usual transfer points.` : "";
      return text(
        `${header}\nNo direct trains found in the next ${items.length} departures from ${from.STATIONNAME}.${hint}\n\n${footer(ctx.source, now)}`,
        { from: from.STATION_2CHAR, to: to.STATION_2CHAR, trips: [], sampleData: ctx.source.mode === "mock" },
      );
    }
    const lines = trips.map((t, i) => tripLine(t, now, `${i + 1}. `));
    return text(`${header}\n${lines.join("\n")}\n\n${footer(ctx.source, now)}`, {
      from: { code: from.STATION_2CHAR, name: from.STATIONNAME },
      to: { code: to.STATION_2CHAR, name: to.STATIONNAME },
      trips: trips.map(tripData),
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

const trainStatus: ToolDef = {
  name: "train_status",
  title: "Where is my NJ Transit train?",
  description:
    "Track one NJ Transit train by its number: every stop with times (Eastern), which stops it has already " +
    "left, where it is now, whether it's late or cancelled, and how crowded it is when reported. " +
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

export const TOOLS: ToolDef[] = [nextDepartures, planTrip, lastTrain, trainStatus, serviceAlerts, findStation];

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
