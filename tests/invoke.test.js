import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, photo, startCartCheck } from "./helpers.js";

const providerCalls = (app) => app.provider.calls.map((c) => c.method);

test("an unknown or missing actor is refused, and the refusal is logged", async () => {
  const app = await makeApp();
  for (const actor of ["admin", undefined, "Agent"]) {
    const r = await app.invoke("get_cart", {}, actor);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "unknown_actor");
  }
  assert.deepEqual(
    app.store.state.activityLog.map((e) => [e.actor, e.result, e.code]),
    [
      ["admin", "refused", "unknown_actor"],
      ["undefined", "refused", "unknown_actor"],
      ["Agent", "refused", "unknown_actor"],
    ],
  );
});

test("each human verb accepts only its own actor", async () => {
  const app = await makeApp();
  const wrong = [
    ["approve_refund", { caseId: "R-104" }, "shopper"],
    ["approve_exchange", { caseId: "R-104" }, "merchant"],
    ["start_check", { photo: photo(), capture: "upload" }, "staff"],
    ["set_unit_cap", { unitsPerCheck: 100 }, "staff"],
    ["keep_my_shade", { checkId: "chk_01", lineId: "L1" }, "merchant"],
  ];
  for (const [verb, args, actor] of wrong) {
    const r = await app.invoke(verb, args, actor);
    assert.equal(r.error?.code, "wrong_actor", `${actor} → ${verb}`);
  }
  assert.equal(app.store.state.checks.length, 0);
  assert.equal(app.store.getCase("R-104").status, "open");
  assert.equal(app.store.state.budget.unitCapPerCheck, 40);
});

test("an unknown tool is refused", async () => {
  const app = await makeApp();
  const r = await app.invoke("delete_photo", {}, "agent");
  assert.equal(r.error.code, "unknown_tool");
});

test("the unit cap refuses measure_complexion before the provider is called", async () => {
  const app = await makeApp();
  assert.equal((await app.invoke("set_unit_cap", { unitsPerCheck: 31 }, "merchant")).ok, true);
  const checkId = await startCartCheck(app);
  const before = providerCalls(app).length;
  const r = await app.invoke("measure_complexion", { checkId }, "agent");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unit_cap");
  assert.deepEqual([r.error.needed, r.error.spent, r.error.cap], [32, 0, 31]);
  assert.equal(providerCalls(app).length, before, "no provider call at all");
  assert.equal(app.store.getCheck(checkId).fileId, null, "nothing uploaded");
});

test("the unit cap refuses a render that would pass it, before the provider is called", async () => {
  const app = await makeApp({ unitCapPerCheck: 32 });
  const checkId = await startCartCheck(app);
  assert.equal((await app.invoke("measure_complexion", { checkId }, "agent")).units, 29);
  await app.invoke("rank_shades", { checkId, productId: "skin-tint" }, "agent");
  for (const shadeCode of ["220N", "245W", "250W"]) {
    assert.equal((await app.invoke("preview_shade", { checkId, productId: "skin-tint", shadeCode, finish: "satin" }, "agent")).ok, true);
  }
  const before = providerCalls(app).length;
  const r = await app.invoke("preview_shade", { checkId, productId: "skin-tint", shadeCode: "280N", finish: "satin" }, "agent");
  assert.equal(r.error.code, "unit_cap");
  assert.equal(providerCalls(app).length, before);
  const cached = await app.invoke("preview_shade", { checkId, productId: "skin-tint", shadeCode: "245W", finish: "satin" }, "agent");
  assert.equal(cached.ok, true, "a cached render costs nothing, so the cap doesn't stop it");
  assert.equal(cached.result.cached, true);
});

test("smuggled cart and status fields are refused and logged, not dropped", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  const cartBefore = structuredClone(app.store.state.cart);
  const r1 = await app.invoke(
    "draft_recommendation",
    { checkId, lineId: "L1", decision: "keep", evidence: {}, cart: { lines: [] } },
    "agent",
  );
  assert.equal(r1.error.code, "smuggled_field");
  assert.deepEqual(r1.error.fields, ["cart"]);
  const r2 = await app.invoke("measure_complexion", { checkId, status: "closed" }, "agent");
  assert.equal(r2.error.code, "smuggled_field");
  assert.deepEqual(app.store.state.cart, cartBefore);
  assert.equal(app.store.getCheck(checkId).status, "open");
  const logged = app.store.state.activityLog.filter((e) => e.code === "smuggled_field");
  assert.deepEqual(
    logged.map((e) => [e.actor, e.tool, e.fields]),
    [
      ["agent", "draft_recommendation", ["cart"]],
      ["agent", "measure_complexion", ["status"]],
    ],
  );
  assert.deepEqual(logged[0].args.cart, { lines: [] }, "the log shows what was smuggled");
});

test("missing or mistyped arguments are refused", async () => {
  const app = await makeApp();
  assert.equal((await app.invoke("list_shades", {}, "agent")).error.code, "bad_args");
  assert.equal((await app.invoke("list_shades", { productId: 7 }, "agent")).error.code, "bad_args");
  assert.equal((await app.invoke("set_unit_cap", { unitsPerCheck: 2.5 }, "merchant")).error.code, "bad_args");
  assert.equal((await app.invoke("list_return_cases", { status: "lost" }, "agent")).error.code, "bad_args");
  assert.equal((await app.invoke("get_cart", null, "agent")).ok, true, "no arguments reads as {}");
});

test("every call is logged with its actor and the units it spent; the photo itself is never logged", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  await app.invoke("get_cart", {}, "agent");
  await app.invoke("measure_complexion", { checkId }, "agent");
  await app.invoke("rank_shades", { checkId, productId: "skin-tint" }, "agent");
  await app.invoke("preview_shade", { checkId, productId: "skin-tint", shadeCode: "245W", finish: "satin" }, "agent");
  await app.invoke("approve_refund", { caseId: "R-104" }, "agent");
  assert.deepEqual(
    app.store.state.activityLog.map((e) => [e.actor, e.tool, e.result, e.units]),
    [
      ["shopper", "start_check", "ok", 0],
      ["agent", "get_cart", "ok", 0],
      ["agent", "measure_complexion", "ok", 29],
      ["agent", "rank_shades", "ok", 0],
      ["agent", "preview_shade", "ok", 1],
      ["agent", "approve_refund", "refused", 0],
    ],
  );
  const start = app.store.state.activityLog[0];
  assert.match(start.args.photo, /^\[photo, \d+ base64 characters, not logged\]$/);
  for (const e of app.store.state.activityLog) assert.ok(e.at, "every entry is timestamped");
  assert.equal(app.store.state.budget.unitsSpentTotal, 30);
});

test("a provider error comes back as a result with the shopper's sentence, and is logged", async () => {
  const { FakeYouCamProvider } = await import("../src/providers/youcam-fake.js");
  const app = await makeApp({ provider: new FakeYouCamProvider({ invalidKey: true }) });
  const checkId = await startCartCheck(app);
  const r = await app.invoke("measure_complexion", { checkId }, "agent");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "InvalidAccessToken");
  assert.equal(r.error.message, "The API key was not accepted.");
  assert.equal(app.store.state.activityLog.at(-1).result, "error");
});

test("draft_recommendation refuses evidence that doesn't match the check, and decisions the rules don't support", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  await app.invoke("measure_complexion", { checkId }, "agent");
  await app.invoke("rank_shades", { checkId, productId: "skin-tint" }, "agent");
  const draft = (args) => app.invoke("draft_recommendation", { checkId, lineId: "L1", ...args }, "agent");
  const good = { deltaE: { "220N": 4.62, "245W": 1.93 }, band: 1, previewIds: [] };
  assert.equal((await draft({ decision: "keep", evidence: { deltaE: { "220N": 4.62 }, band: 1 } })).error.code, "decision_unsupported");
  assert.equal((await draft({ decision: "swap", shadeCode: "250W", evidence: good })).error.code, "decision_unsupported");
  assert.equal((await draft({ decision: "swap", shadeCode: "245W", evidence: { ...good, deltaE: { "220N": 4.0, "245W": 1.93 } } })).error.code, "evidence_mismatch");
  assert.equal((await draft({ decision: "swap", shadeCode: "245W", evidence: { ...good, band: 0.5 } })).error.code, "evidence_mismatch");
  assert.equal((await draft({ decision: "swap", shadeCode: "245W", evidence: { ...good, previewIds: ["pv_99"] } })).error.code, "evidence_mismatch");
  assert.equal((await draft({ decision: "retake", evidence: { errorCode: "error_no_face" } })).error.code, "decision_unsupported");
  assert.equal(app.store.getCheck(checkId).lines.L1.draft, null);
  const ok = await draft({ decision: "swap", shadeCode: "245W", evidence: good });
  assert.equal(ok.ok, true);
  assert.equal(app.store.getCartLine("L1").shadeCode, "220N", "a draft never changes the cart");
  assert.equal((await app.invoke("keep_my_shade", { checkId, lineId: "L1" }, "shopper")).ok, true);
  assert.equal((await draft({ decision: "swap", shadeCode: "245W", evidence: good })).error.code, "line_decided");
});
