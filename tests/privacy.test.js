import { test } from "node:test";
import assert from "node:assert/strict";
import { runPlanner } from "../src/agent/planner.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { closeCheck, closeIdleChecks, settlePendingDeletes, IDLE_CLOSE_MS } from "../src/check-lifecycle.js";
import { YouCamProvider } from "../src/providers/youcam-live.js";
import { makeApp, noWait, photo, startCartCheck } from "./helpers.js";
import { startYouCamMock } from "./youcam-mock.js";

async function decideAll(app, checkId) {
  await app.invoke("apply_draft", { checkId, lineId: "L1" }, "shopper");
  await app.invoke("apply_draft", { checkId, lineId: "L2" }, "shopper");
  return app.invoke("apply_draft", { checkId, lineId: "L3" }, "shopper");
}

test("closing a check deletes every task, confirms each, and drops the cached photo and renders", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  assert.equal(app.store.blobs.get(checkId).renders.size, 7);
  const last = await decideAll(app, checkId);
  const check = app.store.getCheck(checkId);
  assert.equal(check.status, "closed");
  assert.equal(check.closeReason, "every_line_settled");
  assert.equal(app.store.blobs.has(checkId), false, "photo and renders dropped");
  const { tasks, files } = app.provider.inspect();
  assert.equal(tasks.length, 9);
  assert.ok(tasks.every((t) => t.deleted), "every YouCam task deleted");
  assert.ok(files.every((f) => f.deleted), "the uploaded photo went with them");
  assert.ok(check.tasks.every((t) => t.deletedAt), "each deletion confirmed by a status read");
  assert.deepEqual(
    { ...last.result.privacyReceipt, confirmedAt: Boolean(last.result.privacyReceipt.confirmedAt) },
    {
      deletedTasks: 9,
      pending: 0,
      confirmedAt: true,
      localPhotoDropped: true,
      photoOnYouCam: "deleted_with_tasks",
      note: "Every analysis task was deleted on YouCam's servers, which removes the uploaded photo, and this store's copy is deleted.",
    },
  );
  assert.deepEqual(
    app.store.state.cart.lines.map((l) => [l.lineId, l.shadeCode, l.sampleDuo?.sku ?? null]),
    [
      ["L1", "245W", null],
      ["L2", null, "serum-duo"],
      ["L4", null, null],
    ],
    "the shopper's clicks, not the agent, changed the cart",
  );
});

test("the receipt when the photo was uploaded but no task started: it stays up to 30 days, and says why", async () => {
  const app = await makeApp({ provider: new FakeYouCamProvider({ failCreate: { "skin-tone-analysis": "CreditInsufficiency" } }) });
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  const check = app.store.getCheck(checkId);
  assert.equal(check.status, "closed");
  assert.equal(check.privacyReceipt.photoOnYouCam, "kept_up_to_30_days");
  assert.match(check.privacyReceipt.note, /no analysis started \(CreditInsufficiency\).*up to 30 days/);
});

test("the receipt when the photo was never sent", async () => {
  const app = await makeApp({ unitCapPerCheck: 31 });
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  const check = app.store.getCheck(checkId);
  assert.equal(check.status, "closed");
  assert.equal(check.privacyReceipt.photoOnYouCam, "never_uploaded");
  assert.equal(app.store.blobs.has(checkId), false);
});

test("a task still running at close is pending, then deleted once it finishes", async () => {
  const provider = new FakeYouCamProvider({ slow: { "makeup-vto": 3 } });
  const app = await makeApp({ provider });
  const checkId = await startCartCheck(app);
  await app.invoke("measure_complexion", { checkId }, "agent");
  const check = app.store.getCheck(checkId);
  // A render the shopper stopped waiting for: created, never polled to the end.
  const { taskId } = await provider.runTask("makeup-vto", { src_file_id: check.fileId });
  check.tasks.push({ taskId, feature: "makeup-vto", units: 0, deletedAt: null, pending: false });
  await closeCheck(app.store, provider, check, "shopper_left");
  assert.deepEqual([check.privacyReceipt.deletedTasks, check.privacyReceipt.pending, check.privacyReceipt.photoOnYouCam], [2, 1, "pending"]);
  assert.equal(check.privacyReceipt.confirmedAt, null);
  await settlePendingDeletes(app.store, provider); // poll 1: running
  await settlePendingDeletes(app.store, provider); // poll 2: running
  assert.equal(check.privacyReceipt.pending, 1);
  await settlePendingDeletes(app.store, provider); // poll 3: finished, deleted
  assert.deepEqual([check.privacyReceipt.deletedTasks, check.privacyReceipt.pending, check.privacyReceipt.photoOnYouCam], [3, 0, "deleted_with_tasks"]);
  assert.ok(provider.inspect().tasks.every((t) => t.deleted));
});

test("an idle check closes after 15 minutes", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  const last = Date.parse(app.store.getCheck(checkId).lastActivityAt);
  await closeIdleChecks(app.store, app.provider, last + IDLE_CLOSE_MS - 1);
  assert.equal(app.store.getCheck(checkId).status, "open");
  await closeIdleChecks(app.store, app.provider, last + IDLE_CLOSE_MS);
  assert.equal(app.store.getCheck(checkId).status, "closed");
  assert.equal(app.store.getCheck(checkId).closeReason, "idle");
});

const PHOTOISH_KEYS = /photo|image|bytes|base64|render|fileId|file_id|url/i;

function assertNumbersOnly(value, where) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") assert.ok(value.length < 300, `${where} holds a long string`);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    assert.doesNotMatch(k, PHOTOISH_KEYS, `${where}.${k}`);
    assertNumbersOnly(v, `${where}.${k}`);
  }
}

test("a return case's reading and a range gap carry numbers only", async () => {
  const app = await makeApp();
  const s = await app.invoke("start_check", { photo: photo("outside-range"), capture: "upload", caseId: "R-107" }, "shopper");
  await runPlanner(app.invoke, { checkId: s.result.checkId, caseId: "R-107" });
  const rcase = app.store.getCase("R-107");
  assert.ok(rcase.reading, "the case now carries a reading");
  for (const c of app.store.state.returnCases) assertNumbersOnly(c, c.caseId);
  assert.equal(app.store.state.rangeGaps.length, 1);
  app.store.state.rangeGaps.forEach((g, i) => assertNumbersOnly(g, `rangeGaps[${i}]`));
});

test("the state the page reads never holds the photo, even while the check is open", async () => {
  const app = await makeApp();
  const b64 = photo();
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  const json = JSON.stringify(app.store.snapshot());
  assert.equal(json.includes(b64), false);
  assert.equal(json.includes(b64.slice(10, 40)), false);
  assert.ok(app.store.blobs.get(checkId).photo instanceof Uint8Array, "the bytes live only in the blob map");
});

test("in 'Live with your own key', the key never appears in state, the activity log or an error", async () => {
  const ownKey = "visitor-own-key-5e4d3c2b1a09-never-real";
  const mock = await startYouCamMock({ key: ownKey });
  try {
    const provider = new YouCamProvider({ apiKey: ownKey, apiBase: mock.url, mode: "live-own-key", pacer: { take: async () => {}, backoff() {} }, wait: noWait });
    const app = await makeApp({ provider });
    const checkId = await startCartCheck(app);
    mock.inject("GET", "/s2s/v1.0/client/credit", 401, { status: 401, error_code: "InvalidApiKey" });
    const refused = await app.invoke("measure_complexion", { checkId }, "agent");
    assert.deepEqual(refused.error, { code: "InvalidApiKey", message: "The API key was not accepted." });
    const { transcript } = await runPlanner(app.invoke, { checkId });
    assert.equal(app.store.getCheck(checkId).complexion.skinHex, "#B9947C", "the same check then ran on the visitor's key");
    const seen = JSON.stringify([refused, transcript, app.store.snapshot(), app.store.state.activityLog, provider, provider.requestLog()]);
    assert.equal(seen.includes(ownKey), false);
    assert.ok(mock.apiRequests().every((r) => r.headers.authorization === `Bearer ${ownKey}`), "sent only as the bearer header");
  } finally {
    await mock.close();
  }
});
