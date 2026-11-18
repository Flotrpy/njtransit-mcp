import { test } from "node:test";
import assert from "node:assert/strict";
import { NjtLiveSource } from "../src/njt.ts";
import { MemoryKV } from "../src/cache.ts";
import { callTool } from "../src/tools.ts";

interface Seen { url: string; fields: Record<string, string> }

/** Fake NJ Transit server: records calls and answers with canned JSON. */
function fakeNjt(handlers: Record<string, (f: Record<string, string>) => unknown>, status: Record<string, number> = {}) {
  const seen: Seen[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    const fields: Record<string, string> = {};
    (init!.body as FormData).forEach((v, k) => (fields[k] = String(v)));
    seen.push({ url, fields });
    const method = url.split("/").pop()!;
    const h = handlers[method];
    if (!h) return new Response(JSON.stringify({ errorMessage: "no such method" }), { status: 404 });
    return new Response(JSON.stringify(h(fields)), { status: status[method] ?? 200 });
  };
  return { seen, fetchFn };
}

const NOW = Date.parse("2026-11-18T22:00:00Z"); // 5:00 PM ET
const stations = [
  { STATION_2CHAR: "NY", STATIONNAME: "New York Penn Station" },
  { STATION_2CHAR: "MP", STATIONNAME: "Metropark" },
];

test("gets a token once, sends it as a form field, caches responses", async () => {
  const { seen, fetchFn } = fakeNjt({
    getToken: () => ({ Authenticated: "True", UserToken: "tok-1" }),
    getStationList: () => stations,
  });
  const kv = new MemoryKV();
  const src = new NjtLiveSource({ njtUsername: "u", njtPassword: "p", kv }, { fetch: fetchFn, now: () => NOW });
  await src.stations();
  await src.stations();
  assert.deepEqual(seen.map((s) => s.url.split("/").pop()), ["getToken", "getStationList"]);
  assert.equal(seen[1].fields.token, "tok-1");
  assert.ok(seen[1].url.startsWith("https://raildata.njtransit.com/api/TrainData/"));
  // Token survives a "restart" through KV, so no new token is requested.
  const again = new NjtLiveSource({ njtUsername: "u", njtPassword: "p", kv }, { fetch: fetchFn, now: () => NOW });
  await again.departures("NY").catch(() => {});
  assert.equal(seen.filter((s) => s.url.endsWith("getToken")).length, 1);
});

test("refreshes the token once when NJ Transit says it is invalid", async () => {
  let n = 0;
  const { seen, fetchFn } = fakeNjt(
    {
      getToken: () => ({ Authenticated: "True", UserToken: `tok-${++n}` }),
      getStationMSG: (f) => (f.token === "old" ? { errorMessage: "Invalid token." } : [{ MSG_TEXT: "hello" }]),
    },
    {},
  );
  const src = new NjtLiveSource({ njtUsername: "u", njtPassword: "p", njtToken: "old" }, { fetch: fetchFn, now: () => NOW });
  const msgs = await src.alerts();
  assert.equal(msgs[0].MSG_TEXT, "hello");
  assert.deepEqual(seen.map((s) => s.url.split("/").pop()), ["getStationMSG", "getToken", "getStationMSG"]);
});

test("stops asking for tokens after 4 in one Eastern day", async () => {
  const { fetchFn } = fakeNjt({ getToken: () => ({ Authenticated: "False" }) });
  const kv = new MemoryKV();
  for (let i = 0; i < 4; i++) {
    const src = new NjtLiveSource({ njtUsername: "u", njtPassword: "bad", kv }, { fetch: fetchFn, now: () => NOW });
    await assert.rejects(src.stations(), /didn't accept/);
  }
  const src = new NjtLiveSource({ njtUsername: "u", njtPassword: "bad", kv }, { fetch: fetchFn, now: () => NOW });
  await assert.rejects(src.stations(), /limit is 5 a day/);
});

test("uses the test endpoint when asked", async () => {
  const { seen, fetchFn } = fakeNjt({ getStationList: () => stations });
  const src = new NjtLiveSource({ njtToken: "t", useTestApi: true }, { fetch: fetchFn, now: () => NOW });
  await src.stations();
  assert.ok(seen[0].url.startsWith("https://testraildata.njtransit.com/"));
});

test("tools read real RailData shapes (departures with delay, trip via stop list)", async () => {
  const { fetchFn } = fakeNjt({
    getStationList: () => stations,
    getTrainSchedule19Rec: () => ({
      STATION_2CHAR: "MP",
      STATIONNAME: "Metropark",
      ITEMS: [
        { SCHED_DEP_DATE: "18-Nov-2026 05:10:00 PM", DESTINATION: "New York -SEC", TRACK: "1", LINE: "Northeast Corrdr", LINEABBREVIATION: "NEC", TRAIN_ID: "3890", STATUS: "Late", SEC_LATE: "360" },
        { SCHED_DEP_DATE: "18-Nov-2026 05:25:00 PM", DESTINATION: "Trenton", TRACK: "", LINE: "Northeast Corrdr", LINEABBREVIATION: "NEC", TRAIN_ID: "3891", STATUS: "Cancelled", SEC_LATE: "0" },
      ],
    }),
    getTrainSchedule: () => ({
      STATION_2CHAR: "MP",
      STATIONNAME: "Metropark",
      ITEMS: [{ SCHED_DEP_DATE: "18-Nov-2026 05:10:00 PM", DESTINATION: "New York -SEC", TRAIN_ID: "3890", LINE: "Northeast Corrdr", STATUS: "", SEC_LATE: "0", STOPS: null }],
    }),
    getTrainStopList: () => ({
      TRAIN_ID: "3890",
      DESTINATION: "New York",
      STOPS: [
        { STATION_2CHAR: "MP", STATIONNAME: "Metropark", TIME: "18-Nov-2026 05:10:00 PM", DEPARTED: "NO" },
        { STATION_2CHAR: "NY", STATIONNAME: "New York Penn Station", TIME: "18-Nov-2026 05:52:00 PM", DEPARTED: "NO" },
      ],
    }),
  });
  const ctx = { source: new NjtLiveSource({ njtToken: "t" }, { fetch: fetchFn, now: () => NOW }), now: () => NOW };
  const dep = await callTool("next_departures", { station: "metropark" }, ctx);
  const text = dep.content[0].text;
  assert.match(text, /5:10 PM → 5:16 PM \(in 16 min\) · Train 3890 to New York/);
  assert.match(text, /6 min late/);
  assert.match(text, /Cancelled/);
  assert.match(text, /may not be real time/);
  const trip = await callTool("plan_trip", { from: "MP", to: "NY" }, ctx);
  assert.match(trip.content[0].text, /arrive 5:52 PM · 42 min · Train 3890/);
});

test("NJ Transit errors become readable tool errors", async () => {
  const { fetchFn } = fakeNjt({ getStationList: () => ({ errorMessage: "Service unavailable" }) }, { getStationList: 503 });
  const ctx = { source: new NjtLiveSource({ njtToken: "t" }, { fetch: fetchFn, now: () => NOW }), now: () => NOW };
  const r = await callTool("next_departures", { station: "NY" }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /NJ Transit returned an error/);
});
