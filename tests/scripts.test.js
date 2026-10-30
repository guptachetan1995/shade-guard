// npm run balance and npm run record, against the loopback mock with a dummy key from a temp
// env file. Nothing here reaches YouCam or reads a real key file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YouCamProvider } from "../src/providers/youcam-live.js";
import { RecordedYouCamProvider } from "../src/providers/youcam-recorded.js";
import { fakePhoto } from "../src/providers/fake-photos.js";
import { runPlanner } from "../src/agent/planner.js";
import { recordFixtures, plannedUnits, scrub, RecordRefusal } from "../scripts/record-fixtures.js";
import { corsSpy, runProbe } from "../scripts/probe.js";
import { loadFixtures } from "../src/fixtures.js";
import { makeApp, noWait, photo } from "./helpers.js";
import { startYouCamMock } from "./youcam-mock.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "script-test-key-9a8b7c6d5e4f-never-real";
const COSTS = { "skin-tone-analysis": 20, "skin-analysis": 9, "makeup-vto": 1 };

function tempDir() {
  return mkdtempSync(join(tmpdir(), "shade-guard-scripts-"));
}

// Runs a script with a clean environment: only PATH, a temp HOME and whatever the test names.
function run(script, args, env, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, script), ...args], { cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

async function withEnvFile(mock, fn, key = KEY) {
  const dir = tempDir();
  try {
    const envFile = join(dir, "youcam.env");
    writeFileSync(envFile, `YOUCAM_MODE=live\nYOUCAM_API_KEY=${key}\nYOUCAM_API_BASE=${mock.url}\n`, { mode: 0o600 });
    await fn({ dir, env: { YOUCAM_ENV_FILE: envFile } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("balance prints the unit count only; never the key, a header or the body", async () => {
  const mock = await startYouCamMock({ key: KEY, balance: 1000 });
  try {
    await withEnvFile(mock, async ({ dir, env }) => {
      const r = await run("scripts/balance.js", [], env, dir);
      assert.deepEqual(r, { code: 0, stdout: "YouCam balance: 1000 units\n", stderr: "" });
      assert.deepEqual(mock.apiRequests().map((q) => [q.method, q.path, q.headers.authorization]), [["GET", "/s2s/v1.0/client/credit", `Bearer ${KEY}`]]);

      mock.inject("GET", "/s2s/v1.0/client/credit", 200, { status: 200, data: { credit: 1000 } });
      const shape = await run("scripts/balance.js", [], env, dir);
      assert.equal(shape.code, 1);
      assert.match(shape.stderr, /unexpected_shape: .*\n {2}expected: results\[\]\n {2}the response's fields: \{status:number,data:\{credit:number\}\}/);
    });
    await withEnvFile(
      mock,
      async ({ dir, env }) => {
        const r = await run("scripts/balance.js", [], env, dir);
        assert.equal(r.code, 1);
        assert.equal(r.stderr, "npm run balance: InvalidApiKey (HTTP 401): The API key was not accepted.\n");
        assert.equal((r.stdout + r.stderr).includes("wrong-key"), false);
      },
      "wrong-key-for-the-refusal-test",
    );
  } finally {
    await mock.close();
  }
});

test("balance and record refuse with a clear message, and send nothing, when no key is configured", async () => {
  const dir = tempDir();
  try {
    for (const [script, args] of [["scripts/balance.js", []], ["scripts/record-fixtures.js", ["--max-units", "90"]]]) {
      const r = await run(script, args, {}, dir);
      assert.equal(r.code, 2, script);
      assert.match(r.stderr, /no YouCam API key is configured, so nothing was sent/);
      assert.equal(r.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record refuses before any paid call when the plan costs more than --max-units", async () => {
  const mock = await startYouCamMock({ key: KEY });
  try {
    await withEnvFile(mock, async ({ dir, env }) => {
      const files = ["photo", "light-1", "light-2"].map((n) => {
        const p = join(dir, `${n}.jpg`);
        writeFileSync(p, fakePhoto(n));
        return p;
      });
      const r = await run("scripts/record-fixtures.js", ["--max-units", "50", "--photo", files[0], "--light", files[1], "--light", files[2]], env, dir);
      assert.equal(r.code, 2);
      assert.equal(r.stderr, "npm run record: The plan costs up to 81 units, over --max-units 50. Nothing was sent.\n");
      assert.deepEqual(mock.apiRequests().map((q) => q.path), ["/s2s/v2.0/credit/feature-cost"], "only the free cost table was read");
      assert.equal(r.stderr.includes(KEY), false);
    });
  } finally {
    await mock.close();
  }
});

test("the plan prices three tone readings, one SD reading and up to three renders per checked line", () => {
  assert.deepEqual(["readings", "renders", "all"].map((p) => plannedUnits(p, COSTS)), [69, 12, 81]);
});

test("scrub turns downloaded URLs into local names, drops request ids and blanks any other URL", () => {
  const out = scrub(
    { url: "https://results.example.invalid/a.jpg", request_id: "r-1", output: [{ mask_urls: ["https://masks.example.invalid/m.png"] }], keep: "ok" },
    new Map([["https://results.example.invalid/a.jpg", "render-1.jpg"]]),
  );
  assert.deepEqual(out, { url: "render-1.jpg", output: [{ mask_urls: ["[signed URL scrubbed]"] }], keep: "ok" });
});

test("record writes a scrubbed recording with no key, no URL and every task deleted, and the replay provider runs the demo from it", async () => {
  const hexByFile = { file_1: "#B9947C", file_4: "#BB967E", file_6: "#B7927A" };
  const mock = await startYouCamMock({ key: KEY, skinHex: (fileId) => hexByFile[fileId] ?? "#B9947C" });
  const out = tempDir();
  try {
    const live = new YouCamProvider({ apiKey: KEY, apiBase: mock.url, pacer: { take: async () => {}, backoff() {} }, wait: noWait });
    const lines = [];
    await assert.rejects(recordFixtures({ live, key: KEY, maxUnits: 90, photo: fakePhoto("sample-shopper"), lights: [], outDir: out }), RecordRefusal);
    const r = await recordFixtures({
      live,
      key: KEY,
      maxUnits: 90,
      photo: fakePhoto("sample-shopper"),
      lights: [fakePhoto("light-1"), fakePhoto("light-2")],
      outDir: out,
      wait: noWait,
      log: (l) => lines.push(l),
    });
    assert.equal(r.before, 1000);
    assert.equal(r.spent, r.predicted, "the balance moved by what the cost table predicts");
    assert.ok(r.spent <= r.planned && r.planned <= 90);
    assert.equal(r.spent, 3 * 20 + 9 + 7, "three tone readings, one SD reading, the seven distinct renders");
    assert.ok(r.spread.maxDe00 > 0, "the light-shifted readings give a measured spread");
    assert.ok([...mock.state.tasks.values()].every((t) => t.deleted), "every task deleted on the server");

    const names = readdirSync(out).sort();
    assert.ok(names.includes("readings.json") && names.includes("recording.json") && names.includes("photo.jpg"));
    for (const name of names) {
      const bytes = readFileSync(join(out, name));
      assert.equal(bytes.includes(Buffer.from(KEY)), false, `${name} carries the key`);
      if (name.endsWith(".json")) assert.doesNotMatch(bytes.toString("utf8"), /https?:\/\/|request_id/, `${name} carries a URL or a request id`);
    }
    assert.equal(lines.join("\n").includes(KEY), false);

    const rec = JSON.parse(readFileSync(join(out, "recording.json"), "utf8"));
    const recording = {
      ...rec,
      photo: new Uint8Array(readFileSync(join(out, rec.photo))),
      images: Object.fromEntries(Object.entries(rec.images).map(([k, v]) => [k, { bytes: new Uint8Array(readFileSync(join(out, v.file))), contentType: v.contentType }])),
    };
    const app = await makeApp({ provider: new RecordedYouCamProvider(recording) });
    const s = await app.invoke("start_check", { photo: photo("sample-shopper"), capture: "upload" }, "shopper");
    const { transcript } = await runPlanner(app.invoke, { checkId: s.result.checkId });
    assert.equal(JSON.stringify(transcript).includes("not_recorded"), false, "every call the planner makes was recorded");
    const check = app.store.getCheck(s.result.checkId);
    assert.equal(check.complexion.replay, true);
    assert.ok(Object.values(check.lines).every((l) => l.draft && l.previews.length > 0));
  } finally {
    await mock.close();
    rmSync(out, { recursive: true, force: true });
  }
});

test("the spike probes print shapes, codes, values and units, never the key or a URL, and delete what they create", async () => {
  const mock = await startYouCamMock({ key: KEY, pollsUntilDone: 2, engineError: { "skin-analysis": "error_no_face" } });
  const dir = tempDir();
  try {
    const lines = [];
    const out = (l) => lines.push(l);
    const live = new YouCamProvider({ apiKey: KEY, apiBase: mock.url, pacer: { take: async () => {}, backoff() {} }, wait: noWait, fetch: corsSpy(globalThis.fetch, out) });
    const opts = { live, photo: fakePhoto("sample-shopper"), wait: noWait, out };
    await runProbe("costs", opts);
    await runProbe("tone", opts);
    await runProbe("skin", opts);
    await runProbe("vto", { ...opts, shade: "245W", save: join(dir, "render.jpg"), cors: true });
    const vtoBody = JSON.parse(mock.apiRequests().find((q) => q.path === "/s2s/v2.0/task/makeup-vto").body.toString("utf8"));
    assert.equal(vtoBody.effects[0].palettes[0].color, loadFixtures().catalogue.products[0].shades.find((s) => s.code === "245W").hex);
    const text = lines.join("\n");
    assert.match(text, /skin-tone-analysis: 20\n {2}skin-analysis: 9\n {2}makeup-vto: 1/);
    assert.match(text, /polls: running → success/);
    assert.match(text, /"skin_color":"#B9947C"/);
    assert.match(text, /engine error: error_no_face/);
    assert.match(text, /results shape: \{url:string\}/);
    assert.match(text, /units: balance 980 → 979 \(1 spent; the cost table says 1\)/);
    assert.match(text, /a status read afterwards answers InvalidTaskId/);
    assert.match(text, /a new task on the deleted task's file_id: InvalidParameters/);
    assert.match(text, /upload host {2}preflight PUT: /);
    assert.equal(text.includes(KEY), false);
    assert.doesNotMatch(text, /https?:\/\//);
    assert.ok(readFileSync(join(dir, "render.jpg")).length > 0);
    assert.ok([...mock.state.tasks.values()].every((t) => t.deleted || t.status === "error"));
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
