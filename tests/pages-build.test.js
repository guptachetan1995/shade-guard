import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPages } from "../scripts/build-pages.js";
import { fakePhoto, toBase64 } from "../src/providers/fake-photos.js";

let dir;
let built;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "shade-guard-pages-"));
  // No recording, whatever the tree holds: this test is the sample-data build; replay.test.js covers replay.
  built = buildPages(join(dir, "site"), { recordingDir: join(dir, "no-recording") });
});
after(() => rmSync(dir, { recursive: true, force: true }));

function allFiles(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

test("the build copies the page, the browser modules and the fixtures, unbundled, and marks the page for the in-tab transport", () => {
  for (const f of ["index.html", "public/app.js", "public/photo.js", "public/face.js", "src/api.js", "src/invoke.js", "src/tools.js", "src/human-verbs.js", "src/agent/planner.js", "src/pages-entry.js", "fixtures/catalogue.json", "LICENSE"]) {
    assert.ok(built.files.includes(f), `${f} is missing`);
  }
  const html = readFileSync(join(built.out, "index.html"), "utf8");
  assert.match(html, /data-transport="pages"/);
  assert.equal(readFileSync(join(built.out, "src/invoke.js"), "utf8"), readFileSync(new URL("../src/invoke.js", import.meta.url), "utf8"), "the real chokepoint, byte for byte");
});

test("the build holds no src/config.js, no src/server.js, no process.env and no loadEnvFile", () => {
  assert.equal(built.files.includes("src/config.js"), false);
  assert.equal(built.files.includes("src/server.js"), false);
  for (const f of allFiles(built.out)) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /process\.env/, f);
    assert.doesNotMatch(text, /loadEnvFile/, f);
  }
});

test("a YOUCAM_API_KEY in the test environment appears nowhere in the built files", { skip: !process.env.YOUCAM_API_KEY && "YOUCAM_API_KEY is not set in this environment" }, () => {
  const key = process.env.YOUCAM_API_KEY;
  for (const f of allFiles(built.out)) assert.equal(readFileSync(f, "utf8").includes(key), false, f);
});

test("the built page runs the demo story in this tab: shop, returns desk and merchant panel, every response JSON round-tripped", async () => {
  const { createPagesTransport } = await import(pathToFileURL(join(built.out, "src/pages-entry.js")).href);
  const t = await createPagesTransport({ tick: false });
  const post = (path, body) => t.request("POST", path, body);
  const invoke = (tool, args, actor) => post("/api/invoke", { tool, args, actor });

  const first = await t.request("GET", "/api/state");
  assert.equal(first.mode.id, "fake");
  assert.equal(first.mode.label, "Sample data, not YouCam");
  first.state.cart.lines[0].shadeCode = "TAMPERED";
  assert.equal((await t.request("GET", "/api/state")).state.cart.lines[0].shadeCode, "220N", "a response is a copy, never the live store");

  const tools = await t.request("GET", "/api/tools");
  assert.equal(tools.tools.length, 9);

  // Beats 1-7: the shopper starts, the agent drafts, the shopper decides, the receipt.
  const s = await invoke("start_check", { photo: toBase64(fakePhoto("sample-shopper")), capture: "upload" }, "shopper");
  assert.equal(s.ok, true);
  const checkId = s.result.checkId;
  assert.equal((await invoke("start_check", { photo: toBase64(fakePhoto("sample-shopper")), capture: "upload" }, "agent")).error.code, "wrong_actor");
  const run = await post("/api/agent", { checkId });
  assert.equal(run.outcome, "drafted");
  assert.equal(run.transcript.reduce((n, c) => n + c.units, 0), 36);
  const refusedApply = await invoke("apply_draft", { checkId, lineId: "L1" }, "agent");
  assert.equal(refusedApply.error.code, "wrong_actor");
  const smuggled = await invoke("draft_recommendation", { checkId, lineId: "L1", decision: "swap", shadeCode: "245W", evidence: {}, cart: { lines: [] } }, "agent");
  assert.equal(smuggled.error.code, "smuggled_field");
  assert.equal((await invoke("apply_draft", { checkId, lineId: "L1" }, "shopper")).result.cart.lines[0].shadeCode, "245W");
  assert.equal((await invoke("apply_draft", { checkId, lineId: "L2" }, "shopper")).ok, true);
  const last = await invoke("apply_draft", { checkId, lineId: "L3" }, "shopper");
  assert.equal(last.result.privacyReceipt.photoOnYouCam, "deleted_with_tasks");
  assert.equal(last.result.privacyReceipt.pending, 0);
  const afterShop = (await t.request("GET", "/api/state")).state;
  assert.deepEqual(afterShop.cart.lines.map((l) => l.lineId), ["L1", "L2", "L4"], "Cushion Compact was removed by the shopper");

  // Returns desk: R-104 from the overridden reading; R-107 after the shopper's check.
  assert.equal((await post("/api/agent", { caseId: "R-104" })).outcome, "resolution:exchange");
  assert.equal((await invoke("approve_exchange", { caseId: "R-104" }, "agent")).error.code, "wrong_actor");
  assert.equal((await invoke("approve_exchange", { caseId: "R-104" }, "staff")).result.status, "exchange_approved");
  assert.equal((await post("/api/agent", { caseId: "R-107" })).outcome, "awaiting_shopper_check");
  const r107 = await invoke("start_check", { photo: toBase64(fakePhoto("sample-shopper")), capture: "upload", caseId: "R-107" }, "shopper");
  assert.equal((await post("/api/agent", { checkId: r107.result.checkId, caseId: "R-107" })).outcome, "resolution:exchange");
  assert.equal((await invoke("approve_exchange", { caseId: "R-107" }, "staff")).result.status, "exchange_approved");

  // Merchant panel: the range gap, units per check, the cap.
  const end = await t.request("GET", "/api/state");
  assert.deepEqual(end.merchant.rangeGaps.map((g) => g.sentence), ["Cushion Compact: 1 reading with no shade within ΔE00 6, deeper and warmer than C5"]);
  assert.deepEqual(end.merchant.unitsPerCheck.map((c) => [c.origin, c.units]), [["cart", 36], ["return", 31]]);
  assert.equal((await invoke("set_unit_cap", { unitsPerCheck: 60 }, "agent")).error.code, "wrong_actor");
  assert.equal((await invoke("set_unit_cap", { unitsPerCheck: 60 }, "merchant")).result.unitCapPerCheck, 60);
  assert.ok(end.state.activityLog.length > 30);
  assert.ok(end.state.activityLog.every((e) => typeof e.args?.photo !== "string" || e.args.photo.includes("not logged")), "no photo in the log");
});
