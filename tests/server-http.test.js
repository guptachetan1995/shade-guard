import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer, HOST } from "../src/server.js";
import { describeMode } from "../src/modes.js";
import { makeApp, photo } from "./helpers.js";

let srv;
let app;

before(async () => {
  app = await makeApp();
  srv = await startServer({ app, mode: describeMode("fake") });
});
after(() => srv.close());

async function call(method, path, body) {
  const res = await fetch(srv.url + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") ? await res.json() : await res.text(), headers: res.headers };
}

const invoke = (tool, args, actor) => call("POST", "/api/invoke", actor === undefined ? { tool, args } : { tool, args, actor });
const lastLog = () => app.store.state.activityLog.at(-1);

test("the server listens on 127.0.0.1 only", () => {
  assert.equal(srv.server.address().address, HOST);
  assert.equal(HOST, "127.0.0.1");
});

test("a missing actor is refused by the chokepoint, and the refusal is logged", async () => {
  const r = await invoke("get_cart", {});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "unknown_actor");
  assert.match(r.body.error.message, /No actor was named/);
  assert.deepEqual([lastLog().tool, lastLog().result, lastLog().code], ["get_cart", "refused", "unknown_actor"]);
});

test("an unknown actor is refused", async () => {
  const r = await invoke("get_cart", {}, "robot");
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "unknown_actor");
});

test("a wrong-role actor is refused: a shopper can't approve a refund, the agent can't apply a draft", async () => {
  const refund = await invoke("approve_refund", { caseId: "R-107" }, "shopper");
  assert.equal(refund.status, 403);
  assert.equal(refund.body.error.code, "wrong_actor");
  const apply = await invoke("apply_draft", { checkId: "chk_01", lineId: "L1" }, "agent");
  assert.equal(apply.status, 403);
  assert.equal(apply.body.error.code, "wrong_actor");
  assert.match(apply.body.error.message, /the agent never calls a human verb/);
  assert.equal(app.store.getCase("R-107").status, "awaiting_check", "nothing changed");
});

test("tool discovery over HTTP lists the nine agent tools and no human verb", async () => {
  const r = await call("GET", "/api/tools");
  assert.equal(r.status, 200);
  const names = r.body.tools.map((t) => t.name);
  assert.equal(names.length, 9);
  for (const verb of ["start_check", "apply_draft", "keep_my_shade", "approve_exchange", "approve_refund", "set_unit_cap"]) {
    assert.equal(names.includes(verb), false, verb);
  }
});

test("a smuggled cart field is refused and logged, and an undeclared body field is a bad request", async () => {
  const r = await invoke("draft_recommendation", { checkId: "chk_01", lineId: "L1", decision: "swap", evidence: {}, cart: { lines: [] } }, "agent");
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "smuggled_field");
  assert.deepEqual(lastLog().fields, ["cart"]);
  const extra = await call("POST", "/api/invoke", { tool: "get_cart", args: {}, actor: "agent", as: "shopper" });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.error.code, "bad_request");
});

test("the agent route takes no actor: the planner's actor is pinned in code", async () => {
  const r = await call("POST", "/api/agent", { caseId: "R-104", actor: "staff" });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "actor_pinned");
});

test("the demo story over a real socket: shopper starts, agent drafts, shopper swaps; the cart changes only then", async () => {
  const s = await invoke("start_check", { photo: photo(), capture: "upload" }, "shopper");
  assert.equal(s.status, 200);
  const { checkId } = s.body.result;
  const run = await call("POST", "/api/agent", { checkId });
  assert.equal(run.status, 200);
  assert.equal(run.body.outcome, "drafted");
  assert.ok(run.body.transcript.every((t) => t.ok));
  const state = (await call("GET", "/api/state")).body;
  assert.equal(state.mode.id, "fake");
  assert.equal(state.mode.label, "Sample data, not YouCam");
  const check = state.state.checks.find((c) => c.checkId === checkId);
  assert.deepEqual(Object.values(check.lines).map((l) => l.draft.decision), ["swap", "sample_duo", "no_match"]);
  assert.equal(state.state.cart.lines[0].shadeCode, "220N", "drafts change nothing");
  const preview = await call("GET", `/api/preview?checkId=${checkId}&previewId=${check.lines.L1.previews[0].previewId}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.synthetic, true);
  const swap = await invoke("apply_draft", { checkId, lineId: "L1" }, "shopper");
  assert.equal(swap.status, 200);
  assert.equal(swap.body.result.cart.lines[0].shadeCode, "245W");
  const activity = (await call("GET", "/api/activity?since=0")).body;
  assert.ok(activity.entries.some((e) => e.tool === "apply_draft" && e.actor === "shopper" && e.result === "ok"));
  assert.ok(activity.entries.every((e) => typeof e.args?.photo !== "string" || e.args.photo.includes("not logged")), "the photo is never logged");
});

test("a request body over 2 MB is refused before it is parsed", async () => {
  const r = await call("POST", "/api/invoke", JSON.stringify({ tool: "start_check", args: { photo: "A".repeat(2 * 1024 * 1024 + 10), capture: "upload" }, actor: "shopper" }));
  assert.equal(r.status, 413);
});

test("a request naming another host is refused", async () => {
  const { port } = srv.server.address();
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path: "/api/state", headers: { host: "attacker.invalid" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

test("the page and its browser modules are served; the env reader and the server are not", async () => {
  assert.equal((await call("GET", "/src/api.js")).status, 200);
  assert.equal((await call("GET", "/src/config.js")).status, 404);
  assert.equal((await call("GET", "/src/server.js")).status, 404);
  assert.equal((await call("GET", "/public/../src/config.js")).status, 404);
  assert.equal((await call("GET", "/package.json")).status, 404);
  const page = await call("GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
});
