import { test } from "node:test";
import assert from "node:assert/strict";
import { headsToNewYork, isAmtrak } from "../src/tools.ts";

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

test("isAmtrak spots Amtrak by line name, code or train number", () => {
  assert.equal(isAmtrak({ TRAIN_ID: "A2151", LINE: "AMTRAK" }), true);
  assert.equal(isAmtrak({ TRAIN_ID: "177", LINEABBREVIATION: "AMTK" }), true);
  assert.equal(isAmtrak({ TRAIN_ID: "93", LINECODE: "AM" }), true);
  assert.equal(isAmtrak({ TRAIN_ID: "A42" }), true);
  assert.equal(isAmtrak({ TRAIN_ID: "3855", LINE: "Northeast Corrdr", LINECODE: "NE" }), false);
});
