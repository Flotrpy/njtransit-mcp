import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStation, searchStations, matchesLine, StationNotFound } from "../src/match.ts";

const STATIONS = [
  { STATION_2CHAR: "NY", STATIONNAME: "New York Penn Station" },
  { STATION_2CHAR: "NP", STATIONNAME: "Newark Penn Station" },
  { STATION_2CHAR: "NA", STATIONNAME: "Newark Airport" },
  { STATION_2CHAR: "ND", STATIONNAME: "Newark Broad Street" },
  { STATION_2CHAR: "SE", STATIONNAME: "Secaucus Upper Lvl" },
  { STATION_2CHAR: "TS", STATIONNAME: "Secaucus Lower Lvl" },
  { STATION_2CHAR: "MP", STATIONNAME: "Metropark" },
  { STATION_2CHAR: "PJ", STATIONNAME: "Princeton Junction" },
  { STATION_2CHAR: "PR", STATIONNAME: "Princeton" },
];

test("resolves codes, names, nicknames and typos", () => {
  assert.equal(resolveStation(STATIONS, "NP").STATION_2CHAR, "NP");
  assert.equal(resolveStation(STATIONS, "np").STATION_2CHAR, "NP");
  assert.equal(resolveStation(STATIONS, "Penn Station").STATION_2CHAR, "NY");
  assert.equal(resolveStation(STATIONS, "secaucus").STATION_2CHAR, "SE");
  assert.equal(resolveStation(STATIONS, "EWR").STATION_2CHAR, "NA");
  assert.equal(resolveStation(STATIONS, "metro park").STATION_2CHAR, "MP");
  assert.equal(resolveStation(STATIONS, "princeton jct").STATION_2CHAR, "PJ");
  assert.equal(resolveStation(STATIONS, "Newark Broad St").STATION_2CHAR, "ND");
});

test("explains unknown stations", () => {
  assert.throws(() => resolveStation(STATIONS, "zzzz qqq"), StationNotFound);
});

test("search ranks the best match first", () => {
  const r = searchStations(STATIONS, "newark");
  assert.equal(r[0].station.STATION_2CHAR, "NP");
  assert.ok(r.some((m) => m.station.STATION_2CHAR === "ND"));
});

test("line nicknames match NJ Transit's line names", () => {
  const nec = { LINE: "Northeast Corrdr", LINEABBREVIATION: "NEC" };
  const coast = { LINE: "No Jersey Coast", LINEABBREVIATION: "NJCL" };
  const me = { LINE: "Morristown Line", LINEABBREVIATION: "M&E" };
  assert.ok(matchesLine(nec, "Northeast Corridor"));
  assert.ok(matchesLine(nec, "NEC"));
  assert.ok(!matchesLine(coast, "NEC"));
  assert.ok(matchesLine(coast, "North Jersey Coast"));
  assert.ok(matchesLine(coast, "coast"));
  assert.ok(matchesLine(me, "morris and essex"));
  assert.ok(matchesLine(me, "M&E"));
  assert.ok(!matchesLine(me, "raritan"));
});
