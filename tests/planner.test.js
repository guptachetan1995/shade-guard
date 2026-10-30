import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner, initialPlan, nextCall, observe } from "../src/agent/planner.js";
import { makeApp, photo, startCartCheck } from "./helpers.js";

const tools = (transcript) => transcript.map((t) => t.tool);
const units = (transcript) => transcript.reduce((n, t) => n + t.units, 0);
const decisions = (check) => Object.fromEntries(Object.entries(check.lines).map(([id, l]) => [id, l.draft?.decision]));

function keepOnly(app, lineIds) {
  app.store.state.cart.lines = app.store.state.cart.lines.filter((l) => lineIds.includes(l.lineId));
}

test("the demo cart: one reading, three outcomes, 36 units, in the planned order", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  const { plan, transcript } = await runPlanner(app.invoke, { checkId });
  assert.deepEqual(tools(transcript), [
    "get_cart",
    "get_unit_budget",
    "measure_complexion",
    "rank_shades",
    "list_shades",
    "rank_shades",
    "list_shades",
    "rank_shades",
    "list_shades",
    ...Array(7).fill("preview_shade"),
    "draft_recommendation",
    "draft_recommendation",
    "draft_recommendation",
  ]);
  assert.ok(transcript.every((t) => t.ok), "no call was refused");
  assert.equal(units(transcript), 36, "29 + 2 + 3 + 2");
  const check = app.store.getCheck(checkId);
  assert.equal(check.unitsSpent, 36);
  assert.deepEqual(decisions(check), { L1: "swap", L2: "sample_duo", L3: "no_match" });
  assert.equal(check.lines.L1.draft.shadeCode, "245W");
  assert.equal(check.lines.L1.draft.finish, "satin");
  assert.deepEqual(check.lines.L2.draft.shadeCodes, ["S14", "S15"]);
  assert.deepEqual(check.lines.L3.draft.nearest, { code: "C5", de00: 7.39, direction: "deeper, warmer" });
  assert.deepEqual(
    Object.values(check.lines).map((l) => l.previews.map((p) => p.shadeCode)),
    [["220N", "245W"], ["S12", "S14", "S15"], ["C3", "C5"]],
  );
  assert.equal(plan.phase, "done");
  assert.equal(check.status, "open", "the check stays open until the shopper decides");
  assert.equal(app.store.getCartLine("L1").shadeCode, "220N", "the agent's drafts changed nothing in the cart");
});

test("keep: the cart shade is the closest, so one render and a keep draft", async () => {
  const app = await makeApp();
  keepOnly(app, ["L1"]);
  app.store.getCartLine("L1").shadeCode = "245W";
  const checkId = await startCartCheck(app);
  const { transcript } = await runPlanner(app.invoke, { checkId });
  assert.equal(units(transcript), 30);
  const line = app.store.getCheck(checkId).lines.L1;
  assert.equal(line.draft.decision, "keep");
  assert.deepEqual(line.draft.evidence, { deltaE: { "245W": 1.93 }, band: 1, previewIds: ["pv_1"] });
});

test("poor lighting widens the band, turning Skin Tint's swap into a sample duo", async () => {
  const app = await makeApp();
  keepOnly(app, ["L1"]);
  const checkId = await startCartCheck(app, "dim-light");
  await runPlanner(app.invoke, { checkId });
  const check = app.store.getCheck(checkId);
  assert.equal(check.complexion.band, 1.5);
  assert.deepEqual(decisions(check), { L1: "sample_duo" });
  assert.deepEqual(check.lines.L1.draft.shadeCodes, ["245W", "250W"]);
});

test("retake: a face-angle error drafts retake with guidance for every line, at 0 units, and closes the check", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app, "angle-up");
  const { transcript } = await runPlanner(app.invoke, { checkId });
  assert.deepEqual(tools(transcript), ["get_cart", "get_unit_budget", "measure_complexion", "draft_recommendation", "draft_recommendation", "draft_recommendation"]);
  assert.equal(units(transcript), 0);
  const check = app.store.getCheck(checkId);
  assert.deepEqual(decisions(check), { L1: "retake", L2: "retake", L3: "retake" });
  assert.equal(check.lines.L1.draft.guidance, "Tilt your head down slightly.");
  assert.equal(check.status, "closed");
});

test("pricing before upload, one line: cap 31 uploads nothing, cap 32 checks it", async () => {
  for (const [cap, expected] of [
    [31, "unavailable"],
    [32, "swap"],
  ]) {
    const app = await makeApp({ unitCapPerCheck: cap });
    keepOnly(app, ["L1"]);
    const checkId = await startCartCheck(app);
    const { transcript } = await runPlanner(app.invoke, { checkId });
    assert.deepEqual(decisions(app.store.getCheck(checkId)), { L1: expected }, `cap ${cap}`);
    const uploads = app.provider.calls.filter((c) => c.method === "uploadPhoto").length;
    assert.equal(uploads, cap === 31 ? 0 : 1, `cap ${cap} uploads`);
    if (cap === 31) {
      assert.deepEqual(tools(transcript), ["get_cart", "get_unit_budget", "draft_recommendation"]);
      assert.deepEqual(app.store.getCheck(checkId).lines.L1.draft.evidence, { remainingUnits: 31, reason: "budget" });
    }
    assert.ok(app.store.getCheck(checkId).unitsSpent <= cap);
  }
});

test("pricing before upload, three lines: cap 37 covers two lines in order, cap 38 covers all three", async () => {
  const a = await makeApp({ unitCapPerCheck: 37 });
  const c37 = await startCartCheck(a);
  await runPlanner(a.invoke, { checkId: c37 });
  assert.deepEqual(decisions(a.store.getCheck(c37)), { L1: "swap", L2: "sample_duo", L3: "unavailable" });
  assert.equal(a.store.getCheck(c37).unitsSpent, 34);
  assert.deepEqual(a.store.getCheck(c37).lines.L3.draft.evidence, { remainingUnits: 3, reason: "budget" });

  const b = await makeApp({ unitCapPerCheck: 38 });
  const c38 = await startCartCheck(b);
  await runPlanner(b.invoke, { checkId: c38 });
  assert.deepEqual(decisions(b.store.getCheck(c38)), { L1: "swap", L2: "sample_duo", L3: "no_match" });
  assert.equal(b.store.getCheck(c38).unitsSpent, 36);
});

test("the store's budget runs out at YouCam: the planner drafts unavailable (credit) for every line", async () => {
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const app = await makeApp({ provider: new FakeYouCamProvider({ balance: 20 }) });
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  const check = app.store.getCheck(checkId);
  assert.deepEqual(decisions(check), { L1: "unavailable", L2: "unavailable", L3: "unavailable" });
  assert.equal(check.lines.L1.draft.evidence.reason, "credit");
  assert.equal(check.fileId, null, "the balance was read before anything was uploaded");
});

test("return flow: the shopper's check on R-107 drafts an exchange for the closest shade", async () => {
  const app = await makeApp();
  const s = await app.invoke("start_check", { photo: photo(), capture: "upload", caseId: "R-107" }, "shopper");
  const { plan, transcript } = await runPlanner(app.invoke, { checkId: s.result.checkId, caseId: "R-107" });
  assert.deepEqual(tools(transcript), [
    "list_return_cases",
    "get_unit_budget",
    "measure_complexion",
    "rank_shades",
    "list_shades",
    "preview_shade",
    "preview_shade",
    "draft_recommendation",
    "list_return_cases",
    "draft_return_resolution",
  ]);
  assert.equal(plan.outcome, "resolution:exchange");
  const rcase = app.store.getCase("R-107");
  assert.equal(rcase.status, "drafted");
  assert.deepEqual([rcase.draft.resolution, rcase.draft.shadeCode], ["exchange", "245W"]);
  assert.equal(app.store.getCheck(s.result.checkId).status, "closed", "a returns check closes once its resolution is drafted");
});

test("return flow: a reading with no shade in range drafts a refund, not an exchange", async () => {
  const app = await makeApp();
  const s = await app.invoke("start_check", { photo: photo("outside-range"), capture: "upload", caseId: "R-107" }, "shopper");
  const { plan } = await runPlanner(app.invoke, { checkId: s.result.checkId, caseId: "R-107" });
  assert.equal(plan.outcome, "resolution:refund");
  const rcase = app.store.getCase("R-107");
  assert.equal(rcase.reading.draftDecision, "no_match");
  assert.deepEqual(rcase.draft.evidence, { reason: "no_match" });
  assert.equal(app.store.state.rangeGaps.length, 1);
});

test("return flow: a retake drafts no resolution, and the case keeps waiting for a readable photo", async () => {
  const app = await makeApp();
  const s = await app.invoke("start_check", { photo: photo("no-face"), capture: "upload", caseId: "R-107" }, "shopper");
  const { plan } = await runPlanner(app.invoke, { checkId: s.result.checkId, caseId: "R-107" });
  assert.equal(plan.outcome, "drafted");
  assert.equal(app.store.getCase("R-107").status, "awaiting_check");
  assert.equal(app.store.getCase("R-107").draft, null);
  assert.equal(app.store.getCheck(s.result.checkId).status, "closed", "the dead-ended check closes and deletes its tasks");
  const again = await app.invoke("start_check", { photo: photo(), capture: "upload", caseId: "R-107" }, "shopper");
  assert.equal(again.ok, true, "the shopper's next photo starts a new check at once");
});

test("nextCall and observe are pure", () => {
  const plan = initialPlan({ checkId: "chk_01" });
  const frozen = structuredClone(plan);
  const call = nextCall(plan);
  assert.deepEqual(call, { tool: "get_cart", args: {} });
  const next = observe(plan, call, { ok: true, units: 0, result: { lines: [{ lineId: "L1", productId: "skin-tint", complexion: true, shadeCode: "220N", finish: "satin" }] } });
  assert.deepEqual(plan, frozen, "observe did not mutate its input");
  assert.equal(next.phase, "budget");
  assert.deepEqual(nextCall(next), { tool: "get_unit_budget", args: { checkId: "chk_01" } });
  assert.deepEqual(nextCall(next), nextCall(next), "same plan, same call");
});
