import { test } from "node:test";
import assert from "node:assert/strict";
import { carCrowding } from "../src/tools.ts";

test("carCrowding finds the emptiest end, cars and restrooms", () => {
  const c = carCrowding([
    {
      CUR_PERCENTAGE: "60",
      SECTIONS: [
        { SECTION_POSITION: 0, CUR_PERCENTAGE: "85", CARS: [{ CAR_POSITION: 1, CUR_PERCENTAGE: 90 }, { CAR_POSITION: 2, CUR_PERCENTAGE: "80", CAR_REST: "Y" }] },
        { SECTION_POSITION: "1", CARS: [{ CAR_POSITION: "3", CUR_PERCENTAGE: "60" }, { CAR_POSITION: "4", CUR_PERCENTAGE: "50" }] },
        { SECTION_POSITION: "Back", CUR_PERCENTAGE: "20", CARS: [{ CAR_POSITION: "5", CUR_PERCENTAGE: "25", CAR_REST: true }, { CAR_POSITION: "6", CUR_PERCENTAGE: "15" }] },
      ],
    },
  ])!;
  assert.deepEqual(c.sections, [
    { section: "front", percent: 85 },
    { section: "middle", percent: 55 }, // no section figure, so the average of its cars
    { section: "back", percent: 20 },
  ]);
  assert.equal(c.emptiest, "back");
  assert.equal(c.even, false);
  assert.deepEqual(c.emptiestCars, [{ position: 6, percent: 15 }, { position: 5, percent: 25 }]);
  assert.deepEqual(c.restroomCars, [2, 5]);
});

test("carCrowding says even when the ends are close, and null with no sections", () => {
  const c = carCrowding([{ SECTIONS: [{ SECTION_POSITION: "Front", CUR_PERCENTAGE: "40" }, { SECTION_POSITION: "Back", CUR_PERCENTAGE: "46" }] }])!;
  assert.equal(c.even, true);
  assert.equal(carCrowding([{ CUR_PERCENTAGE: "50" }]), null);
  assert.equal(carCrowding(undefined), null);
});
