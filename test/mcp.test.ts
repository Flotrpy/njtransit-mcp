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
  assert.deepEqual(names, ["find_station", "next_departures", "plan_trip", "service_alerts", "train_status"]);
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

test("plan_trip explains when there is no one-seat ride", async () => {
  const r = await call("plan_trip", { from: "Red Bank", to: "Dover" });
  assert.match(r.body.result.content[0].text, /No direct trains/);
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
