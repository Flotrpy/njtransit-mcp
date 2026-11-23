import { test } from "node:test";
import assert from "node:assert/strict";
import { headsToNewYork } from "../src/tools.ts";

const base = { SCHED_DEP_DATE: "18-Nov-2026 05:10:00 PM", TRAIN_ID: "1" };

test("headsToNewYork uses DIRECTION, then destination, then stops", () => {
  assert.equal(headsToNewYork({ ...base, DESTINATION: "Trenton", DIRECTION: "Eastbound" }, "MP"), true);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "New York", DIRECTION: "Westbound" }, "MP"), false);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "New York -SEC" }, "MP"), true);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "Hoboken" }, "ST"), true);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "Long Branch" }, "RH"), false);
  const stops = [
    { STATION_2CHAR: "TR", STATIONNAME: "Trenton" },
    { STATION_2CHAR: "MP", STATIONNAME: "Metropark" },
    { STATION_2CHAR: "NY", STATIONNAME: "New York Penn Station" },
  ];
  assert.equal(headsToNewYork({ ...base, DESTINATION: "", STOPS: stops }, "MP"), true);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "", STOPS: [...stops].reverse() }, "MP"), false);
  assert.equal(headsToNewYork({ ...base, DESTINATION: "" }, "MP"), null);
});
