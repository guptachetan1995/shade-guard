// The 90-second "still working, stop waiting" path (§6): the fake provider's slow-analyser
// keeps its tone analysis running; once it has run STILL_WORKING_MS by the store's clock, the
// shopper may stop waiting. The check closes, its running task goes to the background
// clean-up, and the receipt reads pending, then done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { runPlanner } from "../src/agent/planner.js";
import { settlePendingDeletes, STILL_WORKING_MS } from "../src/check-lifecycle.js";
import { photo } from "./helpers.js";

const tickOnce = () => new Promise((r) => setImmediate(r));

async function slowCheck({ caseId } = {}) {
  let t = Date.parse("2026-10-30T12:00:00.000Z");
  const clock = { now: () => new Date(t).toISOString(), advance: (ms) => (t += ms) };
  const provider = new FakeYouCamProvider();
  const app = await createApp({ provider, now: clock.now, wait: tickOnce });
  const s = await app.invoke("start_check", { photo: photo("slow-analyser"), capture: "upload", ...(caseId ? { caseId } : {}) }, "shopper");
  const checkId = s.result.checkId;
  const run = runPlanner(app.invoke, { checkId, caseId });
  const check = app.store.getCheck(checkId);
  while (!check.tasks.some((x) => x.status === "running")) await tickOnce();
  return { app, provider, clock, check, checkId, run };
}

test("stop_waiting is refused before the task has run 90 s, and for the agent; after 90 s the check closes and cleanup is pending, then done", async () => {
  const { app, provider, clock, check, checkId, run } = await slowCheck();

  const early = await app.invoke("stop_waiting", { checkId }, "shopper");
  assert.equal(early.error.code, "not_still_working");
  clock.advance(STILL_WORKING_MS - 1000);
  assert.equal((await app.invoke("stop_waiting", { checkId }, "shopper")).error.code, "not_still_working");
  clock.advance(1000);
  assert.equal((await app.invoke("stop_waiting", { checkId }, "agent")).error.code, "wrong_actor", "only the shopper stops waiting");
  assert.equal(check.status, "open");

  const stop = await app.invoke("stop_waiting", { checkId }, "shopper");
  assert.deepEqual([stop.ok, stop.units], [true, 0]);
  const { plan } = await run;
  assert.equal(plan.outcome, "stopped_waiting");
  assert.deepEqual([check.status, check.closeReason], ["closed", "stopped_waiting"]);
  assert.ok(Object.values(check.lines).every((l) => !l.draft), "nothing was drafted");
  assert.deepEqual(app.store.state.cart.lines.map((l) => l.shadeCode), ["220N", "S12", "C3", null], "the cart is unchanged");
  assert.equal(app.store.blobs.has(checkId), false, "the store's copy of the photo is gone at once");
  const pending = check.privacyReceipt;
  assert.deepEqual([pending.pending, pending.photoOnYouCam, pending.confirmedAt], [1, "pending", null]);
  assert.match(pending.note, /1 analysis task is still finishing; each is deleted, with your photo, as soon as it ends/);

  await settlePendingDeletes(app.store, provider);
  const done = check.privacyReceipt;
  assert.deepEqual([done.pending, done.deletedTasks, done.photoOnYouCam], [0, 1, "deleted_with_tasks"]);
  assert.ok(done.confirmedAt);
  assert.ok(provider.inspect().tasks.every((x) => x.deleted), "the task that finished after the shopper stopped waiting was deleted");
  assert.ok(provider.inspect().files.every((f) => f.deleted), "and the uploaded photo with it");

  const log = app.store.state.activityLog.filter((e) => e.tool === "stop_waiting").map((e) => [e.actor, e.result, e.code ?? null, e.units]);
  assert.deepEqual(log, [["shopper", "refused", "not_still_working", 0], ["shopper", "refused", "not_still_working", 0], ["agent", "refused", "wrong_actor", 0], ["shopper", "ok", null, 0]]);
});

test("a return-page check can be stopped too; the case still waits for the shopper's check", async () => {
  const { app, clock, check, checkId, run } = await slowCheck({ caseId: "R-107" });
  clock.advance(STILL_WORKING_MS);
  assert.equal((await app.invoke("stop_waiting", { checkId }, "shopper")).ok, true);
  assert.equal((await run).plan.outcome, "stopped_waiting");
  assert.equal(check.status, "closed");
  assert.equal(app.store.getCase("R-107").status, "awaiting_check");
  assert.equal((await app.invoke("stop_waiting", { checkId }, "shopper")).error.code, "check_closed");
});
