// The fake chat service as a handful of routes on the local server, so the two iframes of the
// offline walk (each its own JavaScript realm) can share one fake service. Used only by
// `npm start -- --fake-chat`, and never copied into the static build. Same shape as the other
// API routes: handle(method, url, body) → { status, body }.
import { ChatError } from "./transport.js";
import { FAKE_BANNER } from "./fake-transport.js";

const ok = (body = {}) => ({ status: 200, body: { ok: true, ...body } });
const fail = (status, code, message) => ({ status, body: { ok: false, error: { code, message } } });

export function createFakeChatRoutes(server) {
  const registered = new Map(); // connectionId → Set of registered message types
  const fillers = new Map(); // userId → ids of the connections the walk's panel opened

  const connectionOf = (id) => (typeof id === "string" ? server.userOf(id) : null);

  const routes = {
    "GET /api/fake-chat/config": () =>
      ok({ banner: FAKE_BANNER, maxConnections: server.maxConnections, deliveryDelayMs: server.deliveryDelayMs, seats: structuredClone(server.seats) }),

    "POST /api/fake-chat/connect": (body) => {
      const opened = server.open(body.userId, {});
      if (!opened.ok) return ok({ status: opened.status });
      registered.set(opened.connectionId, new Set(Array.isArray(body.registered) ? body.registered : []));
      return ok({ status: { state: "connected", code: null, detail: null }, connectionId: opened.connectionId });
    },

    "POST /api/fake-chat/disconnect": (body) => {
      server.close(body.connectionId);
      registered.delete(body.connectionId);
      return ok();
    },

    "POST /api/fake-chat/send": (body) => {
      const userId = connectionOf(body.connectionId);
      if (!userId) return fail(409, "chat_offline", "This connection is gone.");
      if (server.isSuspended(body.connectionId)) return fail(409, "chat_offline", "This connection is paused.");
      if (!registered.get(body.connectionId)?.has(body.type)) return fail(422, "unregistered_type", `${body.type} was not registered before connect.`);
      try {
        return ok({ message: server.record(userId, body.toUserId, body.type, body.content) });
      } catch (e) {
        if (e instanceof ChatError) return fail(e.code === "chat_offline" ? 409 : 422, e.code, e.message);
        throw e;
      }
    },

    "GET /api/fake-chat/newest": (_body, query) => {
      const userId = connectionOf(query.get("connectionId"));
      if (!userId) return fail(409, "chat_offline", "This connection is gone.");
      if (server.isSuspended(query.get("connectionId"))) return fail(409, "chat_offline", "This connection is paused.");
      try {
        const beforeTime = Number.parseInt(query.get("beforeTime") ?? "", 10);
        const before = Number.isFinite(beforeTime) ? { sentTime: beforeTime, messageId: query.get("beforeId") ?? "" } : null;
        return ok({ messages: server.newest(userId, query.get("withUserId"), Number.parseInt(query.get("limit") ?? "20", 10) || 20, before) });
      } catch (e) {
        if (e instanceof ChatError) return fail(503, e.code, e.message);
        throw e;
      }
    },

    "GET /api/fake-chat/unread": (_body, query) => {
      const userId = connectionOf(query.get("connectionId"));
      if (!userId) return fail(409, "chat_offline", "This connection is gone.");
      const peers = (query.get("peers") ?? "").split(",").filter(Boolean).slice(0, 10);
      try {
        return ok({ counts: server.unreadCounts(userId, peers) });
      } catch (e) {
        if (e instanceof ChatError) return fail(503, e.code, e.message);
        throw e;
      }
    },

    "POST /api/fake-chat/clear-unread": (body) => {
      const userId = connectionOf(body.connectionId);
      if (!userId) return fail(409, "chat_offline", "This connection is gone.");
      try {
        server.clearUnread(userId, String(body.peerUserId ?? ""), body.connectionId);
        return ok();
      } catch (e) {
        if (e instanceof ChatError) return fail(e.code === "chat_offline" ? 409 : 503, e.code, e.message);
        throw e;
      }
    },

    // What a polling client collects: the messages now due. A connection the service dropped answers gone.
    "GET /api/fake-chat/poll": (_body, query) => {
      const messages = server.drain(query.get("connectionId"));
      if (messages === null) {
        const why = server.goneStatus(query.get("connectionId"));
        const res = fail(410, "gone", why?.detail ?? "The service dropped this connection.");
        res.body.error.state = why?.state ?? "offline";
        return res;
      }
      return ok({ messages, paused: server.isSuspended(query.get("connectionId")) });
    },

    // The offline walk's panel. These switch the fake service's own failure modes on and off so the
    // pages' words for them can be seen; the agent has no route to them.
    "POST /api/fake-chat/control": (body) => {
      const userId = body.userId;
      switch (body.action) {
        case "drop":
          server.drop(userId, "the walk's panel dropped this connection");
          return ok();
        case "kick":
          server.kick(userId);
          return ok();
        case "pause":
          server.suspend(userId);
          return ok();
        case "resume":
          server.resume(userId);
          return ok();
        case "unreachable":
          server.setReachable(false);
          return ok();
        case "reachable":
          server.setReachable(true);
          return ok();
        case "fail_reads":
          server.failReads = true;
          return ok();
        case "ok_reads":
          server.failReads = false;
          return ok();
        case "fill": {
          const ids = fillers.get(userId) ?? [];
          while (server.connectionCount(userId) < server.maxConnections) {
            const opened = server.open(userId, {});
            if (!opened.ok) break;
            ids.push(opened.connectionId);
          }
          fillers.set(userId, ids);
          return ok({ connections: server.connectionCount(userId) });
        }
        case "free":
          for (const id of fillers.get(userId) ?? []) server.close(id);
          fillers.delete(userId);
          return ok({ connections: server.connectionCount(userId) });
        default:
          return fail(400, "bad_request", "Unknown control action.");
      }
    },
  };

  return {
    async handle(method, url, body = null) {
      const { pathname, searchParams } = new URL(url, "http://shade-guard.invalid");
      const route = routes[`${method} ${pathname}`];
      if (!route) return fail(404, "not_found", `No route ${method} ${pathname}.`);
      if (method === "POST" && (body === null || typeof body !== "object" || Array.isArray(body))) return fail(400, "bad_request", "The request body must be a JSON object.");
      return route(body, searchParams);
    },
  };
}
