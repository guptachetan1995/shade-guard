// The fake chat service's transport for a page: it implements the chat transport interface over
// the local server's /api/fake-chat routes, polling for delivery. It is NOT in the static build.
// baseUrl is empty in a page (same origin); tests pass the server's URL.
import { ChatError, PAGE_SIZE, STATUS } from "./transport.js";
import { fakeDescription } from "./fake-transport.js";

export const POLL_MS = 250;

export function createFakeClient({ userId, baseUrl = "", pollMs = POLL_MS }) {
  let status = Object.freeze({ state: STATUS.IDLE, code: null, detail: null });
  let connectionId = null;
  let timer = null;
  let registered = [];
  const handlers = { message: new Set(), status: new Set() };

  const set = (next) => {
    status = Object.freeze({ code: null, detail: null, ...next });
    for (const h of handlers.status) h(status);
  };

  async function call(method, path, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  function goOffline(detail, state = STATUS.OFFLINE) {
    clearTimeout(timer);
    timer = null;
    connectionId = null;
    set({ state, detail });
  }

  async function poll() {
    if (!connectionId) return;
    let r;
    try {
      r = await call("GET", `/api/fake-chat/poll?connectionId=${encodeURIComponent(connectionId)}`);
    } catch {
      return goOffline("the fake service could not be reached");
    }
    if (!r.ok) return goOffline(r.error?.code === "gone" ? r.error.message : "the fake service refused the poll", r.error?.state);
    // A paused connection reads as connecting and comes back by itself, as the SDK's suspended one does.
    if (r.paused && status.state === STATUS.CONNECTED) set({ state: STATUS.CONNECTING, detail: "the connection paused; it reconnects by itself" });
    else if (!r.paused && status.state === STATUS.CONNECTING) set({ state: STATUS.CONNECTED });
    for (const m of r.messages) for (const h of handlers.message) h(m);
    timer = setTimeout(poll, pollMs);
  }

  return {
    registerCustomMessages(registrations) {
      if (status.state !== STATUS.IDLE) throw new ChatError("register_after_connect", "Custom messages must be registered before connect.");
      for (const r of registrations) {
        if (Object.keys(r).sort().join(",") !== "isCounted,isPersisted,messageType") throw new ChatError("bad_registration", "a registration has the wrong keys");
      }
      registered = registrations.map((r) => r.messageType);
    },
    async connect() {
      if (connectionId) return status;
      set({ state: STATUS.CONNECTING });
      let r;
      try {
        r = await call("POST", "/api/fake-chat/connect", { userId, registered });
      } catch {
        set({ state: STATUS.OFFLINE, detail: "the fake service could not be reached" });
        return status;
      }
      if (!r.ok || r.status.state !== STATUS.CONNECTED) {
        set(r.ok ? r.status : { state: STATUS.OFFLINE, detail: r.error?.message ?? "refused" });
        return status;
      }
      connectionId = r.connectionId;
      set({ state: STATUS.CONNECTED });
      timer = setTimeout(poll, pollMs);
      return status;
    },
    disconnect() {
      clearTimeout(timer);
      if (connectionId) call("POST", "/api/fake-chat/disconnect", { connectionId }).catch(() => {});
      connectionId = null;
      set({ state: STATUS.IDLE });
    },
    status: () => status,
    onStatus(fn) {
      handlers.status.add(fn);
      return () => handlers.status.delete(fn);
    },
    onMessage(fn) {
      handlers.message.add(fn);
      return () => handlers.message.delete(fn);
    },
    async send({ toUserId, type, content }) {
      if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
      let r;
      try {
        r = await call("POST", "/api/fake-chat/send", { connectionId, toUserId, type, content });
      } catch {
        throw new ChatError("chat_offline", "The fake service could not be reached.");
      }
      if (!r.ok) throw new ChatError(r.error.code, r.error.message);
      return r.message;
    },
    async newest({ withUserId, limit = PAGE_SIZE, before = null }) {
      if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
      let r;
      const cursor = before ? `&beforeTime=${before.sentTime}&beforeId=${encodeURIComponent(before.messageId)}` : "";
      try {
        r = await call("GET", `/api/fake-chat/newest?connectionId=${encodeURIComponent(connectionId)}&withUserId=${encodeURIComponent(withUserId)}&limit=${limit}${cursor}`);
      } catch {
        throw new ChatError("read_failed", "The fake service could not be reached.");
      }
      if (!r.ok) throw new ChatError(r.error.code === "chat_offline" ? "chat_offline" : "read_failed", r.error.message);
      return r.messages;
    },
    async unreadCounts(peerUserIds) {
      if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
      let r;
      try {
        r = await call("GET", `/api/fake-chat/unread?connectionId=${encodeURIComponent(connectionId)}&peers=${peerUserIds.map(encodeURIComponent).join(",")}`);
      } catch {
        throw new ChatError("read_failed", "The fake service could not be reached.");
      }
      if (!r.ok) throw new ChatError(r.error.code === "chat_offline" ? "chat_offline" : "read_failed", r.error.message);
      return r.counts;
    },
    async clearUnread(peerUserId) {
      if (status.state !== STATUS.CONNECTED) throw new ChatError("chat_offline", "Not connected.");
      let r;
      try {
        r = await call("POST", "/api/fake-chat/clear-unread", { connectionId, peerUserId });
      } catch {
        throw new ChatError("chat_offline", "The fake service could not be reached.");
      }
      if (!r.ok) throw new ChatError(r.error.code === "chat_offline" ? "chat_offline" : "clear_failed", r.error.message);
    },
    describe: () => fakeDescription(userId),
  };
}
