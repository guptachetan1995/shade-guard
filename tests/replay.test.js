// The replay loader: a recording written by `npm run record` (here, against the loopback mock
// into a temp dir; nothing synthetic is ever written under fixtures/recorded/) becomes REPLAY
// mode for `npm start` and for the static demo, with the recorded photo and the real result
// images. With no recording, today's sample-data behaviour is unchanged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { YouCamProvider } from "../src/providers/youcam-live.js";
import { RecordedYouCamProvider } from "../src/providers/youcam-recorded.js";
import { FakeYouCamProvider } from "../src/providers/youcam-fake.js";
import { fakePhoto, fromBase64, toBase64 } from "../src/providers/fake-photos.js";
import { loadRecordingFrom, providerFor, startServer } from "../src/server.js";
import { RECORDING_DIR } from "../src/recording.js";
import { recordFixtures } from "../scripts/record-fixtures.js";
import { buildPages } from "../scripts/build-pages.js";
import { createApp } from "../src/app.js";
import { runPlanner } from "../src/agent/planner.js";
import { noWait, fixedClock } from "./helpers.js";
import { startYouCamMock } from "./youcam-mock.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "replay-test-key-never-real-41c2";
const NO_KEY = { apiKey: null, apiBase: "https://api.example.invalid", unitCapPerCheck: 40, port: 0 };
let dir;
let recDir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "shade-guard-replay-"));
  recDir = join(dir, "recorded");
  const mock = await startYouCamMock({ key: KEY });
  try {
    const live = new YouCamProvider({ apiKey: KEY, apiBase: mock.url, pacer: { take: async () => {}, backoff() {} }, wait: noWait });
    await recordFixtures({ live, key: KEY, maxUnits: 90, photo: fakePhoto("sample-shopper"), lights: [fakePhoto("light-1"), fakePhoto("light-2")], outDir: recDir, wait: noWait });
  } finally {
    await mock.close();
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

const fsReader = (d) => (name) => (existsSync(join(d, name)) ? new Uint8Array(readFileSync(join(d, name))) : null);

test("with a recording, the default request (replay, no key) serves it through RecordedYouCamProvider, and the badge reads REPLAY", async () => {
  const recording = await loadRecordingFrom(recDir);
  const { provider, mode } = providerFor({ ...NO_KEY, requestedMode: "replay" }, { recording });
  assert.ok(provider instanceof RecordedYouCamProvider);
  assert.deepEqual([mode.id, mode.badge, mode.notice], ["replay", "REPLAY", null]);
  assert.equal(mode.banner, `Replay: recorded responses from real YouCam API calls made on ${recording.recordedAt.slice(0, 10)}. This page makes no API calls.`);
  assert.deepEqual(provider.samplePhoto().bytes, new Uint8Array(readFileSync(join(recDir, "photo.jpg"))));
});

test("with no recording, nothing changes: the default request runs the fake provider and says why", async () => {
  assert.equal(await loadRecordingFrom(join(dir, "nothing-here")), null);
  const { provider, mode } = providerFor({ ...NO_KEY, requestedMode: "replay" }, { recording: null });
  assert.ok(provider instanceof FakeYouCamProvider);
  assert.deepEqual([mode.id, mode.badge, mode.notice], ["fake", "FAKE", "No recording of the sample shopper exists yet, so the server runs on sample data."]);
});

test("a recording that names a file it doesn't carry fails loudly instead of replaying half of it", async () => {
  const reader = fsReader(recDir);
  const { loadRecording } = await import("../src/recording.js");
  await assert.rejects(loadRecording((name) => (name === "render-1.jpg" ? null : reader(name))), /names render-1\.jpg, which is missing/);
});

test("npm start in replay over a real socket: the recorded photo starts the check, the agent drafts, and /api/preview serves the recorded render", async () => {
  const recording = await loadRecordingFrom(recDir);
  const { provider, mode } = providerFor({ ...NO_KEY, requestedMode: "replay" }, { recording });
  const app = await createApp({ provider, now: fixedClock(), wait: noWait });
  const srv = await startServer({ app, mode });
  const call = async (method, path, body) => (await fetch(srv.url + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body && JSON.stringify(body) })).json();
  try {
    const state = await call("GET", "/api/state");
    assert.equal(state.mode.badge, "REPLAY");
    const sample = await call("GET", "/api/sample-photo");
    assert.equal(sample.contentType, "image/jpeg");
    const s = await call("POST", "/api/invoke", { tool: "start_check", args: { photo: sample.base64, capture: "upload" }, actor: "shopper" });
    const run = await call("POST", "/api/agent", { checkId: s.result.checkId });
    assert.equal(run.outcome, "drafted");
    assert.equal(JSON.stringify(run.transcript).includes("not_recorded"), false, "every call the planner made was recorded");
    const check = (await call("GET", "/api/state")).state.checks[0];
    assert.equal(check.complexion.replay, true);
    assert.equal(check.complexion.synthetic, undefined, "a replayed reading is not stamped synthetic");
    const pv = check.lines.L1.previews[0];
    const img = await call("GET", `/api/preview?checkId=${check.checkId}&previewId=${pv.previewId}`);
    assert.deepEqual([img.synthetic, img.replay], [false, true]);
    const files = Object.values(JSON.parse(readFileSync(join(recDir, "recording.json"), "utf8")).images).map((i) => readFileSync(join(recDir, i.file)).toString("base64"));
    assert.ok(files.includes(toBase64(fromBase64(img.base64))), "the preview is one of the recorded render files, byte for byte");

    // A photo other than the recorded one never reaches a synthesizer.
    await call("POST", "/api/invoke", { tool: "keep_my_shade", args: { checkId: check.checkId, lineId: "L1" }, actor: "shopper" });
    for (const lineId of ["L2", "L3"]) await call("POST", "/api/invoke", { tool: "keep_my_shade", args: { checkId: check.checkId, lineId }, actor: "shopper" });
    const other = await call("POST", "/api/invoke", { tool: "start_check", args: { photo: toBase64(fakePhoto("someone-else")), capture: "upload" }, actor: "shopper" });
    assert.equal((await call("POST", "/api/agent", { checkId: other.result.checkId })).outcome, "failed:new_photo_needs_live");
  } finally {
    await srv.close();
  }
});

test("the static demo built with a recording copies it, marks the page to replay it, and runs the demo story in the tab", async () => {
  const built = buildPages(join(dir, "site"), { recordingDir: recDir });
  assert.equal(built.recorded, true);
  const html = readFileSync(join(built.out, "index.html"), "utf8");
  assert.match(html, new RegExp(`data-transport="pages" data-recording="${RECORDING_DIR}/"`));
  for (const f of ["recording.json", "photo.jpg", "render-1.jpg"]) assert.ok(built.files.includes(`${RECORDING_DIR}/${f}`), f);
  assert.equal(built.files.includes(`${RECORDING_DIR}/readings.json`), false, "only what the replay reads is copied");

  const { createPagesTransport } = await import(pathToFileURL(join(built.out, "src/pages-entry.js")).href);
  const t = await createPagesTransport({ tick: false, read: fsReader(join(built.out, RECORDING_DIR)) });
  const first = await t.request("GET", "/api/state");
  assert.deepEqual([first.mode.id, first.mode.badge], ["replay", "REPLAY"]);
  const sample = await t.request("GET", "/api/sample-photo");
  const s = await t.request("POST", "/api/invoke", { tool: "start_check", args: { photo: sample.base64, capture: "upload" }, actor: "shopper" });
  const run = await t.request("POST", "/api/agent", { checkId: s.result.checkId });
  assert.equal(run.outcome, "drafted");
  assert.equal(run.transcript.reduce((n, c) => n + c.units, 0), 36);
});

test("the recording committed under fixtures/recorded/ replays the demo cart and R-107 with nothing missing", { skip: !existsSync(join(ROOT, RECORDING_DIR, "recording.json")) && "no recording has been made yet" }, async () => {
  const recording = await loadRecordingFrom();
  for (const caseId of [null, "R-107"]) {
    const app = await createApp({ provider: new RecordedYouCamProvider(recording), now: fixedClock(), wait: noWait });
    const s = await app.invoke("start_check", { photo: toBase64(recording.photo), capture: "upload", ...(caseId ? { caseId } : {}) }, "shopper");
    const { transcript } = await runPlanner(app.invoke, { checkId: s.result.checkId, caseId });
    assert.equal(JSON.stringify(transcript).includes("not_recorded"), false, `${caseId ?? "cart"}: every call was recorded`);
    assert.ok(Object.values(app.store.getCheck(s.result.checkId).lines).every((l) => l.draft), `${caseId ?? "cart"}: every line drafted`);
  }
});
