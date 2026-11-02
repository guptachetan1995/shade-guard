// The live YouCam provider, checked against a loopback mock (tests/youcam-mock.js). No test
// here reaches the network; the mock answers in the documented shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { YouCamProvider, PATHS, RATE_LIMIT_HOLD_MS } from "../src/providers/youcam-live.js";
import { createPacer, PACE } from "../src/providers/pacer.js";
import { assertProvider } from "../src/providers/provider.js";
import { messageFor, YouCamError } from "../src/providers/errors.js";
import { fakePhoto } from "../src/providers/fake-photos.js";
import { makeupVtoBody } from "../src/rules/preview.js";
import { runPlanner } from "../src/agent/planner.js";
import { closeCheck } from "../src/check-lifecycle.js";
import { makeApp, noWait, startCartCheck } from "./helpers.js";
import { startYouCamMock } from "./youcam-mock.js";

const KEY = "mock-key-0f9e8d7c6b5a-never-real";
const SD_BODY = (fileId) => ({ src_file_id: fileId, dst_actions: ["skin_type", "oiliness", "moisture", "redness"], format: "json" });
const TONE_BODY = (fileId) => ({ src_file_id: fileId, face_angle_strictness_level: "high" });

function countingPacer() {
  const p = { takes: 0, backoffs: [], take: async () => void (p.takes += 1), backoff: (ms) => p.backoffs.push(ms) };
  return p;
}

async function withMock(opts, fn) {
  const mock = await startYouCamMock({ key: KEY, ...opts });
  const pacer = countingPacer();
  const waits = [];
  const provider = new YouCamProvider({ apiKey: opts.apiKey ?? KEY, apiBase: mock.url, pacer, wait: async (ms) => void waits.push(ms) });
  try {
    await fn({ mock, provider, pacer, waits });
  } finally {
    await mock.close();
  }
}

const body = (r) => JSON.parse(r.body.toString("utf8"));
const errorText = (e) => JSON.stringify({ ...e, message: e.message, stack: e.stack });

test("file init declares image/jpeg and the exact byte size; the PUT sends the bytes with exactly the returned headers and no key", () =>
  withMock({}, async ({ mock, provider }) => {
    assertProvider(provider);
    const bytes = fakePhoto("sample-shopper");
    const { fileId } = await provider.uploadPhoto(bytes, "image/jpeg");
    assert.equal(fileId, "file_1");
    const [init, put] = mock.state.requests;
    assert.deepEqual([init.method, init.path], ["POST", "/s2s/v2.0/file"]);
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(init.headers["content-type"], "application/json");
    assert.deepEqual(body(init), { files: [{ content_type: "image/jpeg", file_name: "photo.jpg", file_size: bytes.length }] });
    assert.deepEqual([put.method, put.path, put.query], ["PUT", "/upload/file_1", "?sig=mock"]);
    assert.equal(put.headers["content-type"], "image/jpeg");
    assert.equal(put.headers["content-length"], String(bytes.length));
    assert.equal(put.headers.authorization, undefined, "the key never goes to the pre-signed host");
    assert.deepEqual(new Uint8Array(put.body), bytes);
  }));

test("task bodies, the poll path and the delete body are the documented ones; Makeup VTO sends skin_smooth at 0", () =>
  withMock({ pollsUntilDone: 2 }, async ({ mock, provider }) => {
    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const shade = { code: "245W", hex: "#C69C7E" };
    const vto = makeupVtoBody(fileId, shade, "satin");
    const sent = [
      ["skin-tone-analysis", TONE_BODY(fileId)],
      ["skin-analysis", SD_BODY(fileId)],
      ["makeup-vto", vto],
    ];
    const ids = [];
    for (const [feature, b] of sent) ids.push((await provider.runTask(feature, b)).taskId);
    const creates = mock.apiRequests().filter((r) => r.method === "POST" && r.path.startsWith("/s2s/v2.0/task/"));
    assert.deepEqual(
      creates.map((r) => [r.path, body(r)]),
      sent.map(([feature, b]) => [`/s2s/v2.0/task/${feature}`, b]),
    );
    assert.deepEqual(body(creates[2]).effects[1], { category: "skin_smooth", skinSmoothStrength: 0, skinSmoothColorIntensity: 0 });

    assert.deepEqual(await provider.pollTask("makeup-vto", ids[2]), { status: "running", unitsCharged: 0 });
    const done = await provider.pollTask("makeup-vto", ids[2]);
    assert.equal(done.status, "success");
    assert.equal(done.unitsCharged, 1);
    assert.match(done.result.url, /\/results\/task_\d+\.jpg$/);
    const polls = mock.apiRequests().filter((r) => r.method === "GET");
    assert.deepEqual(polls.map((r) => r.path), [`/s2s/v2.0/task/makeup-vto/${ids[2]}`, `/s2s/v2.0/task/makeup-vto/${ids[2]}`]);

    const image = await provider.fetchResult(done.result.url);
    assert.equal(image.contentType, "image/jpeg");
    assert.ok(image.bytes instanceof Uint8Array && image.bytes.length > 0);
    assert.equal(mock.state.requests.at(-1).headers.authorization, undefined, "the key never goes to a result host");

    assert.deepEqual(await provider.deleteTask(ids[2]), { deleted: true });
    const del = mock.apiRequests().at(-1);
    assert.deepEqual([del.method, del.path, body(del)], ["POST", "/s2s/v2.0/task/delete", { task_id: ids[2] }]);
    await assert.rejects(provider.pollTask("makeup-vto", ids[2]), { code: "InvalidTaskId", status: 404 });
  }));

test("an engine error comes back as status error at 0 units, with its retake sentence", () =>
  withMock({ engineError: { "skin-tone-analysis": "error_face_angle_upward" } }, async ({ provider }) => {
    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const { taskId } = await provider.runTask("skin-tone-analysis", TONE_BODY(fileId));
    const r = await provider.pollTask("skin-tone-analysis", taskId);
    assert.deepEqual(r, { status: "error", error: "error_face_angle_upward", unitsCharged: 0 });
    assert.equal(messageFor(r.error), "Tilt your head down slightly.");
  }));

test("balance and feature costs are read from the free endpoints", () =>
  withMock({ balance: 973 }, async ({ mock, provider }) => {
    assert.deepEqual(await provider.getBalance(), { units: 973 });
    assert.deepEqual(await provider.getFeatureCosts(), [
      { feature: "skin-tone-analysis", units: 20 },
      { feature: "skin-analysis", units: 9 },
      { feature: "makeup-vto", units: 1 },
      { feature: "text-to-image/youcam", units: 1 },
    ]);
    assert.deepEqual(
      mock.apiRequests().map((r) => [r.method, r.path, r.query]),
      [
        ["GET", PATHS.credit, ""],
        ["GET", PATHS.featureCost, "?page_size=30"],
      ],
    );
  }));

test("InvalidApiKey and InvalidAccessToken both read 'the API key was not accepted', and no error carries the key", async () => {
  const wrong = "wrong-key-1a2b3c4d5e6f-never-real";
  await withMock({ apiKey: wrong, keyError: "InvalidApiKey" }, async ({ mock, provider }) => {
    const e1 = await provider.getBalance().catch((e) => e);
    assert.ok(e1 instanceof YouCamError);
    assert.deepEqual([e1.code, e1.status], ["InvalidApiKey", 401]);
    mock.inject("POST", "/s2s/v2.0/file", 401, { status: 401, error_code: "InvalidAccessToken" });
    const e2 = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg").catch((e) => e);
    assert.deepEqual([e2.code, e2.status], ["InvalidAccessToken", 401]);
    for (const e of [e1, e2]) {
      assert.equal(messageFor(e.code), "The API key was not accepted.");
      assert.equal(errorText(e).includes(wrong), false);
    }
    assert.equal(JSON.stringify(provider).includes(wrong), false);
    assert.equal(JSON.stringify(provider.requestLog()).includes(wrong), false);
  });
});

test("query errors map to the shared codes: CreditInsufficiency, TaskTimeout with its task, OperationInvalid, InvalidParameters", () =>
  withMock({ balance: 10, pollsUntilDone: 3 }, async ({ mock, provider }) => {
    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const credit = await provider.runTask("skin-tone-analysis", TONE_BODY(fileId)).catch((e) => e);
    assert.deepEqual([credit.code, credit.status, credit.feature], ["CreditInsufficiency", 400, "skin-tone-analysis"]);
    assert.equal(messageFor(credit.code), "This store's try-on budget is used up.");

    const { taskId } = await provider.runTask("makeup-vto", makeupVtoBody(fileId, { hex: "#C69C7E" }, "matte"));
    await assert.rejects(provider.deleteTask(taskId), { code: "OperationInvalid", status: 400, taskId });
    mock.inject("GET", "/s2s/v2.0/task/makeup-vto/", 500, { status: 500, error_code: "TaskTimeout" });
    await assert.rejects(provider.pollTask("makeup-vto", taskId), { code: "TaskTimeout", status: 500, taskId, feature: "makeup-vto" });
    mock.inject("POST", "/s2s/v2.0/task/", 400, { status: 400, error_code: "InvalidParameters" });
    await assert.rejects(provider.runTask("skin-analysis", SD_BODY(fileId)), { code: "InvalidParameters" });
  }));

test("a 429 is RateLimited and holds the pacer back for Retry-After, or 2 s without one", () =>
  withMock({}, async ({ mock, provider, pacer }) => {
    mock.inject("GET", "/s2s/v1.0/client/credit", 429, "", { "retry-after": "3" });
    await assert.rejects(provider.getBalance(), { code: "RateLimited", status: 429 });
    mock.inject("GET", "/s2s/v1.0/client/credit", 429, { status: 429 });
    await assert.rejects(provider.getBalance(), { code: "RateLimited" });
    assert.deepEqual(pacer.backoffs, [3000, RATE_LIMIT_HOLD_MS]);
    assert.equal(messageFor("RateLimited"), "The analysis service is busy. Trying again shortly.");
  }));

test("a response in an unrecorded shape is an explicit unexpected_shape naming the field, with no values in the outline", () =>
  withMock({}, async ({ mock, provider }) => {
    mock.inject("POST", "/s2s/v2.0/file", 200, { status: 200, data: { files: [{ file_id: "file_secretish_1" }] } });
    const e1 = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg").catch((e) => e);
    assert.deepEqual([e1.code, e1.field], ["unexpected_shape", "data.files[0].requests[0]"]);
    assert.equal(e1.outline, "{status:number,data:{files:[{file_id:string}]}}");
    assert.equal(errorText(e1).includes("file_secretish_1"), false, "the outline carries names and types, not values");

    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const { taskId } = await provider.runTask("skin-tone-analysis", TONE_BODY(fileId));
    mock.inject("GET", "/s2s/v2.0/task/", 200, { status: 200, data: { task_status: "queued" } });
    const e2 = await provider.pollTask("skin-tone-analysis", taskId).catch((e) => e);
    assert.deepEqual([e2.code, e2.field, e2.taskId], ["unexpected_shape", "data.task_status (running, success or error)", taskId]);
    mock.inject("GET", "/s2s/v2.0/task/", 200, { status: 200, data: { task_status: "error", message: "no face" } });
    assert.equal((await provider.pollTask("skin-tone-analysis", taskId).catch((e) => e)).field, "data.error");
    mock.inject("GET", "/s2s/v2.0/task/", 200, { status: 200, data: { task_status: "success" } });
    assert.equal((await provider.pollTask("skin-tone-analysis", taskId).catch((e) => e)).field, "data.results");
    mock.inject("GET", "/s2s/v1.0/client/credit", 200, { status: 200, data: { credit: 1000 } });
    assert.equal((await provider.getBalance().catch((e) => e)).field, "results[]");
    mock.inject("GET", "/s2s/v1.0/client/credit", 400, { status: 400, message: "bad" });
    assert.equal((await provider.getBalance().catch((e) => e)).field, "error_code");
    assert.equal(messageFor("unexpected_shape"), "The analysis service answered in a shape this app doesn't know, so nothing was used.");
  }));

test("every request to the API server takes a pacer slot; the pre-signed upload and result downloads don't", () =>
  withMock({}, async ({ mock, provider, pacer }) => {
    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const { taskId } = await provider.runTask("makeup-vto", makeupVtoBody(fileId, { hex: "#C69C7E" }, "matte"));
    const done = await provider.pollTask("makeup-vto", taskId);
    await provider.fetchResult(done.result.url);
    await provider.deleteTask(taskId);
    assert.equal(mock.apiRequests().length, 4);
    assert.equal(mock.state.requests.length, 6);
    assert.equal(pacer.takes, 4);
  }));

test("the sliding window: at most 5 requests in any second and 200 in any 300 s, served in order", async () => {
  let t = 0;
  const pacer = createPacer({ now: () => t, sleep: async (ms) => void (t += ms) });
  const times = [];
  for (let i = 0; i < 205; i++) {
    await pacer.take();
    times.push(t);
  }
  for (let i = PACE.maxInBurst; i < times.length; i++) assert.ok(times[i] - times[i - PACE.maxInBurst] >= PACE.burstMs, `burst at ${i}`);
  for (let i = PACE.maxInWindow; i < times.length; i++) assert.ok(times[i] - times[i - PACE.maxInWindow] >= PACE.windowMs, `window at ${i}`);
  assert.deepEqual(times.slice(0, 6), [0, 0, 0, 0, 0, 1000]);
  assert.equal(times[200], PACE.windowMs, "the 201st waits for the first to leave the window");

  // Concurrent callers queue rather than racing for the same slot; a backoff holds them all.
  t = 10_000_000;
  const p2 = createPacer({ now: () => t, sleep: async (ms) => void (t += ms) });
  p2.backoff(5000);
  const order = [];
  await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => p2.take().then(() => order.push([i, t - 10_000_000]))));
  assert.deepEqual(order.map(([i]) => i), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(order.map(([, at]) => at), [5000, 5000, 5000, 5000, 5000, 6000, 6000]);
});

test("a task the UI stopped waiting for is polled to the end in the background, then deleted and the deletion confirmed", () =>
  withMock({ pollsUntilDone: { "makeup-vto": 4 } }, async ({ mock, provider, waits }) => {
    const { fileId } = await provider.uploadPhoto(fakePhoto("sample-shopper"), "image/jpeg");
    const { taskId } = await provider.runTask("makeup-vto", makeupVtoBody(fileId, { hex: "#C69C7E" }, "matte"));
    const run = provider.finishInBackground("makeup-vto", taskId);
    assert.equal(provider.finishInBackground("makeup-vto", taskId), run, "one background finisher per task");
    assert.deepEqual(provider.backgroundTasks(), [taskId]);
    assert.deepEqual(await run, { taskId, deleted: true, confirmed: true });
    assert.deepEqual(provider.backgroundTasks(), []);
    const after = mock.apiRequests().slice(2).map((r) => `${r.method} ${r.path}`);
    const poll = `GET /s2s/v2.0/task/makeup-vto/${taskId}`;
    assert.deepEqual(after, [poll, poll, poll, poll, "POST /s2s/v2.0/task/delete", poll]);
    assert.deepEqual(waits, [2000, 3000, 4500], "the usual backoff between polls");
    assert.equal(mock.state.tasks.get(taskId).deleted, true);
    assert.equal(mock.state.files.get(fileId).deleted, true);
  }));

test("closing a check with a task still running hands it to the background finisher; the receipt settles when it is deleted", () =>
  withMock({ pollsUntilDone: { "makeup-vto": 3 } }, async ({ mock, provider }) => {
    const app = await makeApp({ provider });
    const checkId = await startCartCheck(app);
    const m = await app.invoke("measure_complexion", { checkId }, "agent");
    assert.equal(m.ok, true);
    const check = app.store.getCheck(checkId);
    const { taskId } = await provider.runTask("makeup-vto", makeupVtoBody(check.fileId, { hex: "#C69C7E" }, "matte"));
    check.tasks.push({ taskId, feature: "makeup-vto", units: 0, deletedAt: null, pending: false });
    await closeCheck(app.store, provider, check, "shopper_left");
    assert.deepEqual(provider.backgroundTasks(), [taskId]);
    await provider.backgroundSettled();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual([check.privacyReceipt.deletedTasks, check.privacyReceipt.pending, check.privacyReceipt.photoOnYouCam], [3, 0, "deleted_with_tasks"]);
    assert.ok([...mock.state.tasks.values()].every((t) => t.deleted));
  }));

test("a whole demo check runs through invoke on the live provider; the key is in every API request's header and nowhere else", () =>
  withMock({}, async ({ mock, provider }) => {
    const app = await makeApp({ provider });
    const checkId = await startCartCheck(app);
    const { plan } = await runPlanner(app.invoke, { checkId });
    for (const lineId of ["L1", "L2", "L3"]) {
      const r = await app.invoke("apply_draft", { checkId, lineId }, "shopper");
      assert.equal(r.ok, true, `apply_draft ${lineId}`);
    }
    const check = app.store.getCheck(checkId);
    assert.equal(check.status, "closed");
    assert.equal(check.privacyReceipt.photoOnYouCam, "deleted_with_tasks");
    assert.equal(check.unitsSpent, 36, "the demo cart's documented cost");
    assert.ok(plan, "the planner ran");
    assert.ok([...mock.state.tasks.values()].every((t) => t.deleted), "every task deleted on the server");

    for (const r of mock.state.requests) {
      if (r.path.startsWith("/s2s/")) assert.equal(r.headers.authorization, `Bearer ${KEY}`, `${r.method} ${r.path}`);
      else assert.equal(r.headers.authorization, undefined, `${r.method} ${r.path}`);
      assert.equal(JSON.stringify(r.body.toString("utf8")).includes(KEY), false, "never in a request body");
    }
    const everywhere = JSON.stringify([app.store.snapshot(), app.store.state.activityLog, provider, provider.requestLog(), provider.latencies()]);
    assert.equal(everywhere.includes(KEY), false);
    assert.equal(provider.latencies().length, 9);
  }));
