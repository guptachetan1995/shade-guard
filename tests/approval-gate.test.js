import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS, listTools } from "../src/tools.js";
import { HUMAN_VERBS } from "../src/human-verbs.js";
import { AGENT } from "../src/agent/planner.js";
import { makeApp, photo, startCartCheck } from "./helpers.js";
import { runPlanner } from "../src/agent/planner.js";

const AGENT_TOOLS = [
  "get_cart",
  "list_shades",
  "measure_complexion",
  "rank_shades",
  "preview_shade",
  "draft_recommendation",
  "list_return_cases",
  "draft_return_resolution",
  "get_unit_budget",
];
const VERBS = { start_check: "shopper", apply_draft: "shopper", keep_my_shade: "shopper", approve_exchange: "staff", approve_refund: "staff", set_unit_cap: "merchant", stop_waiting: "shopper" };

test("the registry holds exactly the nine agent tools, and tool discovery lists only them", () => {
  assert.deepEqual(TOOLS.map((t) => t.name), AGENT_TOOLS);
  assert.deepEqual(listTools().map((t) => t.name), AGENT_TOOLS);
});

test("the seven human verbs are absent from the registry and from tool discovery", () => {
  assert.deepEqual(Object.fromEntries(HUMAN_VERBS.map((v) => [v.name, v.actor])), VERBS);
  const registered = new Set(TOOLS.map((t) => t.name));
  const discovered = new Set(listTools().map((t) => t.name));
  for (const name of Object.keys(VERBS)) {
    assert.equal(registered.has(name), false, `${name} is registered`);
    assert.equal(discovered.has(name), false, `${name} appears in tool discovery`);
  }
});

test("tools.js never imports the human verbs", () => {
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from\s+["'][^"']*human-verbs/);
  const planner = readFileSync(new URL("../src/agent/planner.js", import.meta.url), "utf8");
  assert.doesNotMatch(planner, /from\s+["'][^"']*(human-verbs|store|invoke|tools)(\.js)?["']/, "the planner reaches the store only through invoke");
});

test("every human verb refuses the agent, even when called directly, and changes nothing", async () => {
  const app = await makeApp();
  const checkId = await startCartCheck(app);
  await runPlanner(app.invoke, { checkId });
  const before = structuredClone({ cart: app.store.state.cart, cases: app.store.state.returnCases, budget: app.store.state.budget, checks: app.store.state.checks });
  const calls = {
    start_check: { photo: photo(), capture: "upload" },
    apply_draft: { checkId, lineId: "L1" },
    keep_my_shade: { checkId, lineId: "L2" },
    approve_exchange: { caseId: "R-104" },
    approve_refund: { caseId: "R-104" },
    set_unit_cap: { unitsPerCheck: 1000 },
    stop_waiting: { checkId },
  };
  for (const [verb, args] of Object.entries(calls)) {
    const r = await app.invoke(verb, args, AGENT);
    assert.equal(r.ok, false, verb);
    assert.equal(r.error.code, "wrong_actor", verb);
    assert.match(r.error.message, /the agent never calls a human verb/);
  }
  assert.deepEqual(
    { cart: app.store.state.cart, cases: app.store.state.returnCases, budget: app.store.state.budget, checks: app.store.state.checks },
    before,
  );
});

test("the planner's actor is pinned to agent in code", () => {
  assert.equal(AGENT, "agent");
  const planner = readFileSync(new URL("../src/agent/planner.js", import.meta.url), "utf8");
  assert.match(planner, /await invoke\(call\.tool, call\.args, AGENT\)/);
});

test("every tool description says what it does NOT do, and every argument is described", () => {
  for (const t of listTools()) {
    assert.match(t.description, /Does NOT/, t.name);
    assert.ok(t.description.length > 120, `${t.name} description is too thin to use without the screen`);
    for (const [arg, spec] of Object.entries(t.args)) assert.ok(spec.description, `${t.name}.${arg} has no description`);
  }
});
