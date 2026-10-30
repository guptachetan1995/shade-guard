import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { RecordedYouCamProvider } from "../src/providers/youcam-recorded.js";
import { assertProvider, loadFeatureCosts } from "../src/providers/provider.js";
import { messageFor, YouCamError } from "../src/providers/errors.js";
import { fakePhoto } from "../src/providers/fake-photos.js";
import { runTaskToEnd } from "../src/tasks.js";
import { makeApp, noWait, startCartCheck } from "./helpers.js";

const tone = (fileId) => ({ src_file_id: fileId, face_angle_strictness_level: "high" });

test("fake lifecycle: running for N polls, then success; units charged only on success", async () => {
  const p = new FakeYouCamProvider({ pollsUntilDone: 3 });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  const { taskId } = await p.runTask("skin-tone-analysis", tone(fileId));
  assert.deepEqual(await p.pollTask("skin-tone-analysis", taskId), { status: "running", unitsCharged: 0 });
  assert.equal((await p.pollTask("skin-tone-analysis", taskId)).status, "running");
  assert.equal(p.balance, 1000);
  const done = await p.pollTask("skin-tone-analysis", taskId);
  assert.equal(done.status, "success");
  assert.equal(done.unitsCharged, 20);
  assert.equal(done.result.synthetic, true, "fake results say they are synthetic");
  assert.equal(done.result.color.skin_color, "#B9947C");
  assert.equal(p.balance, 980);
  assert.equal((await p.pollTask("skin-tone-analysis", taskId)).unitsCharged, 20, "a re-read doesn't charge twice");
  assert.equal(p.balance, 980);
});

test("fake: a face-angle error costs 0 units", async () => {
  const p = new FakeYouCamProvider();
  const { fileId } = await p.uploadPhoto(fakePhoto("angle-up"), "image/jpeg");
  const r = await runTaskToEnd(p, "skin-tone-analysis", tone(fileId), { wait: noWait, onCreated() {} });
  assert.deepEqual([r.status, r.error, r.unitsCharged], ["error", "error_face_angle_upward", 0]);
  assert.equal(p.balance, 1000);
  assert.equal(messageFor(r.error), "Tilt your head down slightly.");
});

test("fake: CreditInsufficiency when the balance can't cover the task", async () => {
  const p = new FakeYouCamProvider({ balance: 19 });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  await assert.rejects(p.runTask("skin-tone-analysis", tone(fileId)), { code: "CreditInsufficiency" });
  assert.equal(messageFor("CreditInsufficiency"), "This store's try-on budget is used up.");
});

test("InvalidApiKey and InvalidAccessToken both read as 'the API key was not accepted'", async () => {
  const p = new FakeYouCamProvider({ invalidKey: true });
  await assert.rejects(p.getBalance(), (e) => e instanceof YouCamError && e.code === "InvalidAccessToken" && e.status === 401);
  assert.equal(messageFor("InvalidApiKey"), "The API key was not accepted.");
  assert.equal(messageFor("InvalidAccessToken"), messageFor("InvalidApiKey"));
});

test("a 429 is retried with backoff, then the task succeeds", async () => {
  const p = new FakeYouCamProvider({ rateLimitOnce: true });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  const waits = [];
  const r = await runTaskToEnd(p, "skin-tone-analysis", tone(fileId), { wait: async (ms) => waits.push(ms), onCreated() {} });
  assert.equal(r.status, "success");
  assert.deepEqual(waits, [1000]);
  assert.equal(p.calls.filter((c) => c.method === "runTask").length, 2);
});

test("polling backs off from 2 s by ×1.5 up to 10 s", async () => {
  const p = new FakeYouCamProvider({ pollsUntilDone: 7 });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  const waits = [];
  await runTaskToEnd(p, "skin-tone-analysis", tone(fileId), { wait: async (ms) => waits.push(ms), onCreated() {} });
  assert.deepEqual(waits, [2000, 3000, 4500, 6750, 10000, 10000]);
});

test("fake: TaskTimeout on poll", async () => {
  const p = new FakeYouCamProvider({ failPoll: { "skin-analysis": "TaskTimeout" } });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  const { taskId } = await p.runTask("skin-analysis", { src_file_id: fileId, dst_actions: ["skin_type"], format: "json" });
  await assert.rejects(p.pollTask("skin-analysis", taskId), { code: "TaskTimeout", status: 500 });
});

test("fake: deleting a running task is OperationInvalid; after delete, the task is InvalidTaskId and the file is gone", async () => {
  const p = new FakeYouCamProvider({ slow: { "skin-tone-analysis": 3 } });
  const { fileId } = await p.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
  const { taskId } = await p.runTask("skin-tone-analysis", tone(fileId));
  await assert.rejects(p.deleteTask(taskId), { code: "OperationInvalid" });
  await p.pollTask("skin-tone-analysis", taskId);
  await p.pollTask("skin-tone-analysis", taskId);
  assert.equal((await p.pollTask("skin-tone-analysis", taskId)).status, "success");
  assert.deepEqual(await p.deleteTask(taskId), { deleted: true });
  await assert.rejects(p.pollTask("skin-tone-analysis", taskId), { code: "InvalidTaskId", status: 404 });
  assert.equal(p.inspect().files[0].deleted, true);
  await assert.rejects(p.runTask("skin-tone-analysis", tone(fileId)), { code: "InvalidParameters" });
});

test("the providers implement the interface, and feature costs load with a documented fallback", async () => {
  assertProvider(new FakeYouCamProvider());
  assertProvider(new RecordedYouCamProvider({ tasks: [] }));
  assert.throws(() => assertProvider({ mode: "fake" }), /missing/);
  assert.deepEqual(await loadFeatureCosts(new FakeYouCamProvider()), { "skin-tone-analysis": 20, "skin-analysis": 9, "makeup-vto": 1 });
  assert.deepEqual(await loadFeatureCosts(new FakeYouCamProvider({ invalidKey: true })), { "skin-tone-analysis": 20, "skin-analysis": 9, "makeup-vto": 1 });
});

// A hand-made recording in the shape the fixture recorder writes; the values here are test data.
function recording() {
  return {
    recordedAt: "2026-10-26T05:00:00Z",
    photo: fakePhoto("persona"),
    fileId: "rec_file_1",
    balance: 900,
    tasks: [
      {
        feature: "skin-tone-analysis",
        request: { face_angle_strictness_level: "high" },
        response: { status: "success", result: { color: { skin_color: "#B9947C" }, face_quality: { lighting: "good" } }, unitsCharged: 20 },
      },
    ],
    images: {},
  };
}

test("recorded: serves what was recorded, stamped replay with its date", async () => {
  const p = new RecordedYouCamProvider(recording());
  const { fileId, replay } = await p.uploadPhoto(fakePhoto("persona"));
  assert.equal(fileId, "rec_file_1");
  assert.equal(replay, true);
  const { taskId } = await p.runTask("skin-tone-analysis", tone(fileId));
  const r = await p.pollTask("skin-tone-analysis", taskId);
  assert.equal(r.status, "success");
  assert.equal(r.replay, true);
  assert.equal(r.recordedAt, "2026-10-26T05:00:00Z");
  await p.deleteTask(taskId);
  await assert.rejects(p.pollTask("skin-tone-analysis", taskId), { code: "InvalidTaskId" });
});

test("recorded: never synthesizes; an unrecorded request is not_recorded, a new photo needs live mode", async () => {
  const p = new RecordedYouCamProvider(recording());
  await assert.rejects(p.uploadPhoto(fakePhoto("someone-else")), { code: "new_photo_needs_live" });
  const { fileId } = await p.uploadPhoto(fakePhoto("persona"));
  await assert.rejects(p.runTask("makeup-vto", { src_file_id: fileId, version: "1.0", effects: [] }), { code: "not_recorded" });
  await assert.rejects(p.runTask("skin-tone-analysis", { src_file_id: fileId, face_angle_strictness_level: "low" }), { code: "not_recorded" });
  await assert.rejects(p.fetchResult("https://results.example.invalid/a.jpg"), { code: "not_recorded" });
});

test("recorded through invoke: an unrecorded render comes back not_recorded and no preview is made up", async () => {
  const rec = recording();
  rec.tasks.push({
    feature: "skin-analysis",
    request: { dst_actions: ["skin_type", "oiliness", "moisture", "redness"], format: "json" },
    response: {
      status: "success",
      unitsCharged: 9,
      result: {
        output: [
          { type: "skin_type", whole: "Combination" },
          { type: "oiliness", raw_score: 58.1 },
          { type: "moisture", raw_score: 61 },
          { type: "redness", raw_score: 71.4 },
        ],
      },
    },
  });
  const app = await makeApp({ provider: new RecordedYouCamProvider(rec) });
  const checkId = await startCartCheck(app, "persona");
  const m = await app.invoke("measure_complexion", { checkId }, "agent");
  assert.equal(m.ok, true);
  assert.equal(m.result.complexion.replay, true);
  await app.invoke("rank_shades", { checkId, productId: "skin-tint" }, "agent");
  const pv = await app.invoke("preview_shade", { checkId, productId: "skin-tint", shadeCode: "245W", finish: "satin" }, "agent");
  assert.equal(pv.ok, false);
  assert.equal(pv.error.code, "not_recorded");
  assert.deepEqual(app.store.getCheck(checkId).lines.L1.previews, []);
});
