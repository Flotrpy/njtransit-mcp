import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/mcp.ts";
import { MockSource } from "../src/mock.ts";

const NOW = Date.parse("2026-11-18T22:00:00Z"); // 5:00 PM ET
const clock = () => NOW;
const app = createApp(new MockSource({ now: clock }), {}, clock);
const locked = createApp(new MockSource({ now: clock }), { accessKey: "s3cret-key" }, clock);

async function rpc(a = app, body: unknown, path = "/mcp", headers: Record<string, string> = {}) {
  const res = await a.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = (name: string, args: Record<string, unknown>) =>
  rpc(app, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });

test("initialize negotiates the protocol version", async () => {
  const r = await rpc(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  assert.ok(r.body.result.capabilities.tools);
  const old = await rpc(app, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(old.body.result.protocolVersion, "2025-06-18");
});

test("notifications get 202 with no body", async () => {
  const r = await rpc(app, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
});

test("tools/list returns all tools with schemas", async () => {
  const r = await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = r.body.result.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ["find_station", "last_train", "next_departures", "plan_trip", "service_alerts", "train_status"]);
  for (const t of r.body.result.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.ok(t.description.length > 40);
    assert.equal(t.annotations.readOnlyHint, true);
  }
});

test("unknown method and bad JSON give JSON-RPC errors", async () => {
  const r = await rpc(app, { jsonrpc: "2.0", id: 4, method: "nope" });
  assert.equal(r.body.error.code, -32601);
  const bad = await app.fetch(new Request("https://example.com/mcp", { method: "POST", body: "{oops" }));
  assert.equal(bad.status, 400);
});

test("GET /mcp is 405 (no SSE stream), health check works", async () => {
  const r = await app.fetch(new Request("https://example.com/mcp"));
  assert.equal(r.status, 405);
  const h = await (await app.fetch(new Request("https://example.com/"))).json();
  assert.equal(h.mode, "mock");
});

test("next_departures shows Eastern times and the sample-data label", async () => {
  const r = await call("next_departures", { station: "Secaucus", limit: 5 });
  const text = r.body.result.content[0].text as string;
  assert.ok(!r.body.result.isError, text);
  assert.match(text, /Next trains from Secaucus Upper Lvl \(SE\)/);
  assert.match(text, /\d{1,2}:\d{2} (AM|PM)/);
  assert.match(text, /As of Wed, Nov 18, 5:00 PM ET/);
  assert.match(text, /SAMPLE DATA/);
  assert.equal(r.body.result.structuredContent.departures.length, 5);
});

test("next_departures filters by line", async () => {
  const r = await call("next_departures", { station: "NY", line: "coast", limit: 19 });
  const deps = r.body.result.structuredContent.departures;
  assert.ok(deps.length > 0);
  for (const d of deps) assert.equal(d.line, "No Jersey Coast");
});

test("plan_trip finds direct trains with arrival after departure", async () => {
  const r = await call("plan_trip", { from: "metropark", to: "penn station" });
  const trips = r.body.result.structuredContent.trips;
  assert.ok(trips.length > 0, r.body.result.content[0].text);
  for (const t of trips) assert.ok(t.minutes > 0 && t.minutes < 120);
});

test("plan_trip offers trips with one change when there is no one-seat ride", async () => {
  const r = await call("plan_trip", { from: "Red Bank", to: "Dover" });
  const text = r.body.result.content[0].text;
  assert.match(text, /No direct trains/);
  assert.match(text, /Trips with one change/);
  const transfers = r.body.result.structuredContent.transfers;
  assert.ok(transfers.length > 0 && transfers.length <= 3, text);
  for (const t of transfers) {
    assert.equal(t.change.code, "SE");
    assert.ok(t.connectionMinutes >= 5 && t.connectionMinutes <= 60);
    assert.equal(t.legs.length, 2);
    assert.notEqual(t.legs[0].trainId, t.legs[1].trainId);
    assert.ok(t.minutes > 0);
  }
  // Soonest arrival first, and no second train offered twice.
  const ids = transfers.map((t: { legs: { trainId: string }[] }) => t.legs[1].trainId);
  assert.equal(new Set(ids).size, ids.length);
});

test("plan_trip plans a change only when no direct train runs", async () => {
  const r = await call("plan_trip", { from: "Metropark", to: "Summit" });
  assert.ok(r.body.result.structuredContent.transfers.length > 0);
  const direct = await call("plan_trip", { from: "Metropark", to: "Trenton" });
  assert.ok(direct.body.result.structuredContent.trips.length > 0);
  assert.equal(direct.body.result.structuredContent.transfers, undefined);
});

test("train_status lists stops", async () => {
  const dep = await call("next_departures", { station: "NY", limit: 1 });
  const id = dep.body.result.structuredContent.departures[0].trainId;
  const r = await call("train_status", { train_id: id });
  assert.ok(!r.body.result.isError, r.body.result.content[0].text);
  assert.ok(r.body.result.structuredContent.stops.length >= 5);
});

test("service_alerts and find_station work", async () => {
  const a = await call("service_alerts", { station: "Newark Penn" });
  assert.match(a.body.result.content[0].text, /SAMPLE ALERT/);
  const f = await call("find_station", { query: "newark" });
  assert.equal(f.body.result.structuredContent.matches[0].code, "NP");
});

test("bad input comes back as a readable tool error, not a crash", async () => {
  const r = await call("next_departures", { station: "Hogwarts" });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /No NJ Transit station matches|could mean/);
  const missing = await call("plan_trip", { from: "NY" });
  assert.equal(missing.body.result.isError, true);
});

test("access key: required in path or bearer header when set", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  assert.equal((await rpc(locked, body, "/mcp")).status, 401);
  assert.equal((await rpc(locked, body, "/mcp/wrong")).status, 401);
  assert.equal((await rpc(locked, body, "/mcp/s3cret-key")).status, 200);
  assert.equal((await rpc(locked, body, "/mcp", { authorization: "Bearer s3cret-key" })).status, 200);
});

test("unknown browser origins are refused", async () => {
  const body = { jsonrpc: "2.0", id: 1, method: "ping" };
  assert.equal((await rpc(app, body, "/mcp", { origin: "https://evil.example" })).status, 403);
  assert.equal((await rpc(app, body, "/mcp", { origin: "http://localhost:6274" })).status, 200);
});

test("last_train in the afternoon warns that later trains may exist", async () => {
  const r = await call("last_train", { from: "Penn Station", to: "Metropark" });
  const res = r.body.result;
  assert.ok(!res.isError, res.content[0].text);
  assert.ok(res.structuredContent.lastTrain, "should find a last train on the board");
  assert.equal(res.structuredContent.mayBeLaterTrains, true);
  assert.match(res.content[0].text, /may be later ones/);
  // Earlier options really are earlier.
  for (const e of res.structuredContent.earlier) assert.ok(e.trainId !== res.structuredContent.lastTrain.trainId);
});

test("last_train late at night stops at the 3 AM service-day cutoff", async () => {
  const late = Date.parse("2026-11-19T04:30:00Z"); // 11:30 PM ET
  const lateClock = () => late;
  const lateApp = createApp(new MockSource({ now: lateClock }), {}, lateClock);
  const r = await rpc(lateApp, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "last_train", arguments: { from: "NY", to: "Trenton" } } });
  const res = r.body.result;
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(res.structuredContent.mayBeLaterTrains, false);
  assert.doesNotMatch(res.content[0].text, /may be later ones/);
  const departs = res.structuredContent.lastTrain.departs as string;
  // Before 3 AM: an hour of 12, 1 or 2 AM, or 11 PM.
  assert.match(departs, /^(11:\d\d PM|12:\d\d AM|[12]:\d\d AM)$/);
});
