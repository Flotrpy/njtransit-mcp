import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNjtTime, formatClock, formatNjtTime, etDateKey, relativeMinutes } from "../src/time.ts";

test("parses RailData times as Eastern wall time (winter, UTC-5)", () => {
  const t = parseNjtTime("18-Nov-2026 02:15:00 PM");
  assert.equal(new Date(t!).toISOString(), "2026-11-18T19:15:00.000Z");
  assert.equal(formatClock(t!), "2:15 PM");
});

test("parses summer times (UTC-4) and midnight/noon", () => {
  assert.equal(new Date(parseNjtTime("04-Jul-2026 12:00:00 AM")!).toISOString(), "2026-07-04T04:00:00.000Z");
  assert.equal(new Date(parseNjtTime("04-Jul-2026 12:30:00 PM")!).toISOString(), "2026-07-04T16:30:00.000Z");
});

test("parses slash dates, ISO with zone, and rejects junk", () => {
  assert.equal(new Date(parseNjtTime("11/18/2026 2:15:00 PM")!).toISOString(), "2026-11-18T19:15:00.000Z");
  assert.equal(new Date(parseNjtTime("2026-11-18T19:15:00Z")!).toISOString(), "2026-11-18T19:15:00.000Z");
  assert.equal(parseNjtTime(""), undefined);
  assert.equal(parseNjtTime("tomorrow-ish"), undefined);
});

test("round-trips formatNjtTime", () => {
  const t = Date.parse("2026-03-08T12:05:09Z"); // DST switch day in the US
  assert.equal(parseNjtTime(formatNjtTime(t)), t);
});

test("ET day key and relative minutes", () => {
  assert.equal(etDateKey(Date.parse("2026-11-19T03:00:00Z")), "2026-11-18"); // 10 PM ET
  const now = Date.parse("2026-11-18T19:00:00Z");
  assert.equal(relativeMinutes(now + 5 * 60000, now), "in 5 min");
  assert.equal(relativeMinutes(now + 70 * 60000, now), "in 1 hr 10 min");
  assert.equal(relativeMinutes(now - 2 * 60000, now), "2 min ago");
});
