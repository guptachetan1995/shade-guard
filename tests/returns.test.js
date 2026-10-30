import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { deltaE00 } from "../src/color/ciede2000.js";
import { loadFixtures } from "../src/fixtures.js";
import { makeApp, photo } from "./helpers.js";

test("R-104's attached reading is consistent with the catalogue: 245W ΔE00 2.1, 220N 5.0", () => {
  const { catalogue, returns } = loadFixtures();
  const r104 = returns.returnCases.find((c) => c.caseId === "R-104");
  const tint = catalogue.products.find((p) => p.productId === "skin-tint");
  for (const { code, de00 } of r104.reading.ranking) {
    const actual = deltaE00(r104.reading.lab, tint.shades.find((s) => s.code === code).lab);
    assert.ok(Math.abs(actual - de00) < 0.01, `${code}: ${actual} vs ${de00}`);
  }
  assert.deepEqual([r104.reading.draftDecision, r104.reading.shopperOutcome], ["swap", "keep_my_shade"]);
});

test("R-104: the agent drafts an exchange for 245W citing the overridden reading; staff approve it", async () => {
  const app = await makeApp();
  const { plan } = await runPlanner(app.invoke, { caseId: "R-104" });
  assert.equal(plan.outcome, "resolution:exchange");
  const rcase = app.store.getCase("R-104");
  assert.deepEqual(rcase.draft.evidence, { deltaE: { "220N": 5.0, "245W": 2.1 } });
  assert.equal(
    rcase.draft.summary,
    "Exchange for 245W: the reading on the order put 245W at ΔE00 2.1 and the returned 220N at 5.0. The shopper kept the cart shade at checkout.",
  );
  assert.equal(rcase.status, "drafted", "drafted, not approved");
  const stock = app.store.getShade("skin-tint", "245W").stock;
  const r = await app.invoke("approve_exchange", { caseId: "R-104" }, "staff");
  assert.equal(r.ok, true);
  assert.equal(rcase.status, "exchange_approved");
  assert.equal(app.store.getShade("skin-tint", "245W").stock, stock - 1, "a simulated replacement");
  assert.equal((await app.invoke("draft_return_resolution", { caseId: "R-104", resolution: "refund", evidence: { reason: "no_reading" } }, "agent")).error.code, "case_closed");
});

test("R-104: drafts that don't match the reading are refused", async () => {
  const app = await makeApp();
  const draft = (args) => app.invoke("draft_return_resolution", { caseId: "R-104", ...args }, "agent");
  assert.equal((await draft({ resolution: "exchange", shadeCode: "245W", evidence: { deltaE: { "220N": 4.0, "245W": 2.1 } } })).error.code, "evidence_mismatch");
  assert.equal((await draft({ resolution: "exchange", shadeCode: "250W", evidence: { deltaE: { "220N": 5.0, "250W": 3.51 } } })).error.code, "evidence_mismatch");
  assert.equal((await draft({ resolution: "refund", evidence: { reason: "no_match" } })).error.code, "reading_supports_exchange");
  assert.equal(app.store.getCase("R-104").draft, null);
});

test("R-107: an exchange is refused as no_reading until the shopper's check; after it, the exchange is drafted", async () => {
  const app = await makeApp();
  const before = await app.invoke("draft_return_resolution", { caseId: "R-107", resolution: "exchange", shadeCode: "245W", evidence: { deltaE: {} } }, "agent");
  assert.equal(before.error.code, "no_reading");
  assert.equal((await app.invoke("start_check", { photo: photo(), capture: "upload", caseId: "R-107" }, "agent")).error.code, "wrong_actor", "the agent can't start the check");
  const waiting = await runPlanner(app.invoke, { caseId: "R-107" });
  assert.equal(waiting.plan.outcome, "awaiting_shopper_check");

  const s = await app.invoke("start_check", { photo: photo(), capture: "upload", caseId: "R-107" }, "shopper");
  await runPlanner(app.invoke, { checkId: s.result.checkId, caseId: "R-107" });
  const rcase = app.store.getCase("R-107");
  assert.equal(rcase.reading.checkId, s.result.checkId);
  assert.deepEqual(rcase.reading.ranking.slice(0, 3), [
    { code: "245W", de00: 1.93 },
    { code: "250W", de00: 3.1 },
    { code: "220N", de00: 4.62 },
  ]);
  assert.deepEqual([rcase.draft.resolution, rcase.draft.shadeCode], ["exchange", "245W"]);
  assert.deepEqual(rcase.draft.evidence, { deltaE: { "220N": 4.62, "245W": 1.93 } });
});

test("staff can refund without a draft; exchange approval needs a drafted exchange", async () => {
  const app = await makeApp();
  assert.equal((await app.invoke("approve_exchange", { caseId: "R-107" }, "staff")).error.code, "no_exchange_draft");
  const r = await app.invoke("approve_refund", { caseId: "R-107" }, "staff");
  assert.equal(r.ok, true);
  assert.deepEqual([r.result.status, r.result.approval.withDraft, r.result.approval.simulated], ["refund_approved", false, true]);
  assert.equal((await app.invoke("approve_refund", { caseId: "R-107" }, "staff")).error.code, "case_closed");
});

test("list_return_cases filters by status and shows numbers only", async () => {
  const app = await makeApp();
  const r = await app.invoke("list_return_cases", { status: "awaiting_check" }, "agent");
  assert.deepEqual(r.result.cases.map((c) => c.caseId), ["R-107"]);
  const all = await app.invoke("list_return_cases", {}, "agent");
  assert.deepEqual(all.result.cases.map((c) => c.caseId), ["R-104", "R-107"]);
});
