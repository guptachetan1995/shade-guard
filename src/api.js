// Routes → invoke(). The local server and the static demo's in-browser transport both call
// handle(), so a button on the page reaches the same chokepoint either way. Every response is
// plain JSON data; the transports serialise it, so no caller ever holds a live store object.
import { runPlanner } from "./agent/planner.js";
import { merchantSummary } from "./merchant.js";
import { closeIdleChecks, settlePendingDeletes } from "./check-lifecycle.js";
import { toBase64 } from "./providers/fake-photos.js";

const ACTOR_REFUSALS = new Set(["unknown_actor", "wrong_actor"]);
// How often the server (or the static demo's tab) runs tick(): idle closes and the deletion of
// tasks that were still running at close, so a "cleanup pending" receipt settles within seconds.
export const TICK_MS = 10_000;
const INVOKE_FIELDS = ["tool", "args", "actor"];
const AGENT_FIELDS = ["checkId", "caseId"];

function bad(code, message, status = 400) {
  return { status, body: { ok: false, error: { code, message } } };
}

function statusFor(response) {
  if (response.ok) return 200;
  return ACTOR_REFUSALS.has(response.error.code) ? 403 : 422;
}

function undeclared(body, allowed) {
  return Object.keys(body).filter((k) => !allowed.includes(k));
}

export function createApi({ app, mode }) {
  const { store, invoke, listTools, provider } = app;

  const routes = {
    "GET /api/state": () => ({
      status: 200,
      body: { ok: true, mode, state: store.snapshot(), merchant: merchantSummary(store.state) },
    }),

    "GET /api/tools": () => ({ status: 200, body: { ok: true, tools: listTools() } }),

    "GET /api/activity": (_body, query) => {
      const since = Math.max(0, Number.parseInt(query.get("since") ?? "0", 10) || 0);
      const log = store.state.activityLog;
      return { status: 200, body: { ok: true, total: log.length, entries: structuredClone(log.slice(since)) } };
    },

    // The actor is whatever the caller names. It is not authentication: the gate stops the
    // agent's code paths (the planner pins "agent") from reaching a human verb.
    "POST /api/invoke": async (body) => {
      const extra = undeclared(body, INVOKE_FIELDS);
      if (extra.length) return bad("bad_request", `/api/invoke takes tool, args and actor, not ${extra.join(", ")}.`);
      const response = await invoke(body.tool, body.args, body.actor);
      return { status: statusFor(response), body: response };
    },

    // Runs the deterministic planner, which calls invoke() with actor "agent" pinned in code.
    // The route takes no actor, so nothing can run the planner as anyone else.
    "POST /api/agent": async (body) => {
      if (Object.hasOwn(body, "actor")) return bad("actor_pinned", "The agent's actor is pinned to agent in code; this route takes no actor.");
      const extra = undeclared(body, AGENT_FIELDS);
      if (extra.length) return bad("bad_request", `/api/agent takes checkId and caseId, not ${extra.join(", ")}.`);
      const { checkId = null, caseId = null } = body;
      if (!checkId && !caseId) return bad("bad_request", "/api/agent needs a checkId, a caseId, or both.");
      const { plan, transcript } = await runPlanner(invoke, { checkId, caseId });
      return { status: 200, body: { ok: true, outcome: plan.outcome ?? plan.phase, transcript } };
    },

    // A cached try-on render of an open check. Renders are dropped when the check closes.
    "GET /api/preview": (_body, query) => {
      const renders = store.blobs.get(query.get("checkId"))?.renders;
      const image = renders?.get(query.get("previewId"));
      if (!image) return bad("preview_gone", "That preview doesn't exist, or its check has closed and the render was deleted.", 404);
      return { status: 200, body: { ok: true, contentType: image.contentType, base64: toBase64(image.bytes), synthetic: mode.id === "fake", replay: mode.id === "replay" } };
    },

    // The recorded sample shopper's photo, which is the one photo replay can answer for. Only
    // the replay provider has one; the shopper still starts the check with it themselves.
    "GET /api/sample-photo": () => {
      const photo = provider.samplePhoto?.();
      if (!photo) return bad("no_sample_photo", "Only replay mode has a recorded sample shopper.", 404);
      return { status: 200, body: { ok: true, contentType: photo.contentType, base64: toBase64(photo.bytes), recordedAt: photo.recordedAt } };
    },
  };

  async function handle(method, url, body = null) {
    const { pathname, searchParams } = new URL(url, "http://shade-guard.invalid");
    const route = routes[`${method} ${pathname}`];
    if (!route) return bad("not_found", `No route ${method} ${pathname}.`, 404);
    if (method === "POST" && (body === null || typeof body !== "object" || Array.isArray(body))) {
      return bad("bad_request", "The request body must be a JSON object.");
    }
    return route(body, searchParams);
  }

  // Close-on-idle and the deletion of tasks that were still running at close: policy, not verbs.
  async function tick(nowMs = Date.now()) {
    await closeIdleChecks(store, provider, nowMs);
    await settlePendingDeletes(store, provider);
  }

  return { handle, tick };
}
