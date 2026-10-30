import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { merchantSummary } from "../src/merchant.js";
import { gapDirection } from "../src/rules/range-gap.js";
import { makeApp, startCartCheck } from "./helpers.js";

const GAP_KEYS = ["at", "chroma", "delta", "direction", "hueAngle", "lab", "nearest", "productId"];

async function checkAndDecide(app) {
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  // Keeping every shade leaves the cart as it was, so each check sees the same three lines.
  for (const lineId of ["L1", "L2", "L3"]) {
    assert.equal((await app.invoke("keep_my_shade", { checkId, lineId, reason: "test" }, "shopper")).ok, true);
  }
  return checkId;
}

test("a no_match becomes a range-gap entry: numbers only, with a direction label", async () => {
  const app = await makeApp();
  await checkAndDecide(app);
  const [gap] = app.store.state.rangeGaps;
  assert.deepEqual(Object.keys(gap).sort(), GAP_KEYS);
  assert.equal(gap.productId, "cushion");
  assert.deepEqual(gap.lab, [64.12, 10.41, 17.97]);
  assert.deepEqual(gap.nearest, { code: "C5", de00: 7.39 });
  assert.equal(gap.direction, "deeper, warmer");
  assert.ok(gap.delta.dL < 0 && gap.delta.dh > 0);
});

test("the direction label reads each axis", () => {
  assert.equal(gapDirection([60, 10, 20], [70, 12, 12]).label, "deeper, warmer");
  assert.equal(gapDirection([75, 12, 12], [65, 10, 20]).label, "lighter, cooler");
  assert.equal(gapDirection([65, 20, 34.6], [65, 10, 17.3]).label, "more saturated");
  assert.equal(gapDirection([65, 10, 17.3], [65.5, 10.1, 17.4]).label, "close in depth and hue");
});

test("the merchant panel: outcomes, units per check against the cap, and the range-gap sentence", async () => {
  const app = await makeApp();
  for (let i = 0; i < 3; i++) await checkAndDecide(app);
  const m = merchantSummary(app.store.state);
  assert.equal(m.unitCapPerCheck, 40);
  assert.equal(m.unitsSpentTotal, 108);
  assert.deepEqual(m.checksByOutcome, { keep: 0, swap: 3, sample_duo: 3, no_match: 3, retake: 0, unavailable: 0 });
  assert.deepEqual(m.unitsPerCheck.map((c) => c.units), [36, 36, 36]);
  assert.deepEqual(m.unitsPerCheck[0].outcomes, { L1: "swap", L2: "sample_duo", L3: "no_match" });
  assert.deepEqual(m.rangeGaps, [
    {
      productId: "cushion",
      count: 3,
      nearestCodes: ["C5"],
      directions: ["deeper, warmer"],
      sentence: "Cushion Compact: 3 readings with no shade within ΔE00 6, all deeper and warmer than C5",
    },
  ]);
});

test("only the merchant changes the cap, and a new cap prices the next check", async () => {
  const app = await makeApp();
  assert.equal((await app.invoke("set_unit_cap", { unitsPerCheck: 60 }, "merchant")).result.before, 40);
  const checkId = await startCartCheck(app);
  const b = await app.invoke("get_unit_budget", { checkId }, "agent");
  assert.deepEqual([b.result.unitCapPerCheck, b.result.price.fullPath, b.result.linesAffordable], [60, 38, 3]);
  assert.equal((await app.invoke("set_unit_cap", { unitsPerCheck: -1 }, "merchant")).error.code, "bad_args");
});
